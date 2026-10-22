import { createHash } from "node:crypto";
import { strToU8, zipSync } from "fflate";
import { expect, test } from "vitest";
import { parseClipperZip } from "./clipper-zip.js";

function record(overrides: Record<string, unknown> = {}) {
  const markdown = "完整正文";
  return {
    schemaVersion: 1,
    id: "capture-1",
    source: { originalUrl: "https://example.org/a", canonicalUrl: "https://example.org/a", title: "文章 A" },
    content: { markdown, wordCount: 4, imageUrls: [] },
    capture: {
      capturedAt: "2026-10-22T00:00:00Z",
      extractor: "readability",
      contentHash: createHash("sha256").update(markdown).digest("hex"),
      warnings: [],
    },
    user: {},
    delivery: { status: "queued", attempts: 0 },
    ...overrides,
  };
}

function archive(records: unknown): Uint8Array {
  return zipSync({
    "captures.json": strToU8(JSON.stringify(records)),
    "articles/ignored.md": strToU8("这个文件不能成为权威来源"),
  });
}

test("reads a valid Clipper record from captures.json", () => {
  const [candidate] = parseClipperZip(archive([record()]));
  expect(candidate).toMatchObject({
    id: "capture-1", title: "文章 A", originalUrl: "https://example.org/a",
    markdown: "完整正文", status: "ready",
  });
  expect(candidate.markdown).not.toContain("这个文件");
});

test("rejects duplicate capture IDs within one archive", () => {
  expect(() => parseClipperZip(archive([record(), record()]))).toThrowError(
    expect.objectContaining({ code: "INVALID_RECORD" }),
  );
});

test("requires captures.json at the archive root", () => {
  const bytes = zipSync({ "articles/a.md": strToU8("hello") });
  expect(() => parseClipperZip(bytes)).toThrowError(
    expect.objectContaining({ code: "INVALID_RECORD" }),
  );
});

test("rejects a manifest whose uncompressed size exceeds 8 MiB", () => {
  const bytes = zipSync({ "captures.json": strToU8("x".repeat(8 * 1024 * 1024 + 1)) });
  expect(() => parseClipperZip(bytes)).toThrowError(
    expect.objectContaining({ code: "MANIFEST_TOO_LARGE" }),
  );
});

test("rejects markdown changed after Clipper computed its hash", () => {
  const changed = record({ content: { markdown: "另一篇正文", wordCount: 5, imageUrls: [] } });
  expect(() => parseClipperZip(archive([changed]))).toThrowError(
    expect.objectContaining({ code: "HASH_MISMATCH" }),
  );
});

test("marks a short preview as incomplete", () => {
  const short = record({
    capture: {
      capturedAt: "2026-10-22T00:00:00Z",
      extractor: "readability",
      contentHash: createHash("sha256").update("完整正文").digest("hex"),
      warnings: ["content_too_short"],
    },
  });
  expect(parseClipperZip(archive([short]))[0].status).toBe("incomplete");
});

test("uses Clipper's CRLF normalization and trimming for content hashes", () => {
  const normalized = record({
    content: { markdown: "  第一行\r\n第二行  ", wordCount: 6, imageUrls: [] },
    capture: {
      capturedAt: "2026-10-22T00:00:00Z",
      extractor: "readability",
      contentHash: createHash("sha256").update("第一行\n第二行").digest("hex"),
      warnings: [],
    },
  });
  expect(parseClipperZip(archive([normalized]))[0].status).toBe("ready");
});

test("rejects an oversized archive before attempting to parse it", () => {
  expect(() => parseClipperZip(new Uint8Array(20 * 1024 * 1024 + 1))).toThrowError(
    expect.objectContaining({ code: "ARCHIVE_TOO_LARGE" }),
  );
});

test("reports malformed ZIP without leaking parser errors", () => {
  expect(() => parseClipperZip(strToU8("not a zip"))).toThrowError(
    expect.objectContaining({ code: "INVALID_ZIP" }),
  );
});
