# 发布中心第一阶段 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让定稿文章能在发布中心持久准备微博、即刻渠道稿并复用本机图片素材。

**Architecture:** 独立的 PublishCenterStore 管理渠道稿、素材和引用关系；现有 PublicationStore 继续处理博客。React 发布中心通过新接口读取动态渠道目录和文章级详情。图片保存在文章项目目录中，数据库记录元数据与引用。

**Tech Stack:** TypeScript、Fastify、better-sqlite3、React、Vitest。

**Spec:** `docs/superpowers/specs/2026-11-07-publishing-center-design.md`

## Global Constraints

- 标准 16:9 横屏体验优先，兼容窄屏。
- 微博、即刻渠道内容独立保存，图片可共享并分别排序。
- 博客发布流程留在现有路径；本阶段没有外部发布动作。
- 测试使用 Node 22：`PATH=/Users/shoukai/.nvm/versions/node/v22.22.1/bin:$PATH`。

---

### Task 1: 持久化渠道稿和发布中心列表

**Files:**
- Create: `apps/server/src/publishing/center.ts`
- Create: `apps/server/src/publishing/center.test.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/publishing/routes.ts`
- Modify: `apps/web/src/api.ts`

**Interfaces:** `PublishCenterStore.list(): Promise<PublishCenterSummary>`；`getDraft(articleId, channelId)`；`saveDraft(articleId, channelId, input)`；`syncDraft(articleId, channelId)`。

- [ ] 写服务端接口测试：定稿文章才出现在列表；首次渠道稿为未计划；保存微博稿后刷新仍在；新文章修订显示过期，主动同步不覆盖文案。
- [ ] 运行 `PATH=/Users/shoukai/.nvm/versions/node/v22.22.1/bin:$PATH npm run test --workspace apps/server -- src/publishing/center.test.ts`，确认因接口缺失失败。
- [ ] 实现表、查询、路由和前端契约。渠道目录示例：

```ts
type ChannelId = "weibo" | "jike";
type DraftStatus = "draft" | "ready";
type ChannelDraft = { articleId: string; channelId: ChannelId; sourceRevision: number; status: DraftStatus; content: Record<string, string>; assetIds: string[] };
```

- [ ] 重跑定向测试与服务端类型检查，确认通过。

### Task 2: 图片素材上传、共用与删除

**Files:**
- Modify: `apps/server/src/publishing/center.ts`
- Modify: `apps/server/src/publishing/routes.ts`
- Modify: `apps/server/src/publishing/center.test.ts`
- Modify: `apps/web/src/api.ts`

**Interfaces:** `listAssets(articleId)`；`uploadAsset(articleId, {name,mime,bytes,group})`；`readAsset(articleId, assetId)`；`deleteAsset(articleId, assetId)`。

- [ ] 写失败测试：PNG 上传后可读；一图加入两个渠道稿；删除返回两个受影响渠道并清除引用；非法类型和跨文章引用被拒绝。
- [ ] 运行同一条定向测试命令，确认预期失败。
- [ ] 实现图片签名检查、文章目录写入、元数据与引用表、文件读取和删除路由。保存稿件时校验 `assetIds` 属于当前文章。
- [ ] 重跑定向测试与服务端类型检查，确认通过。

### Task 3: 发布中心页面与 16:9 体验

**Files:**
- Replace: `apps/web/src/screens/PublishScreen.tsx`
- Create: `apps/web/src/screens/PublishCenterScreen.tsx`
- Create: `apps/web/src/screens/PublishAssets.tsx`
- Create: `apps/web/src/screens/PublishChannels.tsx`
- Create: `apps/web/src/screens/publish-center.css`
- Modify: `apps/web/src/App.tsx`
- Create: `apps/web/src/screens/PublishCenterScreen.test.tsx`

**Interfaces:** 页面调用 Task 1/2 契约；博客入口跳转旧发布流程，微博与即刻分别编辑、保存、标记待发布；素材页负责上传、预览、删除与图片选择。

- [ ] 写失败的页面测试：列表仅显示已定稿文章；渠道稿保存后重开仍显示；图片删除确认列出引用渠道；无 Key 时生成按钮不可用。
- [ ] 运行 `PATH=/Users/shoukai/.nvm/versions/node/v22.22.1/bin:$PATH npm run test --workspace apps/web -- src/screens/PublishCenterScreen.test.tsx`，确认预期失败。
- [ ] 实现页面、样式与导航：桌面固定文章列、动态渠道列和进度；详情使用素材、微博、即刻独立标签页；窄屏可滚动或折叠。
- [ ] 运行页面测试、`npm run typecheck --workspaces --if-present`、`npm test`，再启动项目按 16:9 与窄屏实际体验。
