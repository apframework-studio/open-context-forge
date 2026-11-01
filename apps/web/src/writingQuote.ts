// Rendered Markdown may differ from source text. Never guess a source location.
export function quoteRangeForText(markdown: string, text: string): { startLine: number; endLine: number } | null {
  if (!text.trim()) return null;
  const offset = markdown.indexOf(text);
  if (offset < 0 || markdown.indexOf(text, offset + 1) >= 0) return null;
  const startLine = markdown.slice(0, offset).split("\n").length;
  return { startLine, endLine: startLine + text.split("\n").length - 1 };
}

export function validQuoteRange(start: number | string, end: number | string, lineCount: number): boolean {
  return typeof start === "number" && typeof end === "number" && Number.isInteger(start) && Number.isInteger(end)
    && start >= 1 && end >= start && end <= lineCount;
}
