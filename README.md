# Open Context Forge

本机运行的知识创作流程工作台。当前链路：导入本地文件或 Clipper ZIP 到资料处理台 → 可选生成并确认来源分析卡 → 手动或自动写入内置／外部 vault → 与 Claude CLI 讨论文章 → 编辑与定稿 → 预览 apframework 发布包 → 在界面确认后写入博客仓库 → 验证公开链接。

## 本地启动

需要 Node.js 22.12+，并在本仓库同级目录放置 `open-context-forge-vault-maintainer`、`open-context-article-reader`、`open-context-forge-tech-article-writer` 和 `open-context-forge-article-publisher`。也可分别通过 `OCF_MAINTAINER_ROOT`、`OCF_READER_ROOT`、`OCF_WRITER_ROOT`、`OCF_PUBLISHER_ROOT` 指定它们的绝对路径。

使用 nvm 时先运行 `nvm use`，并确保安装依赖与启动服务使用同一个 Node.js 版本。`better-sqlite3` 是原生模块；切换 Node.js 版本后若出现 `NODE_MODULE_VERSION` 错误，在目标版本下运行 `npm rebuild better-sqlite3`。

```bash
npm install
npm run dev
```

打开 <http://127.0.0.1:5173/>。服务默认只监听 `127.0.0.1:3081`。首次启动会在 `~/Library/Application Support/Open Context Forge/vaults/default` 初始化内置默认 vault；设置 `OCF_DATA_DIR` 可更改应用数据目录。资料处理台的“修改规则”或“采集设置 → 设置”可选择先放待整理或自动入库，并指定目标 vault。自动入库在后台执行；不完整或失败项保留在待整理中。点击“导入资料”可在弹窗中拖拽或选择多个 Markdown、HTML、TXT、ZIP 文件；普通 ZIP 会识别其中的多篇文本，Clipper ZIP 继续按 `captures.json` 校验。单个文本及 ZIP 展开的文本总量上限为 8 MiB，ZIP 文件上限为 20 MiB、最多导入 200 篇。未识别的 ZIP 文件会跳过并显示数量。本地文件保留文件名，不伪造网页 URL，归属默认记为未知。浏览器一键采集插件尚未接入。添加普通 Obsidian 目录时，界面会先展示将新增的 OCF 文件，再等待明确确认。

“待整理”显示跨批次的全部未入库资料；“最近处理”显示最近 7 天已入库或已搁置资料；“全部资料”保留完整导入记录。时间窗口只影响显示，不自动删除。支持按标题、文件名或来源 URL 搜索、筛选、分页、当前页或全部筛选结果的选择、批量入库／分析／搁置／移入回收站。回收站可恢复或永久删除未入库的资料记录。

## 知识库工作区

侧栏“知识库”是只读的浏览工作区。概览同时显示各库刚入库的来源、最近修改的原有 Markdown 笔记、内容数量与读取异常；选中单库后还能查看 vault profile 指定的人工索引文件。浏览页按库、目录、类型、分析状态筛选，搜索标题、路径和正文，并查看 Markdown、来源分析卡、出链和反向链接。图谱只绘制可解析的 wikilink、相对 Markdown 链接和来源引用；无法解析或存在歧义的链接列在下方，不会生成推测关系。

“设置 → 知识库连接”用于连接已有 Obsidian 目录、设置默认入库目标、重新索引和断开外部库。连接普通目录前会显示新增 OCF 文件的预览；断开仅移除平台登记与可重建索引，原目录文件不删除。网页不会写回原有笔记；可复制路径或从详情跳到 Obsidian 编辑。外部修改由文件监听防抖后重建索引，页面停留期间约每 10 秒刷新；若文件监听失效，再次读取也会触发刷新，还可点“重新索引”。SQLite 中的搜索与关系数据可从 Markdown 和来源 manifest 重建。

发布到博客前，设置 `OCF_BLOG_ROOT` 为本机 `apframework.com` Git 仓库的绝对路径。发布动作从远端 `main` 建立隔离 worktree，构建通过后推送；原博客工作目录中的未提交修改不参与发布。公开页面验证默认只接受 `https://apframework.com`，开发或测试可通过 `OCF_BLOG_PUBLIC_ORIGIN` 覆盖。未配置博客仓库时仍可导入、写作和生成本地发布包。

