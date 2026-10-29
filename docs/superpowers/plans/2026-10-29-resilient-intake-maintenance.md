# Reliable Source Intake and Vault Maintenance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept sources immediately, file them through a recoverable queue, maintain each enabled vault with one serial Claude CLI process, and surface authorship and stuck work for correction.

**Architecture:** Keep four domain modules: source intake owns parsing and metadata, filing owns raw snapshot jobs and stable source identity, maintenance owns Claude execution and wiki writes, and attention owns unresolved work and reminders. HTTP routes only validate and call those services. Filing and maintenance have separate lanes; a verified `import_item_vaults` row is the handoff contract.

**Tech Stack:** Node.js >=22.12, TypeScript, Fastify, better-sqlite3, React, Vitest, Playwright, vault-maintainer Node CLI.

**Spec:** `docs/superpowers/specs/2026-10-28-resilient-source-intake-and-attribution-design.md`

## Global Constraints

- Work in the current checkout as explicitly requested. Preserve all pre-existing modified and untracked files; stage only intended changes.
- Existing installations retain their saved manual or auto-file policy. New databases start with auto-file to the built-in default vault. Per-vault auto-maintenance remains off by default.
- Raw CLI execution has a 60,000 ms deadline. Each Claude stage has a 600,000 ms deadline; at most one source Claude process exists at a time.
- A timed-out process must exit before its lane is released. If exit cannot be confirmed, pause the lane and expose an attention item.
- Read-only failures retry at 1 minute and 10 minutes, then need attention. Uncertain raw/wiki writes require reconciliation before retry.
- `author` and `authorship` are separate. URLs, filenames and bylines do not establish `third_party` ownership. Initial default authorship is `unknown`.
- `source_key` uses SHA-256 of kind, NUL, normalized origin, NUL and content hash. Raw file hash is never the repeat-push key.
- `ask_user` needs attention; `defer` and `keep_raw_only` are normal skipped outcomes.
- HTTP filing endpoints return 202 with job IDs. The web client must not label queued work as imported.

## Module ownership and interfaces

| Module | Owns | Does not own | Interface |
| --- | --- | --- | --- |
| `import/metadata.ts`, `import/local-files.ts`, `import/clipper-zip.ts` | candidate author evidence and authorship override | vault manifest mutation | `CaptureCandidate` and `SourceMetadata` |
| `import/filing-jobs.ts`, `import/source-identity.ts`, `import/filing.ts` | durable filing state, source key, raw reconciliation | Claude prompts or UI | `enqueueFiling`, `listFiling`, `retryFiling`, `cancelFiling` |
| `analysis/jobs.ts`, `analysis/maintenance.ts`, `agents/runner.ts` | serial CLI stage, retries, wiki write result | receiving/uploading files | verified `(vaultId,snapshot,fingerprint)` |
| `attention/service.ts`, `attention/routes.ts`, web `AttentionCenter.tsx` | unresolved task projection, reminder state | job execution or manifest changes | `AttentionSummary`, task actions through owner modules |

The four modules form one vertical workflow. Tasks below leave usable behavior at every checkpoint and preserve the existing article writing and publication paths.

### Task 1: Source identity and provenance model

**Files:** Create `apps/server/src/import/source-identity.ts`, `apps/server/src/import/source-identity.test.ts`, `apps/server/src/import/metadata.ts`, `apps/server/src/import/metadata.test.ts`; modify `packages/contracts/src/index.ts`, `apps/server/src/import/local-files.ts`, `apps/server/src/import/clipper-zip.ts`, `apps/server/src/state/db.ts`.

**Interfaces:** `sourceKey(candidate: CaptureCandidate): string`; `extractLocalAuthor(text: string, kind: "markdown" | "html"): AuthorEvidence | null`; `CaptureCandidate` gains optional `authorEvidence`, `authorship`, `authorshipOverridden`.

- [ ] **Step 1: Write failing parser and identity tests.** Cover repeat local uploads with different timestamps, URL fragment removal with query retention, frontmatter `author/authors`, HTML meta/JSON-LD before head removal, near-title byline and conflicting bylines. Use actual short source strings and assert value plus evidence kind.
  ```ts
  expect(sourceKey({ ...candidate, capturedAt: "A" })).toBe(sourceKey({ ...candidate, capturedAt: "B" }));
  expect(extractLocalAuthor("---\nauthor: Ada\n---\n# T", "markdown"))
    .toMatchObject({ value: "Ada", kind: "frontmatter" });
  ```
