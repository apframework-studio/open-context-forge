export type WorkspaceArea = "资料与分析" | "知识库" | "文章工作台" | "预览与发布";

export interface CaptureCandidate {
  id: string;
  title: string;
  originalUrl: string;
  author?: string;
  note?: string;
  capturedAt: string;
  markdown: string;
  contentHash: string;
  warnings: string[];
  status: "ready" | "incomplete";
}
