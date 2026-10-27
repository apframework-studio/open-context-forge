# Automatic Vault Maintenance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a source is filed into an opted-in vault, run `open-context-forge-vault-maintainer` through one durable, serial CLI queue and automatically write verified knowledge notes when the decision is `compile_now`.

**Architecture:** Extend the existing `AnalysisJobs` worker into one source-task scheduler, so manual analysis and automatic maintenance cannot run simultaneously. A new compiler loads the configured skill, prepares bounded source and related-note context, requests structured analysis/plan/file operations from the CLI, and uses a constrained writer to apply only safe changes to the selected vault. Persist stages and expose policy/job state to the UI.

**Tech Stack:** Node 22, TypeScript, Fastify, better-sqlite3, Vitest, React, the existing maintainer CLI and Claude CLI adapter.

**Spec:** `docs/superpowers/specs/2026-10-27-automatic-vault-maintenance-design.md`

## Global Constraints

- Per-vault automatic maintenance is opt-in and defaults off.
- One source-processing CLI call may run at a time across manual analysis and maintenance jobs; article conversations remain separate.
- The vault root comes from `VaultRegistry`, never from request-controlled paths or source text.
- Source bytes and the manifest must match the queued fingerprint before any writes. Raw snapshots are immutable.
- `defer`, `keep_raw_only` and `ask_user` never write wiki notes.
- Existing user notes can be changed only when their base hash still matches; new paths must not exist.
- The worker records restart and partial-write states, does not silently overwrite user edits, and never pushes Git.
- Preserve all pre-existing unstaged work in this checkout. Do not stage unrelated files.
- Run tests with Node 22.22.1 from `.nvmrc`; the installed `better-sqlite3` binary uses ABI 127 and fails under the host's default Node 26.

## File map

| File | Responsibility |
| --- | --- |
| `apps/server/src/vaults/registry.ts` | Per-vault policy storage and read/write API support |
| `apps/server/src/import/filing.ts` | Register maintenance job with successful vault membership |
| `apps/server/src/analysis/jobs.ts` | One durable serial scheduler for `analysis_only` and `maintain` |
| `apps/server/src/analysis/maintenance.ts` | Load skill, bounded context, invoke one configured CLI persona by stage |
| `apps/server/src/analysis/maintenance-writer.ts` | Verify paths, source and base hashes; apply plans and run checks |
| `apps/server/src/analysis/routes.ts`, `apps/server/src/vaults/routes.ts`, `apps/server/src/app.ts` | Policy, task and retry endpoints; service wiring |
| `apps/web/src/api.ts`, `apps/web/src/screens/ImportScreen.tsx`, `apps/web/src/screens/VaultSettingsScreen.tsx` | Types, job progress, retry/backfill and per-vault toggle |
| Adjacent `*.test.ts` and `apps/web/e2e/*` | Durable queue, safety and user flow verification |

### Task 1: Per-vault opt-in policy and durable enqueue

**Files:** Modify `apps/server/src/vaults/registry.ts`, `apps/server/src/import/filing.ts`, `apps/server/src/app.ts`, `apps/server/src/analysis/jobs.ts`, `apps/server/src/vaults/routes.ts`; test `apps/server/src/import/workbench.test.ts` and `apps/server/src/analysis/jobs.test.ts`.

**Interfaces:** `VaultRegistry.maintenancePolicy(vaultId): {enabled:boolean}` and `.setMaintenancePolicy(vaultId, enabled)`; `AnalysisJobs.enqueueMaintenance({batchId,captureId,vaultId,snapshot,fingerprint})`; `fileCapture(..., {automatic?, enqueueMaintenance?})`.