- [ ] **Step 2: Run focused tests and confirm failure.** `npm exec --workspace apps/server vitest -- run src/import/source-identity.test.ts src/import/metadata.test.ts` must fail on missing exports.
- [ ] **Step 3: Implement deterministic bounded parsers and source key.** Normalize local filename with NFC and slash replacement; URL with `new URL()`, empty fragment and preserved search. Hash `kind + "\0" + origin + "\0" + contentHash`. Reject ambiguous author evidence rather than guessing.
  ```ts
  export type AuthorEvidence = { value: string; kind: "clipper" | "frontmatter" | "html_meta" | "json_ld" | "byline"; location: string };
  export function sourceKey(candidate: CaptureCandidate): string {
    const kind = candidate.originalUrl ? "clipper" : "local";
    const origin = candidate.originalUrl
      ? (() => { const url = new URL(candidate.originalUrl); url.hash = ""; return url.href; })()
      : candidate.sourceFilename!.replaceAll("\\", "/").normalize("NFC");
    return createHash("sha256").update(`${kind}\0${origin}\0${candidate.contentHash}`).digest("hex");
  }
  ```
- [ ] **Step 4: Wire parser results to candidates and add database columns.** `import_items` stores `source_key`, `author_evidence_json`, `authorship`, `authorship_overridden`; `import_policy` stores `default_authorship TEXT NOT NULL DEFAULT 'unknown'`. Existing rows remain readable. Change `importSnapshot` later in Task 4 to consume these values; do not infer from URL here.
- [ ] **Step 5: Run parser and migration tests, then typecheck.** `npm run typecheck --workspaces --if-present`; commit only these files with `feat: model stable source identity and author evidence` if all staged hunks belong to this task.

### Task 2: Durable raw filing queue

**Files:** Create `apps/server/src/import/filing-jobs.ts`, `apps/server/src/import/filing-jobs.test.ts`, `apps/server/src/import/filing-routes.ts`; modify `apps/server/src/import/filing.ts`, `apps/server/src/import/routes.ts`, `apps/server/src/vaults/routes.ts`, `apps/server/src/app.ts`, `apps/server/src/state/db.ts`, `apps/server/src/import/workbench.test.ts`.

**Interfaces:** `FilingJobs.enqueue(batchId,captureId,vaultId,automatic?): FilingJob`; `FilingJobs.list(vaultId?): FilingJob[]`; `retry(id)`, `cancel(id)`, `wake()`, `resume()`, `stop()`; constructor accepts `importer: typeof importSnapshot` for controlled tests; completed filing calls `AnalysisJobs.recordFiled` only for enabled vaults.

- [ ] **Step 1: Write failing queue tests.** POST preflight returns before raw CLI finishes; auto-file and manual commit both create one job per item/vault; second vault gets its own job; cancel only queued/retry_wait; restart recovers queued work. Stub the raw importer with a deferred promise so HTTP latency and queue state are observable.
  ```ts
  const accepted = await app.inject({ method: "POST", url: `/api/v1/imports/${batchId}/items/${captureId}/commit`, headers, payload: { vaultId: "default" } });
  expect(accepted.statusCode).toBe(202);
  expect(accepted.json().job.status).toBe("queued");
  ```
- [ ] **Step 2: Run focused queue tests and confirm failure.** `npm exec --workspace apps/server vitest -- run src/import/filing-jobs.test.ts src/import/workbench.test.ts`.
- [ ] **Step 3: Add `filing_jobs` table and small repository methods.** Unique `(batch_id,capture_id,vault_id)`; statuses `queued/running/retry_wait/completed/needs_attention/cancelled`; run token, stage deadline, attempt, next retry, error and result. Queue claims use a conditional SQLite update, and every completion checks its token.
  ```ts
  type FilingStatus = "queued" | "running" | "retry_wait" | "completed" | "needs_attention" | "cancelled";
  type FilingJob = { id: string; batchId: string; captureId: string; vaultId: string; status: FilingStatus; stage: string; attempt: number; nextRetryAt: string | null };
  ```
- [ ] **Step 4: Move work out of HTTP routes.** `filing-routes.ts` validates `POST /commit`, `GET /imports/filing-jobs`, `POST /:id/retry`, `POST /:id/cancel`, and returns 202 for accepted work. `PUT /imports/:batchId/items/:captureId/vaults` returns 202 plus queued jobs and existing memberships. Replace ad hoc `processAuto` scanner with `FilingJobs.resume/wake`; update item list to project filing state rather than treating `processing` as a global item lock.
- [ ] **Step 5: Verify queue behavior and server typecheck.** Run focused tests and `npm run typecheck --workspace apps/server`. Do not stage unrelated pre-existing edits.

