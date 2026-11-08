export type WorkspaceArea = "资料与分析" | "知识库" | "文章工作台" | "发布中心";

export interface AuthorEvidence {
  value: string;
  kind: "clipper" | "frontmatter" | "html_meta" | "json_ld" | "byline";
  location: string;
}

export interface CaptureCandidate {
  id: string;
  title: string;
  originalUrl: string | null;
  sourceFilename?: string;
  author?: string;
  authorEvidence?: AuthorEvidence;
  authorship?: "self" | "third_party" | "unknown";
  authorshipOverridden?: boolean;
  note?: string;
  capturedAt: string;
  markdown: string;
  contentHash: string;
  warnings: string[];
  status: "ready" | "incomplete";
}
export type * from "./writing.js";
