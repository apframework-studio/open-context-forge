import { describe, expect, it } from "vitest";
import { readingDocument, readingMarkdown } from "./readingMarkdown";

describe("readingMarkdown", () => {
  it("shows the article body first when a captured source has its standard metadata wrapper", () => {
    const original = `# Example article\n\n- 来源：https://example.com/article\n- 抓取时间：2026-10-20T09:01:04Z\n- 作者：Ada\n- Clipper 内容指纹：abc123\n\n---\n\nThe first real paragraph.\n\n## Section`;
    expect(readingMarkdown({ kind: "source", title: "Example article", markdown: original })).toBe("The first real paragraph.\n\n## Section");
  });

  it("leaves notes and unrecognized source formats untouched", () => {
    const markdown = "# A note\n\n- 来源：my own research\n\n---\n\nImportant text";
    expect(readingMarkdown({ kind: "note", title: "A note", markdown })).toBe(markdown);
    expect(readingMarkdown({ kind: "source", title: "Different title", markdown })).toBe(markdown);
  });
});

describe("readingDocument", () => {
  it("separates YAML properties from the reading body without flattening lists or Chinese text", () => {
    const markdown = `---\ntype: knowledge_map\ntopic: 文脉引擎\nsources:\n  - wiki/First.md\n  - wiki/Second.md\nlast_reviewed: 2026-05-14\n---\n# Knowledge Map\n\n正文 [[First|第一篇]]`;
    const result = readingDocument({ kind: "note", title: "Knowledge Map", markdown });
    expect(result.body).toBe("# Knowledge Map\n\n正文 [[First|第一篇]]");
    expect(result.properties).toEqual([
      { name: "type", values: ["knowledge_map"] }, { name: "topic", values: ["文脉引擎"] },
      { name: "sources", values: ["wiki/First.md", "wiki/Second.md"] },
      { name: "last_reviewed", values: ["2026-05-14"] },
    ]);
    expect(result.error).toBeNull();
  });

  it("keeps malformed metadata available and still shows the article body", () => {
    const result = readingDocument({ kind: "note", title: "Map", markdown: "---\ntags: [broken\n---\n正文仍可阅读" });
    expect(result.body).toBe("正文仍可阅读");
    expect(result.rawProperties).toBe("tags: [broken");
    expect(result.error).toBeTruthy();
  });

  it("does not mistake ordinary separators or fenced YAML examples for properties", () => {
    for (const markdown of ["---\n开场文字\n---\n正文", "```yaml\ntype: example\n```\n正文", "---\ntype: unfinished\n正文"]) {
      expect(readingDocument({ kind: "note", title: "Map", markdown }).body).toBe(markdown);
    }
  });

  it("bounds YAML alias expansion instead of hanging the reader", () => {
    const result = readingDocument({ kind: "note", title: "Map", markdown: "---\na: &a [*a]\n---\n正文" });
    expect(result.body).toBe("正文");
    expect(result.error).toBeTruthy();
  });
});