### Task 3: Stable snapshot reuse and raw reconciliation

**Files:** Modify `apps/server/src/import/source-identity.ts`, `apps/server/src/import/filing.ts`, `apps/server/src/import/filing-jobs.ts`, `apps/server/src/state/db.ts`; create `apps/server/src/import/filing-recovery.ts`, `apps/server/src/import/filing-recovery.test.ts`.

**Interfaces:** `verifiedSnapshot(vaultPath,snapshot,fingerprint): Promise<boolean>`; `reconcileFiling(job): Promise<"completed" | "retryable" | "needs_attention">`.

- [ ] **Step 1: Write failing reuse and restart tests.** Identical local file with a new receive time reuses the same verified snapshot and maintenance job; a second vault has a separate key mapping; a crashed write with valid manifest is completed on restart; unknown manifest/lock state needs attention. Assert raw bytes are not rewritten during reuse.
  ```ts
  expect(second.snapshot).toBe(first.snapshot);
  expect(second.fingerprint).toBe(first.fingerprint);
  expect(rawBytesAfter).toEqual(rawBytesBefore);
  ```
- [ ] **Step 2: Run focused tests and confirm failure.** `npm exec --workspace apps/server vitest -- run src/import/filing-recovery.test.ts`.
- [ ] **Step 3: Add `vault_source_keys` mapping.** Unique `(vault_id,source_key)` points to verified snapshot/fingerprint. File completion writes mapping, membership and optional analysis job in one SQLite transaction. Backfill legacy rows using stored candidate keys; where many candidates share a key, select earliest valid snapshot and leave other historical files untouched.
- [ ] **Step 4: Reconcile before retry.** Check manifest entry, snapshot path and SHA-256 before marking completed. If no write occurred, requeue. If snapshot, manifest or lock contradict each other, mark `needs_attention` with `RAW_WRITE_UNCERTAIN`. Never delete an unknown lock automatically. Keep the raw lane independent of the Claude lane.
- [ ] **Step 5: Run focused tests and typecheck.** `npm exec --workspace apps/server vitest -- run src/import/filing-recovery.test.ts src/import/filing-jobs.test.ts`; `npm run typecheck --workspace apps/server`.

### Task 4: CLI process lifecycle and serial maintenance recovery

**Files:** Create `apps/server/src/process/managed-child.ts`, `apps/server/src/process/managed-child.test.ts`, `apps/server/src/analysis/recovery.ts`, `apps/server/src/analysis/recovery.test.ts`; modify `apps/server/src/process/run.ts`, `apps/server/src/agents/runner.ts`, `apps/server/src/analysis/jobs.ts`, `apps/server/src/analysis/maintenance.ts`, `apps/server/src/analysis/routes.ts`, `apps/server/src/analysis/maintenance-jobs.test.ts`.

**Interfaces:** `runManagedChild` resolves/rejects only after `close`; cancellation uses SIGTERM, waits, then SIGKILL, waits; `ProcessExitUnconfirmed` pauses that lane. `AnalysisJobs` exposes next retry, run token, stage deadline, pause reason and `cancelMaintenance`/`resumeLane`.

- [ ] **Step 1: Write failing child lifecycle test with a fixture that ignores SIGTERM.** Timeout triggers SIGKILL and promise remains pending until `close`; next queued Claude job starts only after first process exits. Cover output overflow and abort signal through the same termination path.
  ```ts
  await expect(runManagedChild(process.execPath, [fixture], { timeoutMs: 30, termGraceMs: 30 })).rejects.toMatchObject({ code: "PROCESS_TIMEOUT" });
  expect(secondStartedAt).toBeGreaterThanOrEqual(firstClosedAt);
  ```
- [ ] **Step 2: Run focused test and confirm failure.** `npm exec --workspace apps/server vitest -- run src/process/managed-child.test.ts`.
- [ ] **Step 3: Route raw and Claude processes through managed lifecycle.** Preserve existing output JSON and auth error mapping. On failed SIGKILL confirmation, keep the lane paused and expose a stable error; never mark a process exited merely because the timeout fired.
- [ ] **Step 4: Write failing maintenance scheduler tests.** Read-only analyze/plan failure retries after 1 and 10 minutes, while later jobs run. Missing CLI/auth pauses the Claude lane without consuming each job's attempts. A writing interruption requires journal/hash inspection. `ask_user` becomes `needs_attention`, while `defer` and `keep_raw_only` stay `skipped`. Historical `skipped + ask_user` rows migrate.
- [ ] **Step 5: Implement persistent scheduler state and recovery.** Add run token, stage start/deadline, lease, next retry and pause reason to `analysis_jobs`. Claim only ready work; schedule a wake timer for earliest retry. Read-only restart requeues; writing restart invokes reconciliation against journal and target hashes. Ensure `AnalysisJobs.stop()` aborts/awaits active children rather than waiting indefinitely.
- [ ] **Step 6: Run focused tests, serial integration tests and typecheck.** `npm exec --workspace apps/server vitest -- run src/process/managed-child.test.ts src/analysis/recovery.test.ts src/analysis/maintenance-jobs.test.ts`; `npm run typecheck --workspace apps/server`.

