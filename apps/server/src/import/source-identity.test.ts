import { describe, expect, test } from "vitest";
import type { CaptureCandidate } from "@ocf/contracts";
import { sourceKey } from "./source-identity.js";

const candidate: CaptureCandidate = {
  id: "one", title: "Example", originalUrl: null, sourceFilename: "notes\\article.md",
  capturedAt: "2026-10-28T00:00:00Z", markdown: "# Example\n\nBody", contentHash: "a".repeat(64),
  warnings: [], status: "ready",
};

describe("sourceKey", () => {
  test("ignores receive time and normalizes local path and Unicode", () => {
    const first = sourceKey(candidate);
    expect(first).toMatch(/^[a-f\d]{64}$/);
    expect(sourceKey({ ...candidate, capturedAt: "2026-10-29T00:00:00Z", sourceFilename: "notes/article.md" })).toBe(first);
    expect(sourceKey({ ...candidate, sourceFilename: "cafe\u0301.md" })).toBe(
      sourceKey({ ...candidate, sourceFilename: "caf\u00e9.md" }));
    expect(sourceKey({ ...candidate, sourceFilename: "other/article.md" })).not.toBe(first);
  });

  test("removes URL fragments but preserves query and source kind", () => {
    const url = { ...candidate, originalUrl: "https://example.org/post?ref=a#section" };
    expect(sourceKey(url)).toBe(sourceKey({ ...url, originalUrl: "https://example.org/post?ref=a" }));
    expect(sourceKey(url)).not.toBe(sourceKey({ ...url, originalUrl: "https://example.org/post?ref=b" }));
    expect(sourceKey(url)).not.toBe(sourceKey(candidate));
  });
});
