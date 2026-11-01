import { createHash } from "node:crypto";
import { strToU8, zipSync } from "fflate";
import { expect, test } from "vitest";
import { parseImportUpload } from "./local-files.js";

test("imports a Markdown file as a local source without inventing a web URL", () => {
  const result = parseImportUpload(strToU8("# 研究笔记\n\n有证据的正文。"), "研究笔记.md");
  expect(result.skippedFiles).toBe(0);
  expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0]).toMatchObject({
    title: "研究笔记", originalUrl: null, sourceFilename: "研究笔记.md", status: "ready",
    markdown: "# 研究笔记\n\n有证据的正文。",
  });
  expect(result.candidates[0].contentHash).toBe(createHash("sha256").update("# 研究笔记\n\n有证据的正文。").digest("hex"));
});

test("converts an HTML document to readable Markdown and excludes scripts", () => {
  const html = '<html><head><title>离线报告</title><style>.x{display:none}</style></head><body><main><h1>离线报告</h1><p>第一段 <a href="https://example.org/a">参考资料</a>。</p><script>ignoreMe()</script><p>第二段&nbsp;内容</p></main></body></html>';
  const [item] = parseImportUpload(strToU8(html), "report.html").candidates;
  expect(item.title).toBe("离线报告");
  expect(item.markdown).toContain("# 离线报告");
  expect(item.markdown).toContain("[参考资料](https://example.org/a)");
  expect(item.markdown).toContain("第二段 内容");
  expect(item.markdown).not.toContain("ignoreMe");
  expect(item.markdown).not.toContain("display:none");
});

test("imports every supported text document in a ZIP and skips other files", () => {
  const zip = zipSync({
    "notes/one.md": strToU8("# 第一篇\n\n内容 A"),
    "notes/two.txt": strToU8("第二篇内容 B"),
    "assets/image.png": Uint8Array.from([137, 80, 78, 71]),
  });
  const result = parseImportUpload(zip, "bundle.zip");
  expect(result.candidates.map((item) => item.title)).toEqual(["第一篇", "two"]);
  expect(result.candidates.map((item) => item.sourceFilename)).toEqual(["notes/one.md", "notes/two.txt"]);
  expect(result.skippedFiles).toBe(1);
});

test("keeps Clipper manifests authoritative when a ZIP also contains loose files", () => {
  const markdown = "Clipper 正文";
  const record = {
    schemaVersion: 1, id: "clipper-one",
    source: { originalUrl: "https://example.org/a", canonicalUrl: "https://example.org/a", title: "网页来源" },
    content: { markdown, wordCount: markdown.length, imageUrls: [] },
    capture: { capturedAt: "2026-10-24T00:00:00Z", extractor: "readability",
      contentHash: createHash("sha256").update(markdown).digest("hex"), warnings: [] },
    user: {}, delivery: { status: "queued", attempts: 0 },
  };
  const zip = zipSync({ "captures.json": strToU8(JSON.stringify([record])), "notes/ignored.md": strToU8("不应单独导入") });
  const result = parseImportUpload(zip, "clipper.zip");
  expect(result.candidates.map((item) => item.title)).toEqual(["网页来源"]);
  expect(result.skippedFiles).toBe(0);
});

test("rejects unsupported and oversized text input", () => {
  expect(() => parseImportUpload(strToU8("binary"), "archive.pdf")).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_FILE" }));
  expect(() => parseImportUpload(zipSync({ "assets/image.png": strToU8("x") }), "assets.zip"))
    .toThrowError(expect.objectContaining({ code: "NO_SUPPORTED_FILES" }));
  expect(() => parseImportUpload(zipSync({ "huge.md": strToU8("x".repeat(8 * 1024 * 1024 + 1)) }), "huge.zip"))
    .toThrowError(expect.objectContaining({ code: "TEXT_TOO_LARGE" }));
  expect(() => parseImportUpload(Uint8Array.from([65, 0, 66]), "fake.txt"))
    .toThrowError(expect.objectContaining({ code: "INVALID_TEXT_FILE" }));
});

test("skips a binary file with a text extension when other ZIP documents are valid", () => {
  const result = parseImportUpload(zipSync({
    "good.md": strToU8("# 正文\n\n内容"),
    "binary.txt": Uint8Array.from([65, 1, 66]),
  }), "mixed.zip");
  expect(result.candidates.map((item) => item.title)).toEqual(["正文"]);
  expect(result.skippedFiles).toBe(1);
});

test("local article retains author evidence from frontmatter and HTML head", () => {
  const markdown = parseImportUpload(strToU8("---\nauthor: Ada Lovelace\n---\n# Engines\n\nBody"), "engines.md").candidates[0];
  expect(markdown.author).toBe("Ada Lovelace");
  expect(markdown.authorEvidence).toMatchObject({ kind: "frontmatter", location: "frontmatter:author" });
  const html = parseImportUpload(strToU8('<head><meta content="Grace Hopper" name="author"></head><h1>Compiler</h1>'), "compiler.html").candidates[0];
  expect(html.author).toBe("Grace Hopper");
  expect(html.authorEvidence).toMatchObject({ kind: "html_meta" });
});

test("Clipper structured author retains its source evidence", () => {
  const markdown = "# Scaling Analytics\n\nArticle";
  const record = {
    schemaVersion: 1, id: "meta", source: { originalUrl: "https://example.org/meta", canonicalUrl: "https://example.org/meta",
      title: "Scaling Analytics", author: "Benjamin Wan Rothschild" },
    content: { markdown, wordCount: markdown.length, imageUrls: [] },
    capture: { capturedAt: "2026-10-29T00:00:00Z", extractor: "readability",
      contentHash: createHash("sha256").update(markdown).digest("hex"), warnings: [] },
    user: {}, delivery: { status: "queued", attempts: 0 },
  };
  const item = parseImportUpload(zipSync({ "captures.json": strToU8(JSON.stringify([record])) }), "clipper.zip").candidates[0];
  expect(item.authorEvidence).toMatchObject({ value: "Benjamin Wan Rothschild", kind: "clipper" });
});
