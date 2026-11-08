import type { Article, PublishChannelId } from "../api";

export function buildChannelSuggestion(article: Pick<Article, "title" | "summary" | "markdown">,
  channel: PublishChannelId, currentExtra: string): { text: string; extra: string } {
  const title = article.title.trim();
  const summary = article.summary.trim();
  let fenced = false;
  const headings: string[] = [], prose: string[] = [];
  for (const raw of article.markdown.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced || !line) continue;
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const value = heading[2].replace(/[*_`]/g, "").trim();
      if (heading[1].length > 1 && value && value !== title) headings.push(value);
      continue;
    }
    const plain = line.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/^[>*+-]\s*/, "").replace(/[*_`]/g, "").trim();
    if (plain) prose.push(plain);
  }
  const body = prose[0]?.slice(0, 280) ?? "";
  const parts = [channel === "weibo" ? `【${title}】` : title, summary];
  if (body && !summary.includes(body) && !body.includes(summary)) parts.push(body);
  return { text: parts.filter(Boolean).join(channel === "weibo" ? "\n" : "\n\n"),
    extra: currentExtra || (channel === "jike" ? headings.length ? `你在「${headings[0]}」上有哪些经验？` : "你有类似经验吗？" : "") };
}
