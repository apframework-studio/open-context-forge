# Open Context Forge

本机运行的知识创作流程工作台。当前实现第一条纵向链路：Clipper ZIP 预检 → 选择内置或外部 vault 并保存来源快照 → 编辑与定稿文章 → 预览 apframework 发布包 → 在界面确认后写入博客仓库 → 验证公开链接。

## 本地启动

需要 Node.js 22.12+，并在本仓库同级目录放置 `open-context-forge-vault-maintainer`、`open-context-forge-tech-article-writer` 和 `open-context-forge-article-publisher`。也可分别通过 `OCF_MAINTAINER_ROOT`、`OCF_WRITER_ROOT`、`OCF_PUBLISHER_ROOT` 指定它们的绝对路径。

```bash
npm install
npm run dev
```

打开 <http://127.0.0.1:5173/>。服务只监听 `127.0.0.1:3081`。首次启动会在 `~/Library/Application Support/Open Context Forge/vaults/default` 初始化内置默认 vault；设置 `OCF_DATA_DIR` 可更改应用数据目录。导入时可以切换目标 vault。添加普通 Obsidian 目录时，界面会先展示将新增的 OCF 文件，再等待明确确认。

发布到博客前，设置 `OCF_BLOG_ROOT` 为本机 `apframework.com` Git 仓库的绝对路径。发布动作从远端 `main` 建立隔离 worktree，构建通过后推送；原博客工作目录中的未提交修改不参与发布。公开页面验证默认只接受 `https://apframework.com`，开发或测试可通过 `OCF_BLOG_PUBLIC_ORIGIN` 覆盖。未配置博客仓库时仍可导入、写作和生成本地发布包。

```bash
npm test
npm run typecheck
npm run build
npm run test:e2e
```

端到端测试使用本机安装的 Chrome、临时应用数据目录和临时外部 vault；不会推送真实博客。

2026-10-23 已用 `apframework.com` 的 `origin/main` 临时副本验证渠道兼容性：现有发布器生成的样例 MDX 被 Contentlayer 收录，`yarn install --immutable` 与完整 `yarn build` 通过，静态页面生成于 `/blog/essay/2026-10-23-ocf-build-compat-check`。博客构建会向 Google Fonts 下载字体，因此构建环境需要能访问该服务。此检查没有修改或推送真实博客仓库。

## 当前范围

这一阶段已完成单篇资料到博客的可操作链路。批量分析、双 vault 联合证据、Codex 协作、公众号导入包和 SaaS 部署按 [产品设计](docs/superpowers/specs/2026-10-22-open-context-forge-v1-design.md) 分阶段接入。发布状态区分“本地包已准备”“已写入并推送”“公开链接已验证”。