### Task 5: Import policy and editable provenance

**Files:** Create `apps/server/src/import/provenance.ts`, `apps/server/src/import/provenance.test.ts`; modify `apps/server/src/import/routes.ts`, `apps/server/src/import/filing.ts`, `apps/server/src/vaults/maintainer.ts`, `apps/server/src/state/db.ts`, `apps/web/src/api.ts`, `apps/web/src/screens/ImportScreen.tsx`, `apps/web/src/screens/VaultSettingsScreen.tsx`, associated screen tests.

**Interfaces:** `SourceMetadata = { author: string | null; authorship: "self" | "third_party" | "unknown"; authorEvidence: AuthorEvidence | null; version: number }`; `PATCH /imports/:batchId/items/:captureId/metadata` accepts `author`, `authorship`, `expectedVersion`.

- [ ] **Step 1: Write failing policy and override tests.** Fresh database defaults to auto-file/default + unknown; existing saved manual policy remains manual after reopen. Batch authorship override beats rule; item override beats batch. An explicit byline does not change authorship. Version mismatch returns 409 and keeps old value.
- [ ] **Step 2: Run focused tests and confirm failure.** `npm exec --workspace apps/server vitest -- run src/import/provenance.test.ts src/state/db.test.ts`.
- [ ] **Step 3: Implement policy and metadata service.** Store batch effective default in `import_batches` to freeze policy at receipt; store item override/version separately from parser evidence. Pass `--author` and `--authorship` to maintainer from the frozen job metadata. Remove URL-based `third_party` inference and synthetic raw author header; preserve source body byline.
  ```ts
  const args = [script, "--vault", vaultPath, "--file", temporaryMarkdown,
    "--authorship", metadata.authorship, "--json"];
  if (metadata.author) args.push("--author", metadata.author);
  ```
- [ ] **Step 4: Add HTTP and web controls.** GET/PUT import policy carries `defaultAuthorship`; preflight accepts optional batch override; source item displays detected author/evidence, per-item author/authorship editor, expected version and conflict feedback. A queued job reads current metadata at claim, then freezes it for that run.
- [ ] **Step 5: Run focused server and web tests plus typecheck.** `npm exec --workspace apps/server vitest -- run src/import/provenance.test.ts`; `npm exec --workspace apps/web vitest -- run src/screens/ImportScreen.test.tsx src/screens/VaultSettingsScreen.test.tsx`; `npm run typecheck --workspaces --if-present`.

### Task 6: Controlled correction of already filed metadata

**Files:** Modify `apps/server/src/import/provenance.ts`, `apps/server/src/import/routes.ts`; create `apps/server/src/import/provenance-correction.test.ts`; in sibling `../open-context-forge-vault-maintainer`, add `scripts/correct-source-metadata.js` and its focused tests, without changing `SKILL.md` ownership rules.

**Interfaces:** CLI input `--vault`, `--fingerprint`, `--expected-author`, `--expected-authorship`, `--author`, `--authorship`, `--json`; output new manifest version and audit event. App receives a conflict code without modifying raw bytes.

- [ ] **Step 1: Write failing CAS tests in the sibling CLI and app.** Changing a known author/ownership with matching expected values updates manifest and app record; stale expected value returns conflict; raw hash stays identical; a compiled note with old metadata triggers a targeted sync check or needs attention.
- [ ] **Step 2: Run focused tests to confirm failure.** Use the sibling package test command shown in its `package.json`, then `npm exec --workspace apps/server vitest -- run src/import/provenance-correction.test.ts`.
- [ ] **Step 3: Implement a narrow, audited CLI correction.** Hold the existing vault manifest lock, verify expected snapshot/fingerprint/old metadata, atomically replace manifest and append audit entry. App invokes CLI and checks report; never write manifest directly from HTTP code.
- [ ] **Step 4: Integrate correction state.** If analysis output already contains stale author/ownership, queue targeted sync and validation; if safe synchronization cannot be proved, create an attention item and keep maintenance incomplete. Preserve raw bytes.
- [ ] **Step 5: Run sibling and app tests and verify hashes.** Stage/commit only approved sibling files in its repository; if sandbox refuses sibling writes, stop this task and report the exact auto-review rejection while continuing independent tasks.