- [ ] **Step 1: Write failing tests.** Create a default vault and an external vault, enable only the first, file the same capture to both, then assert exactly one `maintain` job. Cover auto filing, duplicate filing, and restart persistence. Assert `PUT /vaults/:id/maintenance-policy` rejects non-boolean values.
- [ ] **Step 2: Run focused tests and confirm red.** `npm test --workspace @ocf/server -- --run src/import/workbench.test.ts src/analysis/jobs.test.ts` must fail at the new assertions.
- [ ] **Step 3: Add the `auto_maintain` column, policy routes, and queue fields.** Rebuild `analysis_jobs` transactionally because its current SQLite `status` CHECK accepts only four states; copy old rows with `mode='analysis_only'`, then add `vault_id`, `fingerprint`, `snapshot`, `stage`, `attempt`, `result_json` and an active idempotency index. Enqueue in the same transaction as successful `import_item_vaults` insert; schedule only after commit. Repeated memberships must not schedule a duplicate.

  ```sql
  ALTER TABLE vaults ADD COLUMN auto_maintain INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE analysis_jobs_next (
    id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, capture_id TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'analysis_only', vault_id TEXT, fingerprint TEXT, snapshot TEXT,
    status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','skipped','needs_attention','blocked','cancelled')),
    stage TEXT NOT NULL DEFAULT 'analyze', attempt INTEGER NOT NULL DEFAULT 1,
    error_code TEXT, result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    FOREIGN KEY(batch_id,capture_id) REFERENCES import_items(batch_id,capture_id)
  );
  INSERT INTO analysis_jobs_next(id,batch_id,capture_id,status,error_code,created_at,updated_at)
    SELECT id,batch_id,capture_id,status,error_code,created_at,updated_at FROM analysis_jobs;
  DROP TABLE analysis_jobs;
  ALTER TABLE analysis_jobs_next RENAME TO analysis_jobs;
  CREATE UNIQUE INDEX analysis_active_maintenance ON analysis_jobs(vault_id, fingerprint)
    WHERE mode = 'maintain' AND status IN ('queued', 'running', 'blocked');
  ```
- [ ] **Step 4: Run the focused tests and typecheck.** `npm test --workspace @ocf/server -- --run src/import/workbench.test.ts src/analysis/jobs.test.ts`; `npm run typecheck --workspace @ocf/server`.
- [ ] **Step 5: Review only this task's diff.** Check that pre-existing changes in these files are preserved and no other source is staged.

### Task 2: Source skill execution and structured results

**Files:** Create `apps/server/src/analysis/maintenance.ts`, `apps/server/src/analysis/maintenance.test.ts`; modify `apps/server/src/analysis/jobs.ts` and `apps/server/src/agents/runner.ts` only to support a bounded per-stage timeout.

**Interfaces:** `MaintenanceCompiler.run(job, onStage): Promise<MaintenanceResult>` where `MaintenanceResult` contains the source fingerprint, `recommendation`, analysis Markdown, plan Markdown, and proposed `FileChange[]`; `FileChange` is `{action:'create'|'update',path:string,baseHash:string|null,content:string,evidenceIds:string[]}`.

- [ ] **Step 1: Write failing mocked-runner tests.** Check that `SKILL.md`, `references/ingest-workflow.md`, and `references/note-writing.md` are loaded from `maintainerRoot`; the prompt includes the selected vault profile, source lines, and bounded candidate notes. Test an invalid JSON response, wrong fingerprint, missing evidence, and each skip recommendation.
- [ ] **Step 2: Run red tests.** `npm test --workspace @ocf/server -- --run src/analysis/maintenance.test.ts`.
- [ ] **Step 3: Implement the three semantic stages.** Use maintainer `source-context.js` and `vault-query.js` via `runTool` for deterministic inputs. First create an evidence-indexed analysis card, then a plan, then structured file changes. Reuse the same CLI profile and stage output; never grant shell write tools to the model. Validate each response against explicit bounds and the source fingerprint before advancing.

  ```ts
  interface FileChange {
    action: "create" | "update";
    path: string;
    baseHash: string | null;
    content: string;
    evidenceIds: string[];
  }
  interface MaintenanceResult {
    fingerprint: string;
    recommendation: "compile_now" | "defer" | "keep_raw_only" | "ask_user";
    analysisMarkdown: string;
    planMarkdown: string;
    changes: FileChange[];
  }
  // Stage prompts require JSON with these exact fields; parse unknown input and reject missing fields.
  ```
