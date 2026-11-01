import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { KnowledgeMarkdown } from "./KnowledgeMarkdown";

const item = { kind: "note" as const, title: "Knowledge Map", path: "wiki/Map.md",
  outlinks: [{ from: "wiki/Map.md", to: "wiki/Foundation.md", target: "Foundation", type: "wikilink" as const, line: 9 },
    { from: "wiki/Map.md", to: "wiki/Foundation.md", target: "Foundation.md", type: "markdown" as const, line: 10 }],
  issues: [{ from: "wiki/Map.md", target: "Missing", reason: "missing" as const, line: 11 },
    { from: "wiki/Map.md", target: "Duplicate", reason: "ambiguous" as const, line: 12 }] };
const render = (markdown: string) => renderToStaticMarkup(createElement(KnowledgeMarkdown, { item: { ...item, markdown }, onNavigate: () => undefined, onAnchor: () => undefined }));

describe("knowledge Markdown reading", () => {
  it("renders aliases as verified note links and leaves wiki syntax inside code untouched", () => {
    const html = render("[[Foundation#原则|系统基础]] 和 `[[Foundation]]`\n\n```text\n[[Foundation]]\n```\n\n[普通笔记链接](Foundation.md)");
    expect(html).toContain('class="knowledge-note-link"');
    expect(html).toContain(">系统基础</a>");
    expect(html).toContain(">普通笔记链接</a>");
    expect(html).toContain("<code>[[Foundation]]</code>");
    expect(html).toContain('class="language-text">[[Foundation]]');
  });

  it("shows missing and ambiguous links without inventing a destination", () => {
    const html = render("[[Missing|未有笔记]] [[Duplicate]]");
    expect(html).toContain("目标不存在");
    expect(html).toContain("目标有歧义");
    expect(html).toContain("未有笔记</span>");
    expect(html).not.toContain("href=");
  });

  it("separates folded properties, avoids a duplicate page title and retains GFM tables", () => {
    const html = render("---\ntype: knowledge_map\nsources:\n  - wiki/Foundation.md\n---\n# Knowledge Map\n\n正文\n\n| 类型 | 数量 |\n| --- | --- |\n| 概念 | 35 |");
    expect(html).toContain("笔记属性");
    expect(html).toContain("knowledge_map");
    expect(html).toContain("wiki/Foundation.md");
    expect(html).toContain("<table>");
    expect(html).not.toContain("<h1>");
    expect(html).not.toContain(' open=""');
  });

  it("renders safe remote images and keeps unsafe or relative image sources inert", () => {
    const html = render("![图示](https://example.com/image.png) ![危险](javascript:alert%281%29) ![本地](assets/image.png)");
    expect(html).toContain('<img src="https://example.com/image.png" alt="图示" loading="lazy"');
    expect(html).toContain("图片未加载");
    expect(html).not.toContain('src="javascript:');
    expect(html).not.toContain('src="assets/image.png"');
  });

  it("keeps unsafe URLs and raw HTML inert while allowing external links", () => {
    const html = render('[危险](javascript:alert%281%29) <script>alert(1)</script>\n\n[原文](https://example.com)');
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<script>");
    expect(html).toContain('rel="noopener noreferrer"');
  });
});
