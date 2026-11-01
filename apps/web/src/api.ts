import type { CaptureCandidate, WritingTurnContext } from "@ocf/contracts";
export type { WritingMaterialRef, WritingMaterial, WritingMaterialDetail, WritingSelection, WritingContext,
  WritingTurnSource, WritingTurnContext, WritingOutline, WriterSkillStatus, WritingProposal, WritingProposals } from "@ocf/contracts";

export interface Vault {
  id: string;
  path: string;
  kind: "built-in" | "external";
  isDefault: boolean;
  autoMaintain: boolean;
}
export interface VaultList { defaultVaultId: string; vaults: Vault[] }
export interface BrandingStatus { customized: boolean; revision: string | null }
export interface ImportBatch { batchId: string; skippedFiles?: number; candidates: (Omit<CaptureCandidate, "status"> & { status: "ready" | "processing" | "incomplete" | "imported" | "failed"; errorCode?: string;
  vaultId?: string; snapshot?: string; fingerprint?: string;
  vaults?: ImportVaultMembership[] })[] }
export interface ImportVaultMembership { vaultId: string; snapshot: string; fingerprint: string; analysisSyncError: boolean }
export interface ImportItem extends Omit<CaptureCandidate, "status"> {
  batchId: string; captureId: string; createdAt: string; processedAt: string | null;
  status: "ready" | "processing" | "incomplete" | "imported" | "failed";
  disposition: "active" | "shelved" | "trashed";
  errorCode: string | null; vaultId: string | null; snapshot: string | null; fingerprint: string | null;
  vaults: ImportVaultMembership[];
  analysisStatus: "proposed" | "confirmed" | null;
  analysisSyncError: boolean;
  autoVaultId: string | null;
  authorship: "self" | "third_party" | "unknown";
  authorOverridden: boolean; authorshipOverridden: boolean; metadataVersion: number;
}
export interface ImportItemsPage {
  total: number; page: number; pageSize: number;
  counts: { pending: number; recent: number; all: number; trash: number; autoQueued: number };
  items: ImportItem[];
}
export interface ImportPolicy { mode: "manual" | "auto-file"; vaultId: string | null;
  defaultAuthorship: "self" | "third_party" | "unknown" }
export interface FilingJob { id: string; batchId: string; captureId: string; vaultId: string;
  status: "queued" | "running" | "retry_wait" | "completed" | "needs_attention" | "cancelled";
  stage: string; attempt: number; errorCode: string | null; nextRetryAt: string | null;
  startedAt: string | null; deadlineAt: string | null;
  result: { vaultId: string; snapshot: string; fingerprint: string; duplicate: boolean; analysisSyncError: boolean } | null }
export interface FilingJobsPage { jobs: FilingJob[] }
export interface AttentionItem { id: string; kind: "filing" | "maintenance" | "analysis" | "metadata" | "lane";
  batchId: string | null; captureId: string | null; vaultId: string | null; title: string;
  stage: string; errorCode: string | null; createdAt: string; result: unknown }
export interface AttentionSummary { count: number; items: AttentionItem[]; reminderDue: boolean }
export interface AttentionDetail extends AttentionItem {
  snapshot: string | null;
  plan: { path: string; markdown: string } | null;
  journal: { path: string; data: unknown } | null;
  targets: string[];
}
export interface VaultSource {
  fingerprint: string; snapshot: string; title: string; originalUrl: string | null;
  importedAt: string | null; authorship: string; author: string | null; analysisStatus: "proposed" | "confirmed" | null;
}
export interface VaultSourcesPage { total: number; page: number; pageSize: number; items: VaultSource[] }
export interface KnowledgeItem {
  vaultId: string; path: string; kind: "source" | "note"; title: string; modifiedAt: string;
  importedAt: string | null; fingerprint: string | null; originalUrl: string | null;
  analysisStatus: "proposed" | "confirmed" | null; folder: string; snippet?: string;
  format?: "markdown" | "mdx" | "text" | "html" | "pdf"; sizeBytes?: number; previewLimited?: boolean;
}
export interface KnowledgeLink { from: string; to: string; type: "wikilink" | "markdown" | "source_metadata"; target: string; line: number }
export interface KnowledgeIssue { from: string; target: string; reason: "missing" | "ambiguous"; line: number }
export interface KnowledgeDetail extends KnowledgeItem { markdown: string; absolutePath: string; authorship: string | null; author: string | null;
  outlinks: KnowledgeLink[]; backlinks: KnowledgeLink[]; issues: KnowledgeIssue[] }