## AI 辅助与写作对话

文章工作台可先创建空稿再写正文；标题、公开摘要和发布日期在定稿前补齐。左侧列表可搜索、按“新建 / 写作中 / 已完成 / 待发布 / 已发布”筛选并切换多篇文章，每篇文章有独立的可收起 AI 写作对话。资料与分析页通过分析卡使用 AI，知识库、设置、预览与发布页不显示对话。文章对话中可选择智能体方案。服务会自动从 `PATH`、`~/.local/bin/claude` 等位置寻找 Claude CLI；如需指定路径，启动前设置 `OCF_CLAUDE_PATH`。默认方案使用本机 Claude CLI 当前登录。提问使用已保存的正文；编辑器自动保存完成前，输入框会暂时禁用。回答保存为文章对应的讨论记录，仅供审阅，不会自动修改正文或知识库。

服务以 `claude -p --safe-mode` 非交互运行。`--safe-mode` 不加载用户的 Claude hooks、skills、插件等自定义配置，因此不需要安装 iTerm2 Claude Code Integration，也不会执行它写入 `~/.claude/settings.json` 的 `cc-status` hook；当前 CLI 登录仍可使用。来源分析所需的 `open-context-article-reader` 规则由服务单独读取，不依赖 CLI 自动发现 skill。此说明以本机 Claude Code 2.1.303 的 CLI 帮助和官方 CLI 文档为准。

资料在入库前后均可点击“生成分析卡”。点击后本机服务立即接收后台任务，单篇与批量任务排队执行；切换页面不会中断任务，页面会显示排队、分析中、完成或失败状态。任务记录保存在 SQLite，服务重启后会重新执行未完成的任务；回到资料页会恢复视图和展开的资料，并读取已完成的卡片。服务使用 `open-context-article-reader` 的阅读规则和本机 Claude CLI 分析资料，逐条校验模型给出的行号证据；提案先保存在本地数据库。“确认分析卡”与“入库”是独立动作：未入库卡片确认后暂存在平台，入库时才写入目标 vault 的 `.ocf/compilations/<fingerprint>/analysis.md`；已入库卡片确认后立即写入。当前单次分析限制来源快照不超过 40,000 字节；更长资料需要后续分段分析。已确认的卡不会因再次点击分析而被覆盖。

可选方案在启动服务前通过环境变量配置：`OCF_DEEPSEEK_API_KEY` 启用 Claude CLI + DeepSeek，`OCF_ANTHROPIC_API_KEY` 启用单独的 Claude API Key。页面只显示方案状态，不显示密钥。当前已用本机 Claude CLI 验证；DeepSeek 方案仍需在提供密钥后单独联调。DeepSeek Harness 不在本阶段范围内。

```bash
npm test
npm run typecheck
npm run build
npm run test:e2e
```

端到端测试使用本机安装的 Chrome、临时应用数据目录和临时外部 vault；不会推送真实博客。

2026-10-23 已用 `apframework.com` 的 `origin/main` 临时副本验证渠道兼容性：现有发布器生成的样例 MDX 被 Contentlayer 收录，`yarn install --immutable` 与完整 `yarn build` 通过，静态页面生成于 `/blog/essay/2026-10-23-ocf-build-compat-check`。博客构建会向 Google Fonts 下载字体，因此构建环境需要能访问该服务。此检查没有修改或推送真实博客仓库。

## 当前范围

这一阶段已完成单篇资料到博客的可操作链路，并加入资料处理台、批量生成分析卡、Claude CLI 文章讨论、单篇来源分析卡与多文章工作台。浏览器插件入口仍待接入；多资料智能体讨论暂不改动。双 vault 联合证据、建议差异确认、定时发布、ACP 适配、公众号导入包和 SaaS 部署按 [产品设计](docs/superpowers/specs/2026-10-22-open-context-forge-v1-design.md) 与 [多文章及渠道任务设计](docs/superpowers/specs/2026-10-23-writing-and-delivery-design.md) 分阶段接入。发布状态区分“本地包已准备”“已写入并推送”“公开链接已验证”。
