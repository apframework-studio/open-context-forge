# Single Article to Blog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在本机流程工作台中，自动提供内置默认 vault，也能添加外部 vault；将一篇 Clipper 资料导入所选 vault，人工完成一篇文章，预览并经确认后发布到 apframework 博客，最后验证公开链接。

**Architecture:** React/Vite 提供本机 Web 界面，Fastify 提供只监听 loopback 的业务 API。vault 快照与文章项目保存在 Markdown 文件中，SQLite 只保存本机配置、导入和发布状态；现有 vault-maintainer 与 article-publisher 脚本通过受控子进程调用。此计划只覆盖首条纵向链路，批量、多 vault 联合证据和 Codex 协作由后续独立计划完成。

**Tech Stack:** Node.js 22.12+、TypeScript、npm workspaces、React 19、Vite 8、Fastify 5、@fastify/multipart 10、fflate 0.8、better-sqlite3 12、react-markdown、remark-gfm、Vitest 4、Playwright 1.63。

**Spec:** docs/superpowers/specs/2026-10-22-open-context-forge-v1-design.md

## Global Constraints

- 服务只监听 127.0.0.1；不把本机文件操作暴露给公共网络。
- 所有改变文件或发布状态的 API 均要求 x-ocf-client: 1，并只接受本机工作台 Origin；不满足时返回 403，避免其他网页用表单驱动本机服务。
- Markdown/Obsidian vault 是来源和知识文件的主库；文章项目也必须是可直接检查的本机文件。
- 首次启动自动初始化应用数据目录中的内置 vault，并将其设为默认；导入时预选默认 vault，但允许切换到已登记的外部 vault。
- 来源快照不可覆盖；写 vault、定稿和发布需要界面中的明确确认。
- 首版运行时是 Codex；本计划先完成无需智能体也能手工运行的纵向链路，并定义后续适配接口。不引入 DeepSeek Harness。
- apframework 发布前必须本地预览；prepared、written-to-repository、live 三种状态不得混用。
- 不能改动当前 apframework.com 工作区中的未提交文件。自动化测试只使用临时 vault、临时博客仓库和模拟公开 URL。
- 现有三个 sibling 仓库只作为 CLI/格式来源读取；本计划不修改它们。执行时通过显式配置指向 vault-maintainer、article-publisher 和博客仓库。
- 所有外部进程使用参数数组，不通过 shell 拼接命令。运行时路径经 realpath 校验，不能由浏览器直接提交任意可执行文件路径。

---

## 范围分解与后续计划

本设计跨越多个子系统，因此分成可独立验收的计划。本计划完成单篇到博客的纵向链路；完成后分别编写并执行：

1. 批量导入、重复/缺失正文处理和双 vault 证据计划。
2. Codex 会话、逐篇分析、知识笔记提案和段落差异协作计划。
3. 公众号导入包与渠道预览计划。
4. SaaS 身份、租户隔离、云存储和任务执行计划；不属于个人桌面首版。

## 文件结构

| 文件 | 单一职责 |
| --- | --- |
| package.json、tsconfig.base.json | npm workspaces、通用脚本与 TS 约束 |
| packages/contracts/src/index.ts | API 对象类型；不依赖前后端实现 |
| apps/server/src/app.ts、main.ts | Fastify 路由装配与 loopback 启动 |
| apps/server/src/state/db.ts | SQLite 建库、迁移和连接生命周期 |
| apps/server/src/import/clipper-zip.ts | Clipper ZIP 解析和记录校验 |
| apps/server/src/import/routes.ts | 上传预检、选择单篇和导入状态 |
| apps/server/src/vaults/registry.ts、routes.ts | vault 登记、路径校验和列表 |
| apps/server/src/vaults/maintainer.ts | 调用现有 vault-maintainer CLI |
| apps/server/src/articles/store.ts、routes.ts | 文章项目、Markdown 正文、修订和定稿 |
| apps/server/src/publishing/publisher.ts、routes.ts | 准备发布包、隔离博客写入、部署和验证 |
| apps/server/src/process/run.ts | 带超时、退出码和标准输出限制的子进程调用 |
| apps/web/src/App.tsx、styles.css | 流程工作台外壳与导航 |
| apps/web/src/screens/ImportScreen.tsx | ZIP 预检、vault 选择、确认导入 |
| apps/web/src/screens/ArticleScreen.tsx | 正文编辑、版本与 Markdown 预览 |
| apps/web/src/screens/PublishScreen.tsx | 渠道包、本地检查、确认和上线状态 |
| apps/web/src/api.ts | 浏览器到本机服务的类型化请求 |
| apps/web/e2e/single-article.spec.ts | 无外部发布的浏览器完整流程 |
| apps/web/e2e/fixtures.ts | 浏览器测试使用的最小 Clipper ZIP |