export interface KnowledgePage { total: number; page: number; pageSize: number; items: KnowledgeItem[] }
export interface KnowledgeOverview { vaults: (Vault & { sources: number; notes: number; confirmedAnalyses: number; indexedAt: string; errors: string[]; indexMarkdown: string | null;
  readable: boolean; writable: boolean; watching: boolean })[];
  recentSources: KnowledgeItem[]; recentNotes: KnowledgeItem[] }
export interface KnowledgeGraph { vaultId: string; nodes: KnowledgeItem[]; edges: KnowledgeLink[]; issues: KnowledgeIssue[]; totalNodes: number; truncated: boolean }
export interface SourceRef { vaultId: string; snapshot: string }
export interface SourceAnalysis {
  vaultId: string; snapshot: string; fingerprint: string; status: "proposed" | "confirmed";
  authorship: "self" | "third_party" | "unknown"; author: string | null;
  summary: string; mainPoints: { claim: string; kind: "article_statement" | "inference" | "unknown";
    evidence: { startLine: number; endLine: number; excerpt: string }[] }[];
  limitations: string[]; recommendation: "compile_now" | "defer" | "keep_raw_only" | "ask_user"; reason: string;
}
export interface AnalysisJob {
  id: string; batchId: string; captureId: string;
  status: "queued" | "running" | "completed" | "failed";
  errorCode: string | null; createdAt: string; updatedAt: string;
}
export interface AnalysisJobsPage { jobs: AnalysisJob[] }
export interface MaintenanceJob extends Omit<AnalysisJob, "status"> {
  vaultId: string; fingerprint: string; snapshot: string; stage: string; attempt: number;
  status: "queued" | "running" | "retry_wait" | "completed" | "failed" | "skipped" | "needs_attention" | "blocked" | "cancelled";
  nextRetryAt?: string | null;
  result: { recommendation: string; files: string[]; warnings: string[] } | null;
}
export interface MaintenanceJobsPage { jobs: MaintenanceJob[] }
export interface Article {
  id: string; title: string; summary: string; date: string; sourceRef: SourceRef | null;
  revision: number; status: "draft" | "final"; markdown: string;
}
export interface ArticleListItem extends Omit<Article, "markdown"> {
  stage: "new" | "writing" | "complete" | "pending_publish" | "published";
  updatedAt: string; publicationId: string | null; trashedAt: string | null;
}
export interface ArticleList { items: ArticleListItem[] }
export interface Publication {
  id: string; articleId: string; revision: number; slug: string;
  status: "prepared" | "written-to-repository" | "deployment-pending" | "live" | "stale";
  articlePath: string; sourceSha256: string; assets: string[]; mdx: string;
  errorCode?: string; commitSha?: string; publicUrl?: string;
}
export interface AgentProfile { id: string; label: string; description: string; available: boolean; reason?: string; protocol?: string; capabilities?: string[] }
export interface AgentMessage { id: string; role: "user" | "assistant"; content: string; createdAt: string; context?: WritingTurnContext }
export interface AgentRun {
  id: string; articleId: string; profileId: string; assistantMessageId: string;
  status: "running" | "waiting_permission" | "completed" | "failed" | "cancelled" | "interrupted";
  text: string; activity: string; tools: { id: string; title: string; status: string; detail?: string }[];
  permissions: { id: string; title: string; options: { optionId: string; name: string; kind: string }[] }[];
  errorCode: string | null; createdAt: string; updatedAt: string; seq: number;
  context?: WritingTurnContext;
}
export interface AgentHistory { profileId: string; messages: AgentMessage[]; run?: AgentRun | null; runs?: AgentRun[] }
export const agentActive = (run?: AgentRun | null) => !!run && (run.status === "running" || run.status === "waiting_permission");

