export function readingMarkdown(item: { kind: "source" | "note"; title: string; markdown: string }): string {
  if (item.kind !== "source") return item.markdown;
  const wrapper = /^# ([^\r\n]+)\r?\n\r?\n(?:- (?:来源|抓取时间|作者|Clipper 内容指纹)：[^\r\n]*\r?\n){2,}\r?\n---\r?\n\r?\n/;
  const match = item.markdown.match(wrapper);
  return match && match[1].trim() === item.title.trim() ? item.markdown.slice(match[0].length) : item.markdown;
}