- [ ] **Step 4: Persist process artifacts and platform card projection.** Store `analysis.md` and `plan.md` in `.ocf/compilations/<fingerprint>/` without overwriting pre-existing files; update the source-analysis projection used by `ImportScreen` only after validating line evidence. Do not create wiki notes for skip outcomes.
- [ ] **Step 5: Run focused tests and typecheck.** Repeat the test command, then `npm run typecheck --workspace @ocf/server`.

### Task 3: Constrained, recoverable wiki writer

**Files:** Create `apps/server/src/analysis/maintenance-writer.ts`, `apps/server/src/analysis/maintenance-writer.test.ts`; modify `apps/server/src/analysis/jobs.ts` and `apps/server/src/vaults/knowledge-index.ts` for result and refresh hooks.

**Interfaces:** `applyMaintenanceChanges(vault, fingerprint, changes, maintainerRoot): Promise<{files:string[],warnings:string[]}>`; consumes `FileChange[]` from Task 2 and returns the exact paths written.

- [ ] **Step 1: Write failing safety tests.** Reject `../`, absolute paths, symlink hops, raw paths, stale base hashes, missing source spans, and duplicate create targets. Verify a valid new source summary and framework are written, index/log are updated only within allowed paths, and no unrelated file changes.
- [ ] **Step 2: Run red tests.** `npm test --workspace @ocf/server -- --run src/analysis/maintenance-writer.test.ts`.
- [ ] **Step 3: Implement preflight and file journal.** Resolve every target under the selected vault, verify profile and manifest, compare current bytes to `baseHash`, validate source evidence and links, and save a journal of proposed paths/hashes before writes. Write temp files and atomically rename one by one; on partial failure mark `needs_attention` and keep the journal for inspection.

  ```ts
  class MaintenanceError extends Error {
    constructor(readonly code: string) { super(code); }
  }
  const root = await realpath(vault.path);
  const target = resolve(root, change.path);
  if (target === root || !target.startsWith(`${root}${sep}`)) throw new MaintenanceError("INVALID_TARGET");
  // Check every existing parent with realpath before creating a temporary sibling file.
  // For updates: sha256(await readFile(target)) must equal change.baseHash.
  // For creates: target must be absent and its parent must resolve inside root.
  ```
- [ ] **Step 4: Add targeted validation.** Run `check-notes.js --note <path>` on each changed wiki note, then `check-vault.js`. Compare pre/post full-vault diagnostics, reject new issues, preserve existing warnings in the job result, and refresh the knowledge index after success.
- [ ] **Step 5: Run focused tests and typecheck.** Repeat the test command, then `npm run typecheck --workspace @ocf/server`.

### Task 4: Unified serial worker, restart and retry

**Files:** Modify `apps/server/src/analysis/jobs.ts`, `apps/server/src/analysis/routes.ts`, `apps/server/src/app.ts`, `apps/server/src/analysis/jobs.test.ts`; create `apps/server/src/analysis/maintenance-jobs.test.ts`.

**Interfaces:** `AnalysisJobs` remains the only source CLI worker; adds `listMaintenance`, `retryMaintenance`, `enqueueMaintenance`, and stage/status transitions. Existing `enqueue` and `list` continue to serve analysis-only UI.

