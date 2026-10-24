# Source Workbench Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task. Steps use checkbox syntax for tracking.

**Goal:** Turn 资料与分析 into a compact, cross-batch source workbench with filing rules, bulk actions, and a vault content index, while leaving the agent collaboration panel unchanged.

**Architecture:** Keep captured source payloads in the existing SQLite import queue until the user files or deletes them. Expose a stable composite item identity (batchId + captureId), paginated queries, separate filing and analysis states, and persisted intake policy. The vault remains the durable knowledge store; the database holds queue, analysis proposal, and index metadata.

**Tech Stack:** Fastify, better-sqlite3, React, TypeScript, Vitest, Playwright.

**Spec:** Approved product design in the current task conversation, 2026-10-23; extends `docs/superpowers/specs/2026-10-22-open-context-forge-v1-design.md` section 3.1.

## Global Constraints

- Do not change `AgentPanel` or article agent conversation routes.
- Existing ZIP import and vault commit endpoints must keep working.
- No automatic deletion; recent views are time filters only.
- Default intake policy is manual; automatic filing requires a configured destination vault.
- Analysis card and filing are independent actions.

---

### Task 1: Cross-batch source queue and actions

**Files:** `apps/server/src/state/db.ts`, `apps/server/src/import/routes.ts`, `apps/server/src/import/routes.test.ts`, `apps/server/src/vaults/routes.ts`.

**Interfaces:** `GET /api/v1/imports/items?view=pending|recent|all|trash&page=1&pageSize=20&q=...`; `POST /api/v1/imports/items/actions` with `{items:[{batchId,captureId}], action:'shelve'|'restore'|'trash'|'file', vaultId?}`; `GET/PUT /api/v1/imports/policy`.

- [x] Write route tests for all-batch pagination, pending/recent semantics, filtering, soft deletion, and batch filing.
- [x] Run focused tests and confirm expected failures.
- [x] Add schema migration, queries, and action routes; reuse vault commit logic for filing.
- [x] Run focused tests and check existing import/vault tests.

### Task 2: Analysis cards before filing

**Files:** `apps/server/src/analysis/service.ts`, `apps/server/src/analysis/routes.ts`, `apps/server/src/analysis/analysis.test.ts`, `apps/server/src/state/db.ts`.

**Interfaces:** `POST /api/v1/imports/:batchId/items/:captureId/analysis` and `/analysis/confirm`, plus `GET /api/v1/imports/:batchId/items/:captureId/analysis`.

- [x] Write a failing test that generates and confirms a card for a pending capture without a vault snapshot.
- [x] Refactor the source loader to accept the captured payload, retain evidence validation, and persist proposals by capture identity.
- [x] On filing, write confirmed card to the vault using the resulting fingerprint; keep existing vault analysis API functional.
- [x] Run analysis and vault tests.

### Task 3: Compact workbench and vault index

**Files:** `apps/web/src/screens/ImportScreen.tsx`, `apps/web/src/screens/VaultScreen.tsx`, `apps/web/src/api.ts`, `apps/web/src/theme.css`, `apps/server/src/vaults/routes.ts`.

**Interfaces:** List rows with explicit status, expandable source/card detail, page controls, per-row and bulk actions; inline policy summary/editor; vault index endpoint for filed sources.

- [x] Add a focused UI or route test for the user-visible list/knowledge index behavior.
- [x] Confirm it fails against current screens/routes.
- [x] Implement the compact toolbar, queue tabs, filters, page controls, bulk actions, policy editor, and vault content list.
- [x] Run tests, typecheck, build, and a browser smoke check.

### Task 4: Verification and docs

**Files:** `README.md` and existing plan/spec docs only as needed.

- [x] Verify manual ZIP intake, pending analysis, direct filing, auto filing, shelving, trash, and vault browsing.
- [x] Run `npm test`, `npm run typecheck`, and `npm run build` and inspect full output.
- [x] Report any remaining limitations, especially deferred browser extension and agent collaboration.
