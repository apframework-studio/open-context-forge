import { createHash } from "node:crypto";
import { strToU8, zipSync } from "fflate";

const markdown = "这是一篇可供整理的来源文章。";
const record = {
  schemaVersion: 1, id: "capture-a",
  source: { originalUrl: "https://example.org/a", canonicalUrl: "https://example.org/a", title: "来源文章 A" },
  content: { markdown, wordCount: markdown.length, imageUrls: [] },
  capture: { capturedAt: "2026-10-22T00:00:00Z", extractor: "readability", contentHash: createHash("sha256").update(markdown).digest("hex"), warnings: [] },
  user: {}, delivery: { status: "queued", attempts: 0 },
};

export const fixtureZip = Buffer.from(zipSync({ "captures.json": strToU8(JSON.stringify([record])) }));
