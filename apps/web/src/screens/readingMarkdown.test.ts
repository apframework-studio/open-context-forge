import { describe, expect, it } from "vitest";
import { readingMarkdown } from "./readingMarkdown";

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
