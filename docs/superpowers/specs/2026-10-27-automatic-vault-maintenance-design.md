# 入库后自动知识编译设计

日期：2026-10-27  
状态：待用户复核书面设计（方案已在对话中确认）

## 背景与已确认决定

当前“自动直接入库”仅在 `fileCapture` 中调用 maintainer 仓库的 `import-markdown.js`，生成 raw 快照。资料页的“分析卡”按钮把任务送入 `AnalysisJobs`，由 `open-context-article-reader` 生成平台内的来源分析卡。入库成功不会自动排分析任务，也不会调用 `open-context-forge-vault-maintainer` 编译 wiki。当前 `AnalysisJobs` 只串行处理其自己的分析任务，不能与另一个独立队列共同保证单 CLI 并发。

本轮决定：

- 每个 vault 单独开启或关闭“自动维护”，默认关闭。
- 启用后，成功入库即触发同一来源在该 vault 的自动分析与知识编译；`compile_now` 且校验通过时直接写入长期笔记，无逐篇确认门。
- 来源分析与知识编译在本机全局串行执行，同一时刻只有一个来源处理 CLI 任务；不为每篇文章并发启动智能体。
- `defer`、`keep_raw_only`、`ask_user` 保存分析卡和计划，不强行生成 wiki。歧义、冲突或校验失败保留可检查状态。
- 启用设置不自动批量补跑历史来源；资料页提供单篇/批量补跑与失败重试。

这项决定替代 `2026-10-22-open-context-forge-v1-design.md` 中“知识笔记提案经用户确认后写入”的默认规则，范围仅限已开启自动维护的 vault。未启用的 vault 沿用当前入库与手动分析行为。

## 范围

包括：入库触发、持久串行队列、读取并执行 vault-maintainer skill 的分析/计划/编译流程、受控写回、状态与重试界面、针对性验证、重启恢复。

不包括：自动发布文章、修改 raw 快照、删除已有笔记、跨 vault 合并知识、外网补充事实、自动批量处理既有全部 raw、改变文章写作 Agent 的交互方式。

## 用户流程

1. 在“设置 → 知识库连接”对某个 vault 打开“入库后自动维护”。界面显示当前 CLI 是否可用，并说明该设置会在 `compile_now` 时直接写入该 vault 的知识笔记。
2. 用户手动入库，或导入策略自动入库；只有来源快照及 manifest 落盘且指纹核验成功，才创建维护任务。任务按 `vault_id + source_fingerprint` 去重。导入回复无需等待智能体。
3. “资料与分析”显示任务阶段：`排队 → 分析 → 查重与计划 → 编译写入 → 校验 → 已完成`，以及 `已跳过 / 需处理 / 失败`。页面切换不停止任务。
4. 已完成任务可打开来源分析卡、编译计划、创建/更新的笔记和校验报告。失败任务可重试；没有自动补跑历史资料，但用户可以选中已入库来源提交补跑。
5. 同一来源进入多个 vault 时，各 vault 有自己的开关和任务；同一 vault 的同一快照只自动编译一次。来源内容变化产生新指纹和新任务。

## 组件与数据流

```text
fileCapture 成功写入 import_item_vaults
  → 根据 vault.auto_maintain 入持久任务
  → 全局 Source CLI Worker（并发数 = 1）
      → 核对 vault profile / manifest / raw 指纹
      → 读取 vault-maintainer SKILL.md 与当前 vault 用途
      → source-context + vault-query + 相关已有笔记
      → Agent 生成 Analysis Card
      → Agent 生成 Compilation Plan
      → 若 compile_now：Agent 生成结构化文件变更
      → 服务端校验并写回 selected vault
      → check-notes + check-vault + 语义结果记录
  → 状态与文件清单在资料页展示；知识库索引刷新
```

### 入库与任务登记

- 在现有 `fileCapture` 成功插入 `import_item_vaults` 的路径登记任务，涵盖手动入库、自动入库及向第二个 vault 追加。任务登记和 membership 在同一 SQLite 事务中完成；不在导入请求内等待 CLI。
- 新的 `vaults.auto_maintain` 字段默认 `0`，设置 API 只接受已登记且可写的 vault。关闭开关阻止后续自动入队，不取消已经开始的任务；尚在排队的任务可以在界面取消。
- 任务以 `(vault_id, fingerprint)` 为幂等键，并保存 snapshot、batch/capture 来源、模式、阶段、状态、时间、尝试次数、错误码和结果文件清单。已完成/已跳过不会因重复导入自动重跑；显式重试保留历史尝试记录。
- 对 raw 大小、缺失正文、CLI 不可用等情况记录明确失败或需处理状态；不把 raw 入库失败误报为维护任务失败。

### 单 CLI 串行调度

- 扩展当前 `AnalysisJobs` 调度为统一的来源任务队列：手动“分析卡”与自动维护共用一个 worker，不并行启动两个队列。现有已持久化的分析任务迁移为 `analysis_only`，保留原接口行为。
- 自动维护任务模式为 `maintain`。同一任务分阶段推进并保存检查点；每个 Agent 调用完成后才允许下一次 CLI 调用。来源任务的 CLI 全局并发恒为 1；文章页的交互式对话不进入这条后台队列。
- 服务重启时，将纯分析/计划阶段的中断任务恢复为排队；若已进入写入阶段，先依据文件版本和写入日志核对结果，再决定续跑或标记 `needs_attention`，绝不盲目重复写入。
- CLI 使用现有可用的 `claude-current` 配置，保持单一执行角色。不可用时任务保留为可恢复的阻塞状态，不循环失败。执行时间上限按阶段设置，前端持续展示阶段与最近更新时间。

