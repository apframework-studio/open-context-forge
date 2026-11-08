import type { Article } from "../api";

function lines(markdown: string): string[] {
  let fenced = false;
  return markdown.split(/\r?\n/).flatMap((raw) => {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) { fenced = !fenced; return []; }
    return !fenced && line ? [line] : [];
  });
}

function headings(markdown: string): string[] {
  return lines(markdown).filter((line) => /^#{1,6}\s+/.test(line)).map((line) => line.replace(/^#{1,6}\s+/, "").replace(/[*_`]/g, "")).slice(0, 8);
}

export function buildImagePrompt(article: Pick<Article, "title" | "summary" | "markdown">, outline = ""): string {
  const title = article.title.trim();
  const summary = article.summary.trim();
  const topics = [...new Set([...headings(article.markdown), ...headings(outline)].filter((heading) => heading !== title))].slice(0, 8);
  const outlinePoints = lines(outline).filter((line) => /^[-*+]\s+|^\d+[.)]\s+/.test(line))
    .map((line) => line.replace(/^([-*+]\s+|\d+[.)]\s+)/, "").replace(/[*_`]/g, "")).slice(0, 5);
  const body = lines(article.markdown).filter((line) => !/^#{1,6}\s+|^```|^---$/.test(line)).join(" ").slice(0, 240);
  const parts = ["请制作一张适合社交渠道分享的文章封面图。", `主题：${title || "当前文章"}。`];
  if (summary) parts.push(`核心内容：${summary}。`);
  if (topics.length) parts.push(`文章结构：${topics.join("；")}。`);
  if (outlinePoints.length) parts.push(`大纲要点：${outlinePoints.join("；")}。`);
  if (body) parts.push(`正文线索：${body}。`);
  parts.push("画面围绕上述主题选择具体视觉元素，层次清晰，留出标题空间。避免添加文章未提到的事实、数据或人物。");
  return parts.join("\n").slice(0, 4000);
}
