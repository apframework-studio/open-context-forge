---
type: source_compilation_plan
source: 10-raw/public-blog/Scaling-AI-Native-Analytics-Patterns-at-Meta-4bd474707e29a425f1826c5f465c9987882dca4857bc04713cf9151de03753aa.md
analysis: workspace/knowledge-ops/compilations/meta-ai-native-analytics/analysis.md
source_fingerprint: 4bd474707e29a425f1826c5f465c9987882dca4857bc04713cf9151de03753aa
title: Scaling AI-Native Analytics Patterns at Meta
status: approved
planned_at: 2026-10-27
planner: Codex
target_wiki_notes:
  source_summaries: [2026-10-27-meta-ai-native-analytics-summary]
  concepts: []
  claims: []
  frameworks: [ai-native-analytics-governed-pattern-loop]
  style_notes: []
updates:
  existing_notes: [semantic-layer-enterprise, deterministic-execution-shell, latent-space-deterministic-separation-improves-agent-reliability]
  index: true
  knowledge_map: true
  backlog: true
  log: true
requires_user_review: false
full_raw_read: false
---

# Meta AI-Native Analytics — Compilation Plan

## Decision

Compile. 这篇 Meta 工程实践直接支持 vault 的 Agent 可靠性与可计算语义主线，并提供明确适用边界。复用已有概念和判断，只为分析生产/消费链路新增独立框架。

## Evidence Inputs

- Analysis card: `analysis.md`；fingerprint `4bd474707e29a425f1826c5f465c9987882dca4857bc04713cf9151de03753aa`。
- Evidence slices: E1 L38-L42、E2 L47-L57、E3 L62-L72、E4 L79-L89、E5 L98-L107、E6 L118-L123。
- Source analysis 阶段已按区间通读 raw；本阶段只复用卡片中的 bounded findings。

## Source Summary Plan

- File: `20-wiki/source-summaries/2026-10-27-meta-ai-native-analytics-summary.md`。
- Thesis: 稳定的分析模式 + 受治理的参数化库 + Agent 可读模型 + 确定性查询工具，支持 Agent 从管道生产到分析消费。
- Derived pages: existing `semantic-layer-enterprise`、`deterministic-execution-shell`、`latent-space-deterministic-separation-improves-agent-reliability`；new `ai-native-analytics-governed-pattern-loop`。

## New Notes To Create

- Framework: `20-wiki/frameworks/ai-native-analytics-governed-pattern-loop.md`。现有 Semantic Layer note 是宽泛语义定义，Deterministic Execution Shell 是工具分工；均不覆盖本来源的指标管道—模型—查询—分析—展示闭环。框架以 E2/E3/E5/E6 为证据，明确适用于高复用、高信任的产品分析，探索性任务和维护成本是限制。

## Existing Notes To Update

- `semantic-layer-enterprise`：加入 Meta 的指标维度/数据源 YML 模型作为查询语义案例，E4/E5；避免宣称此模型包含行动权限。
- `deterministic-execution-shell`：加入 Agent 调用确定性查询 CLI、数据源选择规则的案例，E5。
- `latent-space-deterministic-separation-improves-agent-reliability`：新增来源与 evidence，E5；保留原有反例和边界。

## Notes To Skip

- 新 concept：受治理指标模型可由现有 `semantic-layer-enterprise` 承载。
- 新 claim：模型/代码分工已有同义 claim；标准化范围作为 framework 限制。
- Style note：本文的排版与图示没有足够独特、可迁移的写作模式。
- 七个模式的名称：raw 只含图片，不能从文字可靠提取。

## System Files To Update

- `00-system/index.md`：增设本来源编译入口。
- `20-wiki/knowledge-map.md`：在 Enterprise Semantic Layer 主线加入分析链路案例和 framework。
- `00-system/source-compilation-backlog.md`：记录此来源 `compiled` 与产物。
- `00-system/log.md`：追加本轮维护记录。

## Validation Checklist

- [ ] raw 保持原样，fingerprint 一致。
- [ ] Source summary 链到 raw，`derived_pages` 与实际更新一致。
- [ ] Framework 有 `sources`、`applies_to` 和 limits；现有笔记补 evidence 行区间。
- [ ] Index、knowledge map、backlog、log 一致。
- [ ] Lint 与 health check 检查新增错误。
- [ ] Git checkpoint 仅涉及本来源的变更，绝不包含 vault 中已有的其他未提交改动。
