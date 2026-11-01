import { extname } from "node:path";
import { htmlToMarkdown } from "../import/local-files.js";

export type DocumentFormat = "markdown" | "mdx" | "text" | "html" | "pdf";
const formats: Record<string, DocumentFormat> = {
  ".md": "markdown", ".markdown": "markdown", ".mdown": "markdown", ".mdx": "mdx",
  ".txt": "text", ".text": "text", ".html": "html", ".htm": "html", ".pdf": "pdf",
};
export function documentFormat(path: string): DocumentFormat | null { return formats[extname(path).toLowerCase()] ?? null; }
export function documentText(path: string, text: string): string {
  return documentFormat(path) === "html" ? htmlToMarkdown(text).markdown : text;
}