### Task 1: 本机应用与健康检查

**Files:**
- Create: package.json、tsconfig.base.json、apps/server/package.json、apps/server/src/app.ts、apps/server/src/main.ts、apps/server/src/app.test.ts
- Create: apps/web/package.json、apps/web/index.html、apps/web/vite.config.ts、apps/web/src/main.tsx、apps/web/src/App.tsx、apps/web/src/styles.css
- Create: packages/contracts/package.json、packages/contracts/src/index.ts

**Interfaces:**
- Produces: createApp(options: AppOptions): FastifyInstance；AppOptions 包含 dataDir，以及可选 maintainerRoot、publisherRoot、blogRoot；GET /api/v1/health 返回 { status: "ok" }。
- Produces: 前端四个导航项，默认“资料与分析”；Vite 将 /api 原样代理到 127.0.0.1:3081。

- [x] **Step 1: 写失败测试。**

~~~ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createApp } from "./app";

test("health is available without external services", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-"));
  const app = createApp({ dataDir });
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
~~~

- [x] **Step 2: 运行 npm test --workspace apps/server，确认因缺少 createApp 而失败。**
- [x] **Step 3: 增加最小服务与界面。**

~~~ts
import Fastify from "fastify";

export interface AppOptions {
  dataDir: string;
  maintainerRoot?: string;
  publisherRoot?: string;
  blogRoot?: string;
}

export function createApp(_options: AppOptions) {
  const app = Fastify();
  app.get("/api/v1/health", async () => ({ status: "ok" }));
  return app;
}
~~~

根 package.json 的 workspaces 为 apps/* 与 packages/*，scripts 至少包含 test、typecheck、build 和 test:e2e，分别调用对应 workspace。apps/server 依赖 fastify、@fastify/multipart、better-sqlite3、fflate；apps/web 依赖 react、react-dom、react-markdown、remark-gfm，开发依赖 vite、vitest、@playwright/test；packages/contracts 只发布类型。锁文件由 npm install 生成并提交。

main.ts 从 OCF_DATA_DIR、OCF_MAINTAINER_ROOT、OCF_PUBLISHER_ROOT、OCF_BLOG_ROOT 读取路径配置，前者缺失时选择平台用户数据目录；再调用 createApp(options).listen({ host: "127.0.0.1", port: 3081 })。Vite 配置 server.proxy 为 { "/api": "http://127.0.0.1:3081" }；React 的 App 用本地 state 切换四个导航区域，不先造假数据卡片。Fastify 在 onRequest 钩子中对非 GET/HEAD 的 /api/v1 路由检查 x-ocf-client 和允许的本机 Origin；前端 api.ts 统一添加该请求头。

- [x] **Step 4: 运行 npm test --workspace apps/server、npm run typecheck、npm run build，确认均退出 0；浏览器打开本机首页，四个导航可切换。**
- [x] **Step 5: 提交本任务文件，提交信息 feat: add local workflow shell。**

### Task 2: Clipper ZIP 解析与预检

**Files:**
- Create: apps/server/src/import/clipper-zip.ts、apps/server/src/import/clipper-zip.test.ts
- Modify: packages/contracts/src/index.ts

**Interfaces:**
- Produces: parseClipperZip(bytes: Uint8Array): CaptureCandidate[]。
- CaptureCandidate 字段：id、title、originalUrl、author?、capturedAt、markdown、contentHash、warnings、status: "ready" | "incomplete"。

~~~ts
export interface CaptureCandidate {
  id: string;
  title: string;
  originalUrl: string;
  author?: string;
  capturedAt: string;
  markdown: string;
  contentHash: string;
  warnings: string[];
  status: "ready" | "incomplete";
}
~~~

- [x] **Step 1: 写有效 ZIP、重复 ID、缺少 captures.json、过大 manifest、哈希不符、content_too_short 六个失败测试。**

~~~ts
import { createHash } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import { expect, test } from "vitest";
import { parseClipperZip } from "./clipper-zip";

test("reads one Clipper capture without extracting article paths", () => {
  const markdown = "完整正文";
  const hash = createHash("sha256").update(markdown).digest("hex");
  const record = {
    schemaVersion: 1, id: "capture-1",
    source: { originalUrl: "https://example.org/a", canonicalUrl: "https://example.org/a", title: "文章 A" },
    content: { markdown, wordCount: 4, imageUrls: [] },
    capture: { capturedAt: "2026-10-22T00:00:00Z", extractor: "readability", contentHash: hash, warnings: [] },
    user: {}, delivery: { status: "queued", attempts: 0 }
  };
  const bytes = zipSync({ "captures.json": strToU8(JSON.stringify([record])), "articles/ignored.md": strToU8("ignore") });
  expect(parseClipperZip(bytes)[0].title).toBe("文章 A");
});
~~~

缺失与过大案例应验证错误码，不依赖错误文字。

- [x] **Step 2: 运行 npm test --workspace apps/server -- clipper-zip，确认六个测试先失败。**
- [x] **Step 3: 实现解析。** 限制压缩包 20 MiB、captures.json 解压后 8 MiB、记录数 200。fflate 的 filter 在解压分配前检查 originalSize，只允许 captures.json；忽略 ZIP 内的其他路径，绝不落盘。校验 schemaVersion=1、必需字段类型、HTTP(S) URL、重复 ID、markdown 的 SHA-256；哈希按 Clipper 的 CRLF→LF 再 trim 规则计算。warnings 含 content_too_short 或 paywall_preview 时标为 incomplete。

~~~ts
const files = unzipSync(bytes, {
  filter(file) {
    if (file.name !== "captures.json") return false;
    if (file.originalSize > 8 * 1024 * 1024) throw new ImportError("MANIFEST_TOO_LARGE");
    return true;
  }
});
const records: unknown = JSON.parse(strFromU8(files["captures.json"]));
~~~

ImportError 在同文件定义，包含 code 字段；解析失败返回 INVALID_ZIP、INVALID_JSON、INVALID_RECORD 或 HASH_MISMATCH，不把原始堆栈传给浏览器。

~~~ts
export class ImportError extends Error {
  constructor(readonly code: "INVALID_ZIP" | "INVALID_JSON" | "INVALID_RECORD" |
    "HASH_MISMATCH" | "MANIFEST_TOO_LARGE") {
    super(code);
  }
}
~~~

- [x] **Step 4: 运行上述六个测试及 npm run typecheck，确认退出 0。**
- [x] **Step 5: 提交，提交信息 feat: validate clipper zip imports。**

### Task 3: 上传预检和任务状态

**Files:**
- Create: apps/server/src/state/db.ts、apps/server/src/import/routes.ts、apps/server/src/import/routes.test.ts
- Modify: apps/server/src/app.ts、packages/contracts/src/index.ts

**Interfaces:**
- Produces: POST /api/v1/imports/preflight，multipart 字段 file，返回 { batchId, candidates }；GET /api/v1/imports/:batchId 返回预检和各条状态。
- SQLite 表 import_batches(id, created_at) 与 import_items(batch_id, capture_id, payload_json, status, error_code)，主键为 (batch_id, capture_id)。

- [x] **Step 1: 写 Fastify inject 测试：上传 Task 2 的 ZIP 后能取得 batchId，重读仍能看到 ready/incomplete；超过 20 MiB 返回 413。**
- [x] **Step 2: 运行 routes.test.ts，确认 404 或测试导入失败。**
- [x] **Step 3: 用 better-sqlite3 建表，并用 @fastify/multipart 注册 files:1、parts:1、fileSize:20 MiB。路由调用 req.file()、part.toBuffer()、parseClipperZip()，在单个 SQLite transaction 写入批次与条目。数据库路径由 createApp({ dataDir }) 注入；测试使用临时目录。**

~~~ts
db.exec("CREATE TABLE IF NOT EXISTS import_batches (id TEXT PRIMARY KEY, created_at TEXT NOT NULL)");
db.exec("CREATE TABLE IF NOT EXISTS import_items (batch_id TEXT NOT NULL, capture_id TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL, error_code TEXT, PRIMARY KEY (batch_id, capture_id))");
const insertBatch = db.transaction((batchId: string, items: CaptureCandidate[]) => {
  db.prepare("INSERT INTO import_batches VALUES (?, ?)").run(batchId, new Date().toISOString());
  const insertItem = db.prepare("INSERT INTO import_items VALUES (?, ?, ?, ?, NULL)");
  for (const item of items) insertItem.run(batchId, item.id, JSON.stringify(item), item.status);
});
~~~

- [x] **Step 4: 运行路由测试、typecheck，并重启进程验证 batchId 可重读。**
- [x] **Step 5: 提交，提交信息 feat: persist import preflight batches。**

### Task 4: Vault 登记与不可变来源导入

**Files:**
- Create: apps/server/src/vaults/registry.ts、apps/server/src/vaults/maintainer.ts、apps/server/src/vaults/routes.ts、apps/server/src/vaults/vaults.test.ts
- Create: apps/server/src/process/run.ts
- Modify: apps/server/src/state/db.ts、apps/server/src/app.ts

**Interfaces:**
- Produces: GET /api/v1/vaults（含默认 vault）、POST /api/v1/vaults { id, path, adopt? }、PUT /api/v1/vaults/default { vaultId }、POST /api/v1/imports/:batchId/items/:captureId/commit { vaultId }。
- Produces: runTool(binary: string, args: string[], options: { cwd: string; timeoutMs: number }): Promise<{ stdout: string; stderr: string }>；importSnapshot(candidate, vaultPath): Promise<{ snapshot: string; fingerprint: string; duplicate: boolean }>。

- [x] **Step 1: 写测试：首次启动自动初始化内置 vault 并设为默认；重启不重复创建；外部已有 OCF vault 可登记，普通 Obsidian vault 仅在 adopt=true 时采用；同一 realpath 不可重复登记；默认 vault 可切换；incomplete 条目不可提交；有效条目调用 maintainer 后返回 vault 内快照路径；二次提交返回 duplicate。**
- [x] **Step 2: 运行 vaults.test.ts，确认失败。**
- [x] **Step 3: 实现 vaults(id, real_path, kind, is_default) 表和路径校验。应用启动时调用 vault-maintainer 的 init-vault.js 在 dataDir/vaults/default 初始化内置 vault，幂等登记为默认。外部目录已有 .ocf/vault.json 时直接登记；否则仅在用户明确选择 adopt 时调用 adopt-vault.js，且调用前在界面列出将创建的内容。maintainer 路径来自服务启动配置，不能由请求指定。将来源标题、URL、时间、作者、备注和正文写为临时 Markdown，调用现有 import-markdown.js --vault <path> --file <temp> --url <url> --authorship third_party --json；未知原作者不传 --author。成功后解析 JSON 报告，校验 snapshot 相对路径仍在 vault 内，并删除临时文件。**

~~~ts
const args = [maintainerScript, "--vault", vaultPath, "--file", temporaryMarkdown,
  "--url", candidate.originalUrl, "--authorship", "third_party", "--json"];
if (candidate.author) args.push("--author", candidate.author);
const result = await runTool(process.execPath, args, { cwd: maintainerRoot, timeoutMs: 60_000 });
const report = JSON.parse(result.stdout);
~~~

导入状态在 CLI 成功后才从 ready 改为 imported；失败保存 error_code，并保持可重试。测试通过真实临时 vault + 现有 maintainer 脚本运行一例，其余测试可注入假 runner。

- [x] **Step 4: 运行 vaults.test.ts、maintainer 仓库 npm test、typecheck；确认快照哈希由 maintainer 校验。**
- [ ] **Step 5: 提交，提交信息 feat: import captures into selected vault。**

### Task 5: 文章项目与人工编辑

**Files:**
- Create: apps/server/src/articles/store.ts、apps/server/src/articles/routes.ts、apps/server/src/articles/articles.test.ts
- Modify: apps/server/src/app.ts、packages/contracts/src/index.ts

**Interfaces:**
- Produces: POST /api/v1/articles { title, summary, date, sourceRef }；GET /api/v1/articles/:id；PUT /api/v1/articles/:id/draft { markdown, expectedRevision }；POST /api/v1/articles/:id/finalize { expectedRevision }。
- 项目路径为 dataDir/writing-projects/<id>/；article.md 与 versions/<revision>.md 是权威文件，SQLite 只保存项目索引和当前状态。

- [ ] **Step 1: 写测试：创建文章后 article.md 有公开元数据；保存草稿使 revision 增加；旧 expectedRevision 返回 409；定稿后再次编辑创建新 revision 并清除定稿状态。**
- [ ] **Step 2: 运行 articles.test.ts，确认失败。**
- [ ] **Step 3: 实现文件写入先写临时文件再 rename；版本文件只用 wx 创建。文章状态为 draft、final。草稿 frontmatter 含 status: draft；finalize 前运行现有 check-article.js --file <article.md> --json，并要求该命令退出 0，然后将 status 改为 reviewed、draft 改为 false，写入新的定稿修订。后续编辑重新设为 draft。**

~~~ts
export interface ArticleState {
  id: string;
  revision: number;
  status: "draft" | "final";
  markdown: string;
  sourceRef: { vaultId: string; snapshot: string };
}
~~~

首条链路保留一条来源引用，用户手工写正文；后续多 vault 计划将 sourceRef 扩展为证据清单，不更改 article.md 的可读性。

- [ ] **Step 4: 运行 articles.test.ts、writer 仓库 npm test、typecheck；检查 versions 目录内容与 article.md 一致。**
- [ ] **Step 5: 提交，提交信息 feat: persist reviewable article projects。**

### Task 6: 本地发布包与渠道预览

**Files:**
- Create: apps/server/src/publishing/publisher.ts、apps/server/src/publishing/routes.ts、apps/server/src/publishing/publisher.test.ts
- Modify: apps/server/src/app.ts、packages/contracts/src/index.ts

**Interfaces:**
- Produces: POST /api/v1/articles/:id/publications/prepare { slug }；GET /api/v1/articles/:id/publications/:publicationId。
- 返回 prepared 状态、文章修订号、源稿 SHA-256、生成的 MDX 和图片相对路径；不写博客仓库。

- [ ] **Step 1: 写测试：draft 不能准备；final 通过现有 publisher 脚本生成 publication.json；修改正文后旧发布包失效；相同版本/slug 重试不复制第二份。**
- [ ] **Step 2: 运行 publisher.test.ts，确认失败。**
- [ ] **Step 3: 调用 publish.mjs --project <project> --channel apframework --output <dataDir>/publications/<id> --slug <slug> --json。读取 publication.json，确保 article 和 assets 均为相对路径且在输出目录内；保存 prepared 状态和对应 revision。**

~~~ts
const args = [publisherScript, "--project", projectPath, "--channel", "apframework",
  "--output", packagePath, "--slug", slug, "--json"];
const report = JSON.parse((await runTool(process.execPath, args, {
  cwd: publisherRoot, timeoutMs: 60_000
})).stdout);
~~~

- [ ] **Step 4: 运行 publisher.test.ts、publisher 仓库 npm test、typecheck；用一篇含图片的临时文章核对 MDX 与素材路径。**
- [ ] **Step 5: 提交，提交信息 feat: prepare apframework preview packages。**

### Task 7: 确认发布、隔离写入与公开链接验证

**Files:**
- Create: apps/server/src/publishing/blog-deploy.ts、apps/server/src/publishing/blog-deploy.test.ts
- Modify: apps/server/src/publishing/routes.ts、apps/server/src/state/db.ts、packages/contracts/src/index.ts

**Interfaces:**
- Produces: POST /api/v1/publications/:id/publish { confirmedRevision, confirmedArticlePath }；POST /api/v1/publications/:id/verify { publicUrl }。
- 状态依次为 prepared → written-to-repository → deployment-pending → live；失败保留失败阶段和日志摘要。

- [ ] **Step 1: 写测试：确认修订号不匹配返回 409；博客源工作区有未提交修改也不触碰它；隔离 worktree 构建失败不得 push；验证 URL 不含标题或代表性正文时不得标记 live；重复 publish 不重复提交。**
- [ ] **Step 2: 运行 blog-deploy.test.ts，确认失败。**
- [ ] **Step 3: 在已配置博客仓库运行 git fetch origin main，再从 origin/main 在应用数据目录创建独立 Git worktree。将预览过的同一 revision 用 publisher CLI 写入该 worktree；在隔离目录运行仓库自带的 node .yarn/releases/yarn-3.6.1.cjs install --immutable 与 node .yarn/releases/yarn-3.6.1.cjs build；检查只新增该文章的 MDX 与素材；提交后 push HEAD:main。push 失败停在 written-to-repository，并保留 worktree 供排查。确认操作只消费预先生成的 publicationId、confirmedRevision 与显示给用户的路径。**

~~~ts
if (request.confirmedRevision !== publication.revision) throw new ConflictError();
if (request.confirmedArticlePath !== publication.relativeArticlePath) throw new ConflictError();
await runTool("git", ["fetch", "origin", "main"], { cwd: blogRoot, timeoutMs: 60_000 });
await runTool("git", ["worktree", "add", "--detach", worktreePath, "origin/main"],
  { cwd: blogRoot, timeoutMs: 60_000 });
await runTool(process.execPath, [publisherScript, "--project", projectPath,
  "--channel", "apframework", "--blog-root", worktreePath, "--slug", publication.slug, "--json"],
  { cwd: publisherRoot, timeoutMs: 60_000 });
await runTool(process.execPath, [".yarn/releases/yarn-3.6.1.cjs", "install", "--immutable"],
  { cwd: worktreePath, timeoutMs: 300_000 });
await runTool(process.execPath, [".yarn/releases/yarn-3.6.1.cjs", "build"],
  { cwd: worktreePath, timeoutMs: 300_000 });
~~~

实现时对 Git diff 的允许路径做精确检查，再执行 git add/commit/push；无其他变更才可推进。verify 对公开 URL 发 GET，检查 HTTP 200、标题与来自定稿正文的代表性段落；最后在界面要求用户确认排版检查结果，再标记 live。真实推送和 URL 验证是手工验收步骤，自动测试使用本地 bare remote 与本地 HTTP fixture。

- [ ] **Step 4: 运行 blog-deploy.test.ts、typecheck、build；在临时 bare remote 上验证成功与构建失败两条路径，确认源博客工作区状态不变。**
- [ ] **Step 5: 提交，提交信息 feat: publish and verify blog articles。**

### Task 8: 流程工作台连接真实状态

**Files:**
- Create: apps/web/src/api.ts、apps/web/src/screens/ImportScreen.tsx、apps/web/src/screens/ArticleScreen.tsx、apps/web/src/screens/PublishScreen.tsx、apps/web/e2e/single-article.spec.ts、apps/web/e2e/fixtures.ts
- Modify: apps/web/src/App.tsx、apps/web/src/styles.css、apps/web/package.json

**Interfaces:**
- Consumes: Tasks 3–7 的 /api/v1 路由。
- Produces: 可操作的资料导入、vault 确认、文章编辑、Markdown 预览、发布包审阅、发布确认和状态查询界面。

- [ ] **Step 1: 写 Playwright 测试，确认内置 vault 已默认选中；添加并切换到外部 vault；上传内存 ZIP；确认导入；编辑文章；在预览中检查标题；打开发布确认框但不执行真实 push。**

~~~ts
import { test, expect } from "@playwright/test";
import { fixtureZip } from "./fixtures";

test("single article reaches a reviewed publication package", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("导入 Clipper ZIP").setInputFiles({
    name: "clipper.zip", mimeType: "application/zip", buffer: fixtureZip
  });
  await expect(page.getByText("文章 A")).toBeVisible();
  await page.getByLabel("目标知识库").selectOption("research");
  await page.getByRole("button", { name: "确认导入" }).click();
  await page.getByRole("button", { name: "创建文章" }).click();
  await page.getByLabel("文章正文").fill("# 我的文章\n\n可回查来源的判断。");
  await page.getByRole("button", { name: "本地预览" }).click();
  await expect(page.getByRole("heading", { name: "我的文章" })).toBeVisible();
});
~~~

- [ ] **Step 2: 运行 npm run test:e2e，确认因页面缺少控件而失败。**
- [ ] **Step 3: 将导航页接到真实 API；文件 input 调用 preflight，候选列表显示 ready/incomplete 与错误；textarea 自动保存时带 expectedRevision；Markdown 预览用 react-markdown + remark-gfm，禁用原始 HTML；发布页显示 prepared 与 live 的不同文案。所有会修改文件或远程博客的按钮明确列出目标与版本。**

~~~tsx
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function ArticlePreview({ body }: { body: string }) {
  return <Markdown remarkPlugins={[remarkGfm]} skipHtml>{body}</Markdown>;
}
~~~

- [ ] **Step 4: 运行 npm test、npm run typecheck、npm run build、npm run test:e2e；人工在 1024px 和 375px 检查布局、键盘焦点与错误提示。**
- [ ] **Step 5: 提交，提交信息 feat: connect local publishing workflow ui。**

## 完成判定与后续交接

本计划完成时，开发者应展示：一个真实 Clipper ZIP 的单篇导入记录、vault 内不可变快照、可编辑且有修订记录的 article.md、prepared 博客包、本机预览和隔离博客构建结果。真实上线只在用户于界面确认后进行；提交记录、公开 URL 和内容核对结果一起保存。

此时进入第二份计划：批量导入、双 vault 与证据追溯。Codex 分析与写作协作在第三份计划中接入；由此避免把业务状态依赖在未验证的智能体会话行为上。

## 实施时参考的官方文档

- Vite 8 代理配置：https://github.com/vitejs/vite/blob/v8.0.10/docs/config/server-options.md
- Fastify 5 测试与路由：https://github.com/fastify/fastify/blob/v5.0.0/docs/Guides/Testing.md
- Fastify Multipart 10 限额：https://github.com/fastify/fastify-multipart/blob/v10.1.3/README.md
- fflate ZIP 过滤：https://github.com/101arrowz/fflate/blob/master/README.md
- better-sqlite3 事务与语句：https://github.com/wiselibs/better-sqlite3/blob/v12.6.2/docs/api.md
- react-markdown 安全与 GFM：https://github.com/remarkjs/react-markdown/blob/main/readme.md
- Playwright 文件上传：https://github.com/microsoft/playwright/blob/v1.63.0/docs/src/input.md
