import type { AuthorEvidence } from "@ocf/contracts";

function normalizedName(value: string): string | null {
  const name = value.trim().replace(/^['"]|['"]$/g, "").replace(/\s+/g, " ");
  return name && name.length <= 200 && !/[<>\n\r]|https?:\/\//i.test(name) ? name : null;
}

function names(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(names);
  if (value && typeof value === "object") return names((value as Record<string, unknown>).name);
  if (typeof value !== "string") return [];
  const parts = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1).split(",") : [value];
  return parts.map(normalizedName).filter((item): item is string => !!item);
}

function evidence(value: unknown, kind: AuthorEvidence["kind"], location: string): AuthorEvidence | null {
  const authors = names(value);
  return authors.length ? { value: authors.join("; "), kind, location } : null;
}

function htmlAttributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  const expression = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  for (const match of tag.matchAll(expression)) result[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4];
  return result;
}

function jsonAuthors(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(jsonAuthors);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const type = record["@type"];
  const own = type === "Article" || type === "NewsArticle" || type === "BlogPosting" ? names(record.author) : [];
  return [...own, ...jsonAuthors(record["@graph"])];
}

export function extractLocalAuthor(text: string, kind: "markdown" | "html"): AuthorEvidence | null {
  const found: AuthorEvidence[] = [];
  let body = text.slice(0, 200_000);
  if (kind === "markdown") {
    const frontmatter = /^---\s*\n([\s\S]{0,10000}?)\n---\s*(?:\n|$)/.exec(body);
    if (frontmatter) {
      for (const match of frontmatter[1].matchAll(/^(authors?)\s*:\s*(.+)$/gim)) {
        const item = evidence(match[2], "frontmatter", `frontmatter:${match[1].toLowerCase()}`);
        if (item) found.push(item);
      }
      body = body.slice(frontmatter[0].length);
    }
  } else {
    for (const tag of body.match(/<meta\b[^>]*>/gi) ?? []) {
      const attrs = htmlAttributes(tag);
      if (!["author", "article:author", "parsely-author", "dc.creator"].includes((attrs.name ?? attrs.property ?? "").toLowerCase())) continue;
      const item = evidence(attrs.content, "html_meta", attrs.name ?? attrs.property);
      if (item) found.push(item);
    }
    for (const script of body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
      if (htmlAttributes(script[1]).type?.toLowerCase() !== "application/ld+json") continue;
      try {
        const item = evidence(jsonAuthors(JSON.parse(script[2])), "json_ld", "script:application/ld+json");
        if (item) found.push(item);
      } catch { /* Invalid structured metadata is not author evidence. */ }
    }
    body = body.replace(/<(?:script|style|head)\b[^>]*>[\s\S]*?<\/(?:script|style|head)\s*>/gi, "")
      .replace(/<\/(?:h[1-6]|p|div|section)>/gi, "\n")
      .replace(/<[^>]+>/g, " ");
  }
  const top = body.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 12);
  for (const [index, line] of top.entries()) {
    const match = /^(?:作者|撰文|文|By)(?:\s*[:：]\s*|\s+)(.+)$/i.exec(line);
    if (!match) continue;
    const item = evidence(match[1], "byline", `line:${index + 1}`);
    if (item) found.push(item);
  }
  if (!found.length) return null;
  const chosen = found[0];
  return found.every((item) => item.value.toLocaleLowerCase() === chosen.value.toLocaleLowerCase()) ? chosen : null;
}