const errorMessages: Record<string, string> = {
  ARCHIVE_TOO_LARGE: "上传文件超过 20 MiB，请拆分后导入",
  MANIFEST_TOO_LARGE: "资料清单过大，请拆分后导入",
  INVALID_ZIP: "无法读取 ZIP 文件",
  INVALID_JSON: "ZIP 中的资料清单格式有误",
  INVALID_RECORD: "资料记录缺少必填字段或有重复 ID",
  HASH_MISMATCH: "资料正文与 Clipper 指纹不一致",
  ADOPTION_REQUIRED: "需要确认采用此目录",
  VAULT_EXISTS: "该知识库路径或 ID 已登记",
  INVALID_VAULT: "知识库目录不可用或 OCF 元数据无效",
  INCOMPLETE_SOURCE: "这份资料不完整，暂不能写入知识库",
  VAULT_IMPORT_FAILED: "资料写入知识库失败，可稍后重试",
  ARTICLE_CHECK_FAILED: "文章还有未完成内容或无效图片，请修改后再定稿",
  ARTICLE_METADATA_REQUIRED: "定稿前请填写标题、公开摘要和发布日期",
  ARTICLE_TRASHED: "文章已在回收站，请先恢复",
  ARTICLE_TRASH_CHANGED: "回收站内容已变化，请检查列表后重新确认",
  ARTICLE_BUSY: "文章仍有任务正在运行，请等待完成后再永久删除",
  INVALID_ARTICLE: "文章信息或管理操作无效，请重新选择",
  ARTICLE_NOT_FOUND: "文章不存在，请刷新列表",
  REVISION_CONFLICT: "文章已被其他修改更新，请重新载入后再保存",
  INVALID_WRITING_CONTEXT: "创作资料配置无效，请重新选择知识库与资料",
  INVALID_WRITING_SELECTION: "本轮引用范围已变化，请重新选择资料或引用行",
  WRITING_MATERIAL_NOT_FOUND: "资料快照不存在，请重新选材",
  WRITING_TURN_NOT_FOUND: "这轮对话的来源快照不存在",
  WRITING_CONTEXT_TOO_LARGE: "引用资料过多或文件过大，请缩小本轮资料范围",
  INVALID_WRITING_OUTLINE: "大纲内容无效，请填写内容后再确认",
  ARTICLE_NOT_FINAL: "请先定稿文章",
  PUBLISHER_FAILED: "本地发布包生成失败，请检查文章与图片",
  BLOG_NOT_CONFIGURED: "尚未配置 apframework 博客仓库路径",
  BLOG_BUILD_FAILED: "博客隔离构建失败，远端仓库未推送",
  BLOG_DIFF_UNEXPECTED: "博客构建产生了预期外文件，已停止发布",
  BLOG_PUSH_FAILED: "博客提交已保存，但推送失败，可重试",
  VERIFY_FAILED: "公开页面尚未显示定稿内容，请稍后重试",
  INVALID_PUBLIC_URL: "公开链接或排版确认无效",
  AGENT_PROFILE_NOT_FOUND: "智能体方案不存在",
  AGENT_PROFILE_UNAVAILABLE: "该智能体方案尚未可用",
  INVALID_AGENT_MESSAGE: "请输入 1 至 10000 字的问题",
  AGENT_BUSY: "智能体正在回答，请稍候",
  AGENT_SOURCE_UNAVAILABLE: "来源文件暂时不可读取",
  AGENT_TIMEOUT: "智能体响应超时，可稍后重试",
  AGENT_AUTH_REQUIRED: "当前智能体需要重新登录，请在本机客户端或 CLI 完成登录",
  AGENT_START_FAILED: "无法启动智能体，请检查本机 CLI 安装与路径",
  AGENT_RESPONSE_INVALID: "智能体返回了无法识别的内容",
  AGENT_RUN_FAILED: "智能体调用失败，请检查当前 CLI 的登录、模型及网络状态",
  AGENT_RESUME_UNAVAILABLE: "当前运行器不支持恢复该会话，请检查适配器版本",
  AGENT_RUN_NOT_FOUND: "执行记录不存在，请刷新对话",
  AGENT_PERMISSION_EXPIRED: "该操作已经处理或结束，请查看最新状态",
  INVALID_AGENT_PERMISSION: "所选权限选项无效",
  AGENT_SERVICE_RESTARTED: "本机服务已重启，已有输出已保留，可重新发送",
  AGENT_OUTPUT_TOO_LARGE: "智能体输出超过本轮长度限制，已有内容已保留",
  ANALYSIS_NOT_FOUND: "尚未生成智能摘要",
  ANALYSIS_RESPONSE_INVALID: "智能体返回的分析格式无效，请重试",
  ANALYSIS_EVIDENCE_INVALID: "智能体给出的证据无法对应原文，请重试",
  SOURCE_CHANGED: "来源快照与导入记录不一致，请核对来源",
  SOURCE_TOO_LARGE_FOR_ANALYSIS: "这篇来源超过当前单次分析长度，请等待分段分析功能",
  ANALYSIS_BUSY: "这篇来源正在分析，请稍候",
  INVALID_ANALYSIS_JOB: "分析任务资料无效，请重新选择",
  UNEXPECTED_ERROR: "分析任务异常中断",
  ANALYSIS_ALREADY_EXISTS: "知识库中已有分析文件，请先检查现有内容",
  AGENT_UNAVAILABLE: "未找到可用的 Claude CLI，请配置后重试",
  MAINTENANCE_RESPONSE_INVALID: "知识维护分析格式无效，请重试",
  MAINTENANCE_EVIDENCE_INVALID: "知识维护证据与原文不匹配，请重试",
  MAINTENANCE_PLAN_INVALID: "知识编译计划无效，请重试",
  MAINTENANCE_NOT_RETRYABLE: "此任务目前不能重试",
  MAINTENANCE_NOT_CANCELLABLE: "此任务正在写入或已结束，暂不能取消",
  MAINTENANCE_INSPECTION_REQUIRED: "请先检查写入日志和目标笔记",
  AGENT_PROCESS_STILL_RUNNING: "上次 Claude 进程仍在运行，请等待退出后恢复队列",
  FILING_INSPECTION_REQUIRED: "raw 入库锁仍在，请先检查入库状态",
  SOURCE_METADATA_CHANGED: "来源信息已变化，请刷新后再试",
  SOURCE_METADATA_NOT_SYNCED: "知识笔记校验未通过，请检查来源署名、归属和笔记引用",
  SOURCE_METADATA_CONFLICT: "重复来源的署名或归属不一致，请检查已有记录",
  SOURCE_METADATA_CORRECTION_FAILED: "来源信息修正失败，请检查 vault 锁与 manifest",
  SOURCE_METADATA_CORRECTION_UNCERTAIN: "来源信息写入结果不明，请检查 manifest 与审计记录",
  VAULT_METADATA_DIFFERS: "同一来源在多个知识库的署名或归属不同，请查看来源并逐库核对",
  PARTIAL_METADATA_CORRECTION: "部分知识库已更新，请移除阻塞后用原操作继续",
  SOURCE_TOO_LARGE: "来源超过当前自动分析长度上限",
  BASE_CHANGED: "目标笔记已被修改，未覆盖用户改动",
  NOTE_VALIDATION_FAILED: "生成的笔记未通过知识库校验",
  VAULT_VALIDATION_FAILED: "写入后知识库校验出现新问题",
  EVIDENCE_MISSING: "生成的笔记缺少原文行证据",
  PARTIAL_WRITE: "写入中断，请检查任务日志和目标笔记",
  INVALID_LIST_QUERY: "列表筛选条件无效",
  INVALID_IMPORT_POLICY: "入库规则无效",
  INVALID_IMPORT_ACTION: "当前资料不能执行此操作",
  INVALID_VAULT_SELECTION: "知识库选择无效，请重新选择",
  VAULT_ASSOCIATION_IMMUTABLE: "已入库关联不能在资料与分析中删除，请到知识库处理",
  BUILT_IN_VAULT: "内置知识库不能断开",
  KNOWLEDGE_ITEM_NOT_FOUND: "文件已移走，请重新索引",
  KNOWLEDGE_ITEM_CHANGED: "来源快照已改变，请核对原文",
  INVALID_KNOWLEDGE_PATH: "知识库路径无效",
  INVALID_KNOWLEDGE_QUERY: "知识库筛选条件无效",
  SOURCE_TRASHED: "资料已在回收站，请先恢复",
  SOURCE_BUSY: "资料正在写入知识库，请稍候",
  UNSUPPORTED_FILE: "请选择 Markdown、HTML、纯文本或 ZIP 文件",
  NO_SUPPORTED_FILES: "ZIP 中没有可识别的 Markdown、HTML 或纯文本文件",
  INVALID_TEXT_FILE: "文本文件为空、编码无效或包含不支持的内容",
  TEXT_TOO_LARGE: "文本内容超过 8 MiB，请拆分后导入",
  TOO_MANY_FILES: "ZIP 文件条目过多，请拆分后导入",
  ICON_INVALID: "请选择 32–512 像素的正方形 PNG 图标",
  ICON_TOO_LARGE: "图标文件不能超过 1 MiB",
};

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly plannedChanges?: string[]) {
    super(errorMessages[code] ?? code);
  }
}
export const agentErrorMessage = (code: string) => errorMessages[code] ?? code;

export async function api<T>(path: string, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  const method = options.method ?? "GET";
  const isForm = options.body instanceof FormData;
  const response = await fetch(`/api/v1${path}`, {
    method,
    headers: {
      ...(method !== "GET" ? { "x-ocf-client": "1" } : {}),
      ...(options.body !== undefined && !isForm ? { "content-type": "application/json" } : {}),
      ...(options.headers ?? {}),
    },
    ...(options.body !== undefined ? { body: options.body instanceof FormData ? options.body : JSON.stringify(options.body) } : {}),
  });
  const payload = await response.json();
  if (!response.ok) throw new ApiError(response.status, payload.error ?? "REQUEST_FAILED", payload.plannedChanges);
  return payload as T;
}
