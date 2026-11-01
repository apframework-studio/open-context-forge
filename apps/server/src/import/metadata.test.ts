import { describe, expect, test } from "vitest";
import { extractLocalAuthor } from "./metadata.js";

describe("extractLocalAuthor", () => {
  test("reads explicit Markdown frontmatter before body", () => {
    expect(extractLocalAuthor("---\nauthor: Ada Lovelace\n---\n# Engines\n\nText", "markdown"))
      .toMatchObject({ value: "Ada Lovelace", kind: "frontmatter" });
    expect(extractLocalAuthor("---\nauthors: [Ada Lovelace, Charles Babbage]\n---\n# Engines", "markdown"))
      .toMatchObject({ value: "Ada Lovelace; Charles Babbage", kind: "frontmatter" });
  });

  test("reads HTML head metadata before converting body", () => {
    expect(extractLocalAuthor('<head><meta name="author" content="Benjamin Wan Rothschild"></head><article><h1>Analytics</h1></article>', "html"))
      .toMatchObject({ value: "Benjamin Wan Rothschild", kind: "html_meta" });
    expect(extractLocalAuthor('<script type="application/ld+json">{"@type":"Article","author":{"@type":"Person","name":"Ada"}}</script><h1>Title</h1>', "html"))
      .toMatchObject({ value: "Ada", kind: "json_ld" });
  });

  test("accepts a near-title byline but not an unlabelled name", () => {
    expect(extractLocalAuthor("# Analytics\n\nBy Benjamin Wan Rothschild\n\nBody", "markdown"))
      .toMatchObject({ value: "Benjamin Wan Rothschild", kind: "byline" });
    expect(extractLocalAuthor("# Analytics\n\nBenjamin Wan Rothschild\n\nBody", "markdown")).toBeNull();
    expect(extractLocalAuthor("# 标题\n\n作者：张三\n\n正文", "markdown"))
      .toMatchObject({ value: "张三", kind: "byline" });
  });

  test("does not choose between conflicting explicit authors", () => {
    expect(extractLocalAuthor("---\nauthor: Ada\n---\n# Title\n\nBy Grace", "markdown")).toBeNull();
  });
});
