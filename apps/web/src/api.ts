import type { CaptureCandidate } from "@ocf/contracts";

export interface Vault {
  id: string;
  path: string;
  kind: "built-in" | "external";
  isDefault: boolean;
}
export interface VaultList { defaultVaultId: string; vaults: Vault[] }
export interface ImportBatch { batchId: string; candidates: (Omit<CaptureCandidate, "status"> & { status: "ready" | "incomplete" | "imported" | "failed"; errorCode?: string })[] }
export interface SourceRef { vaultId: string; snapshot: string }
export interface Article {
  id: string; title: string; summary: string; date: string; sourceRef: SourceRef;
  revision: number; status: "draft" | "final"; markdown: string;
}
export interface Publication {
  id: string; articleId: string; revision: number; slug: string;
  status: "prepared" | "written-to-repository" | "deployment-pending" | "live" | "stale";
  articlePath: string; sourceSha256: string; assets: string[]; mdx: string;
  errorCode?: string; commitSha?: string; publicUrl?: string;
}

const errorMessages: Record<string, string> = {
  ARCHIVE_TOO_LARGE: "ZIP 文件超过 20 MiB，请拆分后导入",
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
  REVISION_CONFLICT: "文章已被其他修改更新，请重新载入后再保存",
  ARTICLE_NOT_FINAL: "请先定稿文章",
  PUBLISHER_FAILED: "本地发布包生成失败，请检查文章与图片",
  BLOG_NOT_CONFIGURED: "尚未配置 apframework 博客仓库路径",
  BLOG_BUILD_FAILED: "博客隔离构建失败，远端仓库未推送",
  BLOG_DIFF_UNEXPECTED: "博客构建产生了预期外文件，已停止发布",
  BLOG_PUSH_FAILED: "博客提交已保存，但推送失败，可重试",
  VERIFY_FAILED: "公开页面尚未显示定稿内容，请稍后重试",
  INVALID_PUBLIC_URL: "公开链接或排版确认无效",
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