### 智能体执行 skill

- 从服务端配置的 `maintainerRoot` 读取真实 `SKILL.md` 和所需 references；不依赖用户在提示词中手写 skill 路径。加载失败时任务明确失败，且不写 vault。
- 服务端用 maintainer 脚本取得 source fingerprint、分段与有界证据，用 `vault-query.js` 取得候选，再读取相关现有笔记；Agent 负责语义判断、查重、分析卡、计划及笔记内容。来源正文明确标成不可信数据，不能充当任务指令。
- 保留三个独立阶段：分析卡先写到 `.ocf/compilations/<fingerprint>/analysis.md`；计划写到同目录 `plan.md`；只有计划为 `compile_now` 且证据足够才进入 wiki 写回。平台现有分析卡投影同步展示本次分析结果，避免 vault 已分析却仍显示“未分析”。
- Agent 输出结构化变更：创建/更新/跳过的相对路径、笔记类型、目标当前哈希、完整拟写内容、每项对应的证据 ID 和原因。服务端负责文件操作；Agent 不获得任意 shell 写权限。只读查询与模型判断仍按 skill 的流程进行。
- 同义笔记、矛盾主张或不明确的目录约定无法安全自动解决时，Agent 返回 `ask_user` 或标记冲突；不制造重复笔记，也不覆盖相反观点。

### 写回与验证

- 写入前重验 raw 指纹、manifest、vault profile、目标绝对路径与符号链接。允许的长期写入位置限定为该 vault profile 的 wiki 目录以及已经存在的 index/log 惯例文件；过程文件限定 `.ocf/compilations/<fingerprint>/`。raw 和其他 vault 的路径不可写。
- 对新笔记要求目标不存在；对修改笔记要求拟改内容的 base hash 与当前文件一致。所有变更先完成语法、路径、来源行号、链接与内容大小预检，再按文件原子替换。若外部编辑造成 hash 冲突，标记 `needs_attention` 并保留方案，不重试覆盖。
- 标准 vault 更新 `wiki/index.md` 并追加 `wiki/log.md`；已接入的旧 vault 只按其现有索引与日志惯例更新。每篇来源的长期笔记数量由分析计划决定，不固定拆分数量。
- 新增/修改的笔记逐一运行 `check-notes.js --note`，并运行 `check-vault.js`。记录写前/写后全库问题差异：本轮引入的新错误使任务失败；既有警告保留在报告中，不静默归零。Agent 还要记录证据支持范围与未独立核验的作者陈述。
- 写回阶段保留内容、base hash 与目标文件清单；发生部分写入或验证失败时停止自动重试并进入 `needs_attention`。不自动回滚已被用户进一步编辑的文件。成功后刷新知识索引及图谱，不依赖页面手动重扫。

## API 与界面

- `GET/PUT /api/v1/vaults/:id/maintenance-policy`：读取与设置 `enabled`；响应包含 CLI 可用性。
- `GET /api/v1/maintenance/jobs`：按 vault、来源和状态查询最近任务；返回阶段、错误、结果文件与校验摘要。
- `POST /api/v1/maintenance/jobs`：对已入库来源显式补跑；`POST /api/v1/maintenance/jobs/:id/retry` 重试失败或需处理任务；同一活动任务去重。
- 原 `POST /api/v1/analysis/jobs` 及资料页分析卡按钮继续可用，但进入同一串行调度器。
- 资料页行内和详情显示维护状态、错误、写入文件链接；设置页显示开关与全局串行处理说明。API 错误码用于 UI，而不是只显示 CLI stderr。

## 验收场景

1. 一个 vault 开启、另一个关闭：同一来源分别入库，只为已开启 vault 自动创建任务。
2. 手动与自动入库均能触发；导入响应先返回，CLI 后台完成。重复导入不重复编译；新内容指纹创建新任务。
3. 连续导入多篇，测试 runner 证明同时最多一个 CLI 调用；手动分析任务也遵守同一限制。
4. `compile_now` 产生分析卡、计划、可追溯 wiki 笔记、索引/日志、校验结果；资料页与知识库索引均能看到。
5. `defer`、`keep_raw_only`、`ask_user` 只保留分析/计划，不生成 wiki 笔记。
6. CLI 不可用、超时、返回无效结构、来源变更、同义冲突、外部笔记编辑和校验新增错误都留下明确状态，不覆盖 raw 或用户文件。
7. 服务重启后继续安全的排队任务；中断写入不会自动重复覆盖。单篇失败不阻塞其他排队来源。

## 实现边界

本设计优先复用现有 `fileCapture`、`AnalysisJobs`、`AnalysisService`、vault registry、maintainer CLI 和知识索引。新增代码应集中在来源任务调度与编译写回服务，不把编译逻辑塞进路由或文章写作 Agent。现有未提交的其他功能改动须保留，不纳入本功能的提交。
