import type { CaptureCandidate } from "@ocf/contracts";

export interface Vault {
  id: string;
  path: string;
  kind: "built-in" | "external";
  isDefault: boolean;
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
}
export interface ImportItemsPage {
  total: number; page: number; pageSize: number;
  counts: { pending: number; recent: number; all: number; trash: number; autoQueued: number };
  items: ImportItem[];
}
export interface ImportPolicy { mode: "manual" | "auto-file"; vaultId: string | null }
export interface VaultSource {
  fingerprint: string; snapshot: string; title: string; originalUrl: string | null;
  importedAt: string | null; authorship: string; author: string | null; analysisStatus: "proposed" | "confirmed" | null;
}
export interface VaultSourcesPage { total: number; page: number; pageSize: number; items: VaultSource[] }
export interface KnowledgeItem {
  vaultId: string; path: string; kind: "source" | "note"; title: string; modifiedAt: string;
  importedAt: string | null; fingerprint: string | null; originalUrl: string | null;
  analysisStatus: "proposed" | "confirmed" | null; folder: string; snippet?: string;
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
export interface Article {
  id: string; title: string; summary: string; date: string; sourceRef: SourceRef | null;
  revision: number; status: "draft" | "final"; markdown: string;
}
export interface ArticleListItem extends Omit<Article, "markdown"> {
  stage: "new" | "writing" | "complete" | "pending_publish" | "published";
  updatedAt: string; publicationId: string | null;
}
export interface ArticleList { items: ArticleListItem[] }
export interface Publication {
  id: string; articleId: string; revision: number; slug: string;
  status: "prepared" | "written-to-repository" | "deployment-pending" | "live" | "stale";
  articlePath: string; sourceSha256: string; assets: string[]; mdx: string;
  errorCode?: string; commitSha?: string; publicUrl?: string;
}
export interface AgentProfile { id: string; label: string; description: string; available: boolean; reason?: string }
export interface AgentMessage { id: string; role: "user" | "assistant"; content: string; createdAt: string }
export interface AgentHistory { profileId: string; messages: AgentMessage[] }

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
  REVISION_CONFLICT: "文章已被其他修改更新，请重新载入后再保存",
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
  AGENT_AUTH_REQUIRED: "Claude CLI 需要重新登录",
  AGENT_START_FAILED: "无法启动 Claude CLI，请检查本机安装",
  AGENT_RESPONSE_INVALID: "智能体返回了无法识别的内容",
  AGENT_RUN_FAILED: "智能体调用失败，请检查 Claude CLI 状态",
  ANALYSIS_NOT_FOUND: "尚未生成来源分析卡",
  ANALYSIS_RESPONSE_INVALID: "智能体返回的分析格式无效，请重试",
  ANALYSIS_EVIDENCE_INVALID: "智能体给出的证据无法对应原文，请重试",
  SOURCE_CHANGED: "来源快照与导入记录不一致，请核对来源",
  SOURCE_TOO_LARGE_FOR_ANALYSIS: "这篇来源超过当前单次分析长度，请等待分段分析功能",
  ANALYSIS_BUSY: "这篇来源正在分析，请稍候",
  INVALID_ANALYSIS_JOB: "分析任务资料无效，请重新选择",
  UNEXPECTED_ERROR: "分析任务异常中断",
  ANALYSIS_ALREADY_EXISTS: "知识库中已有分析文件，请先检查现有内容",
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

export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = options.method ?? "GET";
  const isForm = options.body instanceof FormData;
  const response = await fetch(`/api/v1${path}`, {
    method,
    headers: {
      ...(method !== "GET" ? { "x-ocf-client": "1" } : {}),
      ...(options.body !== undefined && !isForm ? { "content-type": "application/json" } : {}),
    },
    ...(options.body !== undefined ? { body: options.body instanceof FormData ? options.body : JSON.stringify(options.body) } : {}),
  });
  const payload = await response.json();
  if (!response.ok) throw new ApiError(response.status, payload.error ?? "REQUEST_FAILED", payload.plannedChanges);
  return payload as T;
}