- [ ] **Step 1: Write failing queue tests.** Hold the first mocked CLI call, enqueue manual analysis and two maintenance tasks, assert max active calls is 1. Restart with queued/running/writing jobs and assert safe resume or `needs_attention`; verify one failed task does not block the next and retries increment attempt count.
- [ ] **Step 2: Run red tests.** `npm test --workspace @ocf/server -- --run src/analysis/jobs.test.ts src/analysis/maintenance-jobs.test.ts`.
- [ ] **Step 3: Wire the compiler/writer into the single worker.** Persist stage before each call; route `analysis_only` to existing `AnalysisService`, `maintain` to Tasks 2–3; return clear statuses (`queued`, `running`, `completed`, `skipped`, `failed`, `needs_attention`, `blocked`) and error codes. On restart, inspect journal before reenqueuing a writing-stage task.

  ```ts
  const row = db.prepare("SELECT * FROM analysis_jobs WHERE status = 'queued' ORDER BY rowid LIMIT 1").get();
  if (!row) return;
  if (row.mode === "analysis_only") await analysis.proposeCapture(row.batch_id, row.capture_id, "claude-current");
  else await compiler.run(row, (stage) => saveStage(row.id, stage));
  // startNext() is called only after the current promise settles: one source CLI pipeline at a time.
  ```
- [ ] **Step 4: Expose maintenance list, backfill and retry endpoints.** Validate membership and vault policy for automatic jobs; manual backfill may run on any selected vault. The API returns the existing active task on duplicate request and never accepts a client-supplied filesystem root.
- [ ] **Step 5: Run focused tests and typecheck.** Repeat the test command, then `npm run typecheck --workspace @ocf/server`.

### Task 5: Settings and source-workbench status

**Files:** Modify `apps/web/src/api.ts`, `apps/web/src/screens/VaultSettingsScreen.tsx`, `apps/web/src/screens/ImportScreen.tsx`; test `apps/web/e2e/source-workbench.spec.ts` and `apps/web/e2e/knowledge-workspace.spec.ts`.

**Interfaces:** UI consumes the policy and maintenance job APIs from Tasks 1 and 4; it does not infer success from the mere presence of raw or a reader card.

- [ ] **Step 1: Write failing UI tests.** Assert a vault toggle defaults off and persists; filing into an enabled vault shows queued/running/completed status and written note links; a failed job exposes retry; manual analysis still works.
- [ ] **Step 2: Run red tests.** `npm test --workspace @ocf/web -- --run` for component tests and the focused Playwright specs via `npm run test:e2e --workspace @ocf/web -- --grep 'maintenance'`.
- [ ] **Step 3: Implement policy and status controls.** Add a per-vault toggle with direct-write explanation, read maintenance jobs on the source page, poll only while active, link results to knowledge notes, and offer explicit backfill/retry buttons. Keep source lists usable if the CLI is unavailable.

  ```tsx
  <label>
    <input type="checkbox" checked={policy.enabled}
      onChange={(event) => void saveMaintenancePolicy(vault.id, event.currentTarget.checked)} />
    入库后自动维护（分析结论为 compile_now 时直接写入知识笔记）
  </label>
  ```
- [ ] **Step 4: Run focused UI tests and typecheck.** `npm run typecheck --workspace @ocf/web`; focused Playwright specs.

### Task 6: End-to-end verification and documentation

**Files:** Modify `README.md` and the current design/spec notes only where behavior changed; test all touched server and web packages.

- [ ] **Step 1: Run server and web test suites.** `npm test --workspace @ocf/server`; `npm test --workspace @ocf/web`; `npm run typecheck --workspace @ocf/server`; `npm run typecheck --workspace @ocf/web`.
- [ ] **Step 2: Run focused E2E and real maintainer validation.** Use a temporary vault fixture and mocked CLI for deterministic pipeline tests; run maintainer `check-notes.js` and `check-vault.js` on the fixture. No test touches the user's live vault.
- [ ] **Step 3: Inspect diff and status.** `git diff --check`, `git status --short`, and `git diff -- <touched files>`; explicitly compare against the pre-existing dirty status. Stage only files belonging to this feature if committing is appropriate.
- [ ] **Step 4: Report evidence.** List the exact tests passed, any pre-existing failures, remaining operational limitations, and whether a commit was made. Never claim automatic wiki maintenance works without the full enqueue → serial agent → file write → validation test passing.
