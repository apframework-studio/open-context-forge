import { describe, expect, it } from "vitest";
import { quoteRangeForText, validQuoteRange } from "./writingQuote";

describe("quote source attribution", () => {
  it("locates a unique exact passage using source line numbers", () => {
    expect(quoteRangeForText("# Title\n\nfirst\nunique passage\nlast", "unique passage\nlast"))
      .toEqual({ startLine: 4, endLine: 5 });
  });
  it("does not attribute repeated text to its first occurrence", () => {
    expect(quoteRangeForText("same passage\nother\nsame passage", "same passage")).toBeNull();
    expect(quoteRangeForText("aaa", "aa")).toBeNull();
  });
  it("requires explicit source lines when rendered formatting differs from markdown", () => {
    expect(quoteRangeForText("intro\n**alpha** beta\nend", "alpha beta")).toBeNull();
  });
  it("does not infer a contiguous range for noncontiguous source text", () => {
    expect(quoteRangeForText("first\nomitted\nlast", "first\nlast")).toBeNull();
    expect(quoteRangeForText("first\nlast", "")).toBeNull();
  });
  it("allows only explicit integer ranges inside the full source", () => {
    expect(validQuoteRange(1, 3, 3)).toBe(true);
    expect(validQuoteRange(3, 3, 3)).toBe(true);
    for (const [start, end] of [["", ""], ["", 2], [1, ""], [0, 2], [2, 1], [1, 4], [1.5, 2], [NaN, 2]]) {
      expect(validQuoteRange(start, end, 3)).toBe(false);
    }
  });
});
