import { parseDocument, stringify } from "yaml";

type ReadingItem = { kind: "source" | "note"; title: string; markdown: string };
export interface ReadingProperty { name: string; values: string[] }

export function readingMarkdown(item: ReadingItem): string {
  if (item.kind !== "source") return item.markdown;
  const wrapper = /^# ([^\r\n]+)\r?\n\r?\n(?:- (?:来源|抓取时间|作者|Clipper 内容指纹)：[^\r\n]*\r?\n){2,}\r?\n---\r?\n\r?\n/;
  const match = item.markdown.match(wrapper);
  return match && match[1].trim() === item.title.trim() ? item.markdown.slice(match[0].length) : item.markdown;
}

export function readingDocument(item: ReadingItem): {
  body: string; properties: ReadingProperty[]; rawProperties: string | null; error: string | null;
} {
  const body = readingMarkdown(item);
  const empty = { body, properties: [], rawProperties: null, error: null };
  const match = body.match(/^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/);
  // Ordinary horizontal rules and code examples are part of the document.
  if (!match || !/^[\w\p{L}][^\r\n]*:/mu.test(match[1])) return empty;
  const result = { body: body.slice(match[0].length).replace(/^\s*\r?\n/, ""), properties: [] as ReadingProperty[],
    rawProperties: match[1], error: null as string | null };
  try {
    if (match[1].length > 65_536) throw new Error("Properties too large");
    const document = parseDocument(match[1], { schema: "core" });
    if (document.errors.length) throw new Error("Invalid properties");
    const value: unknown = document.toJS({ maxAliasCount: 0 });
    if (!value || typeof value !== "object" || Array.isArray(value)) return empty;
    const display = (value: unknown): string => value === null ? "—" : typeof value === "object" ? stringify(value).trim() : String(value);
    result.properties = Object.entries(value).map(([name, value]) => ({ name,
      values: Array.isArray(value) ? value.map(display) : [display(value)] }));
  } catch {
    result.error = "属性格式暂时无法解析，可展开查看原始 YAML；正文仍可正常阅读。";
  }
  return result;
}
