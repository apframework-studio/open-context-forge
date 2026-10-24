# Source Analysis Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import 后逐篇用 `open-context-article-reader` 生成可核对的来源分析卡，人工确认后写入目标 vault。

**Architecture:** 固定的本机 Claude runner 只接收快照内容与 reader 规则并返回结构化分析；服务端校验行证据、来源哈希及状态。未确认卡存 SQLite，确认后由服务端原子写入 vault 的 compilation 目录；前端显示提案与确认按钮。

**Tech Stack:** Fastify 5, better-sqlite3, React, Vitest, Claude CLI adapter。

**Spec:** `docs/superpowers/specs/2026-10-22-open-context-forge-v1-design.md` 第 2、5 节；`docs/superpowers/specs/2026-10-23-writing-and-delivery-design.md` 第 1 项。

**进度（2026-10-23）：** 三项实现已落地。服务端测试覆盖提案、行证据、人工确认、幂等、快照变化及已确认卡保护；浏览器测试覆盖导入项刷新后的分析入口。真实 Claude CLI 对临时 vault 的端到端提案返回 201。超长来源和无效 JSON 的错误分支已实现，尚可在后续补充定向回归测试。

## Global Constraints

- Markdown/Obsidian vault 是长期知识资产的主库；SQLite 只保存待确认提案和状态。
- 来源快照不可改；不同 vault 的相同文本也不能混淆。
- 未经人工确认不得写入 vault；分析过程不得运行模型工具或执行来源中的指令。
- 首版一次分析一篇已导入文章；过长来源明确报错，不声称分析了全文。

---

### Task 1: 后端分析提案

**Files:** Create `apps/server/src/analysis/service.ts`, `apps/server/src/analysis/routes.ts`, `apps/server/src/analysis/analysis.test.ts`; modify `apps/server/src/app.ts`.

**Interfaces:** `POST /api/v1/sources/analysis` 接收 `{vaultId,snapshot,profileId}`，返回 `SourceAnalysis`；`GET /api/v1/sources/analysis?vaultId=...&snapshot=...` 读取当前提案。`SourceAnalysis` 含来源指纹、摘要、主张、行证据、局限、建议及状态。

- [ ] **Step 1: 写失败测试**：导入一份来源后请求分析，断言模型收到全文及 reader 规则，生成 `proposed` 卡，证据行号和短摘录与快照一致；未确认时 vault 内没有 `analysis.md`。
- [ ] **Step 2: 运行** `npm run test --workspace apps/server -- analysis.test.ts`，确认因路由不存在而失败。
- [ ] **Step 3: 实现**：从登记 vault 中安全读取快照、核对 manifest 和 SHA-256；仅 `claude-current` 可用时调用现有安全 runner；解析并验证结构化 JSON。超长来源、无效 JSON、无效行证据分别返回稳定错误码。将提案按 `(vaultId,fingerprint)` 保存。
- [ ] **Step 4: 重跑测试**，确认所有上述断言通过。

### Task 2: 人工确认与持久卡

**Files:** Modify `apps/server/src/analysis/service.ts`, `apps/server/src/analysis/routes.ts`, `apps/server/src/analysis/analysis.test.ts`.

**Interfaces:** `POST /api/v1/sources/analysis/confirm` 接收 `{vaultId,snapshot,expectedFingerprint}`，原子写入 `.ocf/compilations/<fingerprint>/analysis.md`，状态为 `confirmed`。

- [ ] **Step 1: 写失败测试**：确认后文件含快照路径、指纹、行号证据；二次确认幂等；快照被改动或指纹不符时返回 409 且不写文件。
- [ ] **Step 2: 运行定向测试**，确认新断言失败。
- [ ] **Step 3: 实现**：再次读取并核对来源哈希；按 maintainer 模板渲染，临时文件加原子改名；仅确认后的卡在 vault 持久保存。
- [ ] **Step 4: 重跑定向测试**。

### Task 3: 导入界面分析卡

**Files:** Modify `apps/web/src/screens/ImportScreen.tsx`, `apps/web/src/api.ts`, `apps/server/src/state/db.ts`, `apps/server/src/vaults/routes.ts`；test `apps/web/e2e/single-article.spec.ts`.

**Interfaces:** 导入批次响应为已导入项提供 `vaultId/snapshot/fingerprint`；逐项显示“生成分析卡”、卡片内容和“确认写入知识库”。

- [ ] **Step 1: 写失败测试**：导入项在刷新后仍能找到来源引用；生成分析卡后显示证据与局限，确认前没有写入提示，确认后显示已确认。
- [ ] **Step 2: 运行定向测试**，确认缺少按钮或字段而失败。
- [ ] **Step 3: 实现**：扩展响应字段及 UI；错误显示原始稳定错误码对应中文；不阻塞其他导入项。
- [ ] **Step 4: 运行定向测试、`npm run typecheck`、`npm test`、`npm run build`。