### Task 7: Attention projection and cross-page reminder

**Files:** Create `apps/server/src/attention/service.ts`, `apps/server/src/attention/routes.ts`, `apps/server/src/attention/attention.test.ts`, `apps/web/src/AttentionCenter.tsx`, `apps/web/src/AttentionCenter.test.tsx`; modify `apps/server/src/app.ts`, `apps/web/src/App.tsx`, `apps/web/src/api.ts`, `apps/web/src/screens/ImportScreen.tsx`, `apps/web/src/styles.css`.

**Interfaces:** `GET /api/v1/attention` returns `{ count, items, reminderDue }`; `POST /api/v1/attention/reminder-seen` records a local calendar date; task action endpoints delegate to filing or maintenance owner modules.

- [ ] **Step 1: Write failing projection tests.** `ask_user`, exceeded retries and uncertain writes count; ordinary skipped outcomes do not. An item older than 24 hours shows a banner on next app visit at most once per local day; dismissed banner leaves the count. Include source, vault, stage, error, plan, journal and target path in detail.
- [ ] **Step 2: Run focused tests and confirm failure.** `npm exec --workspace apps/server vitest -- run src/attention/attention.test.ts`; `npm exec --workspace apps/web vitest -- run src/AttentionCenter.test.tsx`.
- [ ] **Step 3: Implement read-only projection and reminder store.** Derive counts from filing and analysis jobs; persist last shown local date in SQLite. Only actions call owning service methods: retry, correct metadata, keep raw, cancel queued, inspect/recover. Never make a generic attention service write raw/wiki files.
- [ ] **Step 4: Wire global navigation and source detail.** Poll attention independently of the Import screen, show a badge and next-visit banner, and render per-vault filing then maintenance state with real stage elapsed time and retry time. Do not display invented percent progress.
- [ ] **Step 5: Run focused UI/e2e tests and typecheck.** `npm exec --workspace apps/web vitest -- run src/AttentionCenter.test.tsx src/screens/ImportScreen.test.tsx`; `npm run typecheck --workspaces --if-present`.

### Task 8: Contract migration and end-to-end verification

**Files:** Modify `apps/web/src/api.ts`, `apps/web/e2e/file-import.spec.ts`, `apps/web/e2e/source-workbench.spec.ts`, `README.md`; adjust existing server tests that assumed synchronous `200` filing.

**Interfaces:** Accepted filing response `{ job: FilingJob }` with HTTP 202; completed state is obtained from `GET /imports/filing-jobs` and existing membership queries.

- [ ] **Step 1: Update affected tests to wait for completed jobs.** Never treat 202 as imported. Cover repeat push, manual 1-N source selection remaining functional, stalled Claude with a second raw import, cross-page attention and user metadata correction.
- [ ] **Step 2: Run server and web unit tests.** `npm run test --workspaces --if-present`; if the local Node/better-sqlite3 ABI prevents test startup, use a matching installed Node runtime or rebuild the native dependency, then rerun. Report any environmental limit exactly.
- [ ] **Step 3: Run typecheck, build and targeted e2e.** `npm run typecheck --workspaces --if-present`, `npm run build --workspaces --if-present`, `npm run test:e2e --workspace apps/web -- file-import.spec.ts source-workbench.spec.ts`.
- [ ] **Step 4: Update README.** Explain default import rule, per-vault maintenance switch, 202 queue semantics, retry/attention workflow, authorship default and per-item correction. Keep article writing and Blog publication description accurate.
- [ ] **Step 5: Review changed files, check staged diff and commit only task-related hunks.** `git diff --check`; `git diff --cached --check`; compare every staged path against the worktree status captured before implementation.

## Self-review checkpoints

- Spec coverage: intake persistence/defaults (Tasks 2, 5), separate lanes/process exit (Tasks 2, 4), lease/retry/recovery (Tasks 3, 4), stable identity (Tasks 1, 3), attribution/correction (Tasks 1, 5, 6), attention/reminder (Task 7), HTTP/client migration (Tasks 2, 8).
- Type handoff: `CaptureCandidate` → `sourceKey`/`SourceMetadata` → `FilingJob` → verified membership → `AnalysisJob` → `AttentionSummary`.
- Cross-repository dependency: Task 6 needs sibling CLI write access; it must not weaken existing manifest conflict protection.
