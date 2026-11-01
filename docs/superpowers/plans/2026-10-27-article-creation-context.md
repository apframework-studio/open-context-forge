# Multi-vault article creation implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans task by task. Preserve existing dirty work; no commits or branch changes in this task.

**Goal:** Implement the approved material drawer and two-pane writing workspace, with explicit per-turn source snapshots and writer skill/output integration.
**Architecture:** A WritingContextStore owns per-article materials, immutable turn snapshots and versioned outlines. Existing ACP agents consume a native filesystem context packet and produce staged proposals; the product owns adoption and publication. Frontend ArticleScreen composes a source drawer, reading/outline/manuscript tabs and existing chat.
**Tech Stack:** Existing Fastify/SQLite/fs, React/TypeScript/react-markdown, ACP. Node 22.22.1 for native SQLite.
**Spec:** docs/superpowers/specs/2026-10-27-article-creation-context.md

## Global Constraints
- User approved current conversation implementation; use current codex branch, preserve all prior dirty changes; no commits/push/deployment.
- No custom agent loop, no global skill installation or hook edits, no automatic publication.
- Explicit article scope; no implicit global last source on new articles; legacy sourceRef migrates.
- Immutable selected source versions per turn; safe relative paths, no symlinks/escaped vault reads; no silent truncation.
- Prepared attachments do not invoke the agent; output proposals do not overwrite formal manuscript.
- Context-owned SQLite rows use article ON DELETE CASCADE, files live under writing-projects/article-id so existing permanent purge remains correct.
- User paths, keys and source contents must not appear in generic diagnostic logs.

## Shared interfaces
Authoritative types are packages/contracts/src/writing.ts, exported from index.ts and re-exported by web/api.ts.
Material identity is stable article-local S1, S2 ...; hashes bind immutable Markdown snapshots. UI selections are {materialId,startLine?,endLine?}.

### Task 1: context storage and routes
Files: new server/articles/writing-context.ts, writing-context-routes.ts, writing-context.test.ts; small changes knowledge-index.ts/knowledge-routes.ts (multi-vault list). Root owns app.ts wiring and shared contracts.
Interfaces: new WritingContextStore(db,dataDir,vaults,articles,knowledge); get(articleId), save(articleId,{expectedRevision,vaultIds,materials:[{vaultId,path}],skillEnabled?,refresh?}), material(articleId,materialId,turnId?), createTurn(articleId,selections), outline(articleId), saveOutline(articleId,markdown,expectedRevision), approveOutline(articleId,expectedRevision). createTurn returns WritingTurnContext. material returns WritingMaterialDetail with markdown and safe verified links. Store offers skillStatus() returning WriterSkillStatus and uses ArticleStore.writerSkillPath().
Routes: GET/PUT /articles/:id/context; GET /articles/:id/materials/:materialId?turnId=; GET/PUT /articles/:id/outline; POST /articles/:id/outline/approve; GET /writing/skill. PUT context is atomic optimistic revision, retain old selected snapshots unless refresh=true, stable IDs never reused; removed refs remain retrievable for old turns. max 30 active materials, 20 vaults, 2MiB/file, 12MiB total turn snapshot, 100k outline. Empty selections are allowed; invalid membership/ranges reject. Context change invalidates outline approval. Legacy sourceRef migrates once. Multivault GET /knowledge/items?vaultIds=a,b supports combined search/paging with all old single-vault behavior.
- [ ] Add tests first: two vault sources persist and article B starts empty; stale context rejected; outside/symlink source rejected; legacy migration; source changes do not alter turn snapshot; selected subset/ranges only; outline edit/material change revokes confirmation; article purge cascade.
- [ ] Implement store/routes and run Node 22 server targeted tests. Example assertion: expect(turn.sources.map(s=>s.id)).toEqual(['S2']); mutate vault file and expect(material(id,'S2',turn.id).markdown).toBe(original).
- [ ] Report tested public interfaces and any integration concerns in .superpowers/sdd/2026-10-27-article-creation-context/task-1-report.md.

### Task 2: source drawer and reader (root)
Files: web/writing.ts (re-export contract), ArticleMaterialsDrawer.tsx, ArticleMaterialReader.tsx, writing-workspace.css. Components consume WritingContext and existing knowledge/vault APIs. Drawer props {articleId,vaults,context,onClose,onApply}; onApply receives updated WritingContext. Reader props {articleId,materials,selections,onSelectionsChange,onQuote,requestedSource?}; requestedSource permits immutable turnId.
- [ ] Browser regression first: multi-vault checkbox selection across pages, preview independent from selection, apply prepares refs without messages, cancel preserves context, single and compare reading, excerpt attached.
- [ ] Implement compact drawer with focus/escape handling and responsive reading, expose selected source chips and native citation click callbacks.

### Task 3: native context packet, writer proposals and history (fresh implementer after Task 1)
Files: agents/service.ts, routes.ts, runs.ts, runner.ts; new agents/writing-runtime.ts and tests. Root owns app.ts and frontend integration.
AgentService optional sixth argument WritingContextStore. start(articleId,profileId,content,selections?) receives explicit WritingSelection[]; absent selections means legacy context materials for backward compatibility, [] means none. Existing synchronous send stays compatible. createTurn + copy full source Markdown into per-turn input dir, manifest JSON, prompt enumerates IDs and native paths, article draft, approved outline, selected vaults; preserve source.md compatibility. Turn context attached to AgentRun and both user/assistant AgentMessage.context via context_json migration. No secret prompts in logs. Skill provided only when context.skillEnabled and actual SKILL.md exists. Writer outputs under agent-workspaces/:articleId/outputs/:turnId; prompt instructs output filenames outline.md and article.md, no formal writes. User can inspect after task via GET /articles/:id/writing-proposals (return WritingProposals). Accepting outline/draft remains explicit frontend action; endpoint reads bounded safe allowlisted files, rejects symlinks, scopes by article and live run. Export helpers if needed for testable packet/proposal reads. Preserve stream/cancel/permissions and busy lifecycle.
- [ ] Tests first with injected native runner read actual staged manifest/sources; exact subset, full text, independent article contexts, resume history context, no global skill mutation, staged output visibility and containment.
- [ ] Implement and run targeted agent tests, report task-3-report.md.

### Task 4: integrated writing screen, outline adoption and verification (root)
Files: ArticleScreen.tsx, ArticleConversation.tsx, useArticleAgent.ts, api.ts, App.tsx, e2e/article-writing-context.spec.ts, README.
- [ ] New articles explicitly create with no implicit sourceRef. Pass vault list. Load/save context per article with stale async ownership guards. Composer gets selections from context, per-turn attachment removal, quote and prefilled shortcut event; chat POST sends selections and displays immutable context on user messages; click S-ID citations opens reader using turnId.
- [ ] Right tabs material reading / outline / manuscript, retain existing edit/preview/read modes and all article management. Outline uses optimistic save and explicit approve; proposals offered separately and only adopted by user. Skill toggle shows availability/requested state. Adopt draft opens existing review dialog; output artifacts secondary.
- [ ] Run front/server unit suites and builds, focused article/agent E2E plus new cross-vault workflow. Inspect desktop/mobile screenshot; no permanent native calls in regression tests.
- [ ] Independent spec/quality review, fix important findings, record results and remaining verified limitations. Update README and checked tasks; no commits or PR without request.
