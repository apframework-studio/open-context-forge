# Knowledge Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each connected vault a read-only knowledge workspace that shows imported sources and original Markdown notes, supports search and verified-link graph exploration, and separates vault connection settings.

**Architecture:** A `KnowledgeIndex` reads each vault profile and manifest, safely scans Markdown, and stores rebuildable nodes and links in SQLite. Fastify exposes overview, paginated search, detail, graph, rescan, and disconnect routes. React presents overview, browse, and graph tabs, while a separate settings screen manages connections; Markdown remains the source of truth.

**Tech Stack:** Node.js 22, TypeScript, Fastify, better-sqlite3, React, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-24-knowledge-workspace-design.md`

**Execution status:** Implemented and verified on 2026-10-24. Existing uncommitted workspace changes were preserved; no commit or merge was made. The browser component test was updated after the UI change, while the server API and file behavior were exercised with failing tests before implementation.

## Global Constraints

- Browser is read-only for original Markdown; edit with Obsidian.
- Include original notes without OCF frontmatter and imported source snapshots.
- Graph edges come only from resolvable file links or source metadata; preserve unresolved and ambiguous links as issues.
- Skip symlinks, `.ocf`, profile log/index as ordinary notes, and the source tree when the wiki root is `.`.
- Disconnect removes registration and derived index only; never delete external files.
- Preserve all existing uncommitted workspace changes. Do not commit overlapping files in this task.

## File map

- `apps/server/src/vaults/knowledge-index.ts`: safe scan, SQLite cache, search, detail, link resolution, graph.
- `apps/server/src/vaults/knowledge-routes.ts`: HTTP validation and responses for knowledge APIs.
- `apps/server/src/vaults/registry.ts`: disconnect external vault and default fallback.
- `apps/server/src/app.ts`: register index routes and clean up watchers.
- `apps/server/src/vaults/knowledge-index.test.ts`: source/note/graph/sync/security behavior.
- `apps/web/src/api.ts`: knowledge endpoint contracts.
- `apps/web/src/screens/VaultScreen.tsx`: read-only overview, browse, graph tabs.
- `apps/web/src/screens/VaultSettingsScreen.tsx`: vault management moved out of browse.
- `apps/web/src/App.tsx`: separate knowledge and settings navigation.
- `apps/web/src/theme.css`: responsive workspace layout.
- `apps/web/src/screens/VaultScreen.test.tsx`, `apps/web/e2e/knowledge-workspace.spec.ts`: visible behavior.

---

### Task 1: Safe, rebuildable knowledge index

**Files:** Create `apps/server/src/vaults/knowledge-index.ts`; test `apps/server/src/vaults/knowledge-index.test.ts`.

**Interfaces:** `new KnowledgeIndex(db, registry)`; `await index.refresh(vaultId)` returns `{vaultId, sources, notes, indexedAt, errors}`; `index.list({vaultId?, q?, kind?, folder?, analysisStatus?, sort?, page, pageSize})` returns a page; `index.detail(vaultId, path)` reads verified content; `index.overview(vaultId?)` returns vault summaries and recent content.

- [x] **Step 1: Write failing tests** for an adopted external vault with `My note.md`, a source manifest entry, a profile index/log, and a symlink to a file outside the vault. Assert only the source and normal note appear, and a body query matches the note.
- [x] **Step 2: Run** `npm run test --workspace apps/server -- knowledge-index.test.ts` and confirm the new tests fail on the missing module.
- [x] **Step 3: Implement** SQLite node/state tables; read profile paths; recursively scan without following symbolic links; validate real paths; parse manifest; read markdown into derived cache; read current files for detail; use parameterized search and pagination. Bound scan to Markdown and enforce a per-file size limit with a visible error.
- [x] **Step 4: Run** the same test and ensure all assertions pass. Add test for edit/add/remove followed by `refresh`, then implement transactional replacement so stale rows disappear.
- [x] **Step 5: Review** the diff for accidental writes to Markdown or reads outside the vault; keep existing changes uncommitted.

### Task 2: Verified links and graph

**Files:** Modify `apps/server/src/vaults/knowledge-index.ts`; test `apps/server/src/vaults/knowledge-index.test.ts`.

**Interfaces:** `index.graph(vaultId, {q?, kind?, focus?, limit?})` returns `{nodes, edges, issues, totalNodes, truncated}`; `index.detail` adds `outlinks` and `backlinks`.

- [x] **Step 1: Write failing tests** for unique `[[Note]]`, relative `[title](../Note.md)`, source fingerprint/path metadata, missing link, duplicate basename ambiguity, and a source with no edges.
- [x] **Step 2: Run** the targeted test to observe the missing graph behavior.
- [x] **Step 3: Parse** links outside fenced code, resolve exact relative paths before unique basename candidates, and persist only resolved edges. Return unresolved/ambiguous issues with origin path and target text; preserve isolated nodes.
- [x] **Step 4: Run** targeted tests and verify backlinks, source citations, and issue counts.
- [x] **Step 5: Review** path normalization and ensure no inferred semantic edges.

### Task 3: Knowledge and connection APIs

**Files:** Create `apps/server/src/vaults/knowledge-routes.ts`; modify `apps/server/src/app.ts`, `apps/server/src/vaults/registry.ts`; test `apps/server/src/vaults/knowledge-index.test.ts`.

**Interfaces:** `GET /api/v1/knowledge/overview`, `/items`, `/items/:vaultId?path=...`, `/graph/:vaultId`; `POST /api/v1/knowledge/:vaultId/rescan`; `DELETE /api/v1/vaults/:vaultId`; existing vault routes continue to work.

- [x] **Step 1: Write failing HTTP tests** for first-load overview, list/search/detail, graph, manual rescan, disconnect refusing built-in, and external disconnect preserving files and switching default to built-in.
- [x] **Step 2: Run** the targeted tests and confirm route failures.
- [x] **Step 3: Register** route validation and explicit error codes; add registry disconnect transaction that clears dependent auto-file policy; clear derived index for disconnected vault. Use throttled refresh on reads plus manual rescan so external changes become visible if file watching is unavailable.
- [x] **Step 4: Run** targeted and existing vault tests; fix regressions.
- [x] **Step 5: Review** mutation guards and external file preservation.

### Task 4: Workspace and settings UI

**Files:** Modify `apps/web/src/api.ts`, `apps/web/src/App.tsx`, `apps/web/src/screens/VaultScreen.tsx`, `apps/web/src/theme.css`; create `apps/web/src/screens/VaultSettingsScreen.tsx`; test `apps/web/src/screens/VaultScreen.test.tsx`.

**Interfaces:** `VaultScreen({vaults, onSettings})` displays tabs and uses knowledge API; `VaultSettingsScreen({vaults, refresh})` handles connection, adoption preview, default, rescan, disconnect.

- [x] **Step 1: Update the component test** for the three tabs, recent content labels, search entry, and settings link; cover browse, graph, mobile navigation, and connection flow in Playwright.
- [x] **Step 2: Run** `npm run test --workspace apps/web -- VaultScreen.test.tsx` and observe the old assertion fail against the new UI before updating it.
- [x] **Step 3: Implement** the typed API contracts and the three-tab workspace. Keep the existing analysis card attached to source detail, use Markdown preview, and provide safe Obsidian/deep-link and path copy actions.
- [x] **Step 4: Move** connection controls to settings, add clear navigation and responsive layout. Implement graph as a bounded SVG with pan/zoom/reset, type filter, focus, selectable node, and a textual issue list.
- [x] **Step 5: Run** web component tests and typecheck; repair failures.

### Task 5: End-to-end verification and documentation

**Files:** Create `apps/web/e2e/knowledge-workspace.spec.ts`; modify `README.md` as needed.

**Interfaces:** User-facing path: connect existing vault → see original note → search text → inspect actual edge → rescan after edit → disconnect without deletion.

- [x] **Step 1: Write** a Playwright scenario using a temporary external vault and exercise the path through the UI.
- [x] **Step 2: Run** `npm run test:e2e --workspace apps/web` and repair behavior failures.
- [x] **Step 3: Run** `npm test`, `npm run typecheck`, `npm run build`, and the focused e2e suite with Node 22; inspect the output, not only exit status.
- [x] **Step 4: Update** README with the workspace behavior, manual rescan, external-vault safety, and Obsidian editing boundary.
- [x] **Step 5: Review** changed files and report verified functionality and any remaining limits.
