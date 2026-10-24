import { createHash } from "node:crypto";
import { strToU8, zipSync } from "fflate";

export function fixtureZipFor(id: string, title: string): Buffer {
  const markdown = `这是一篇可供整理的来源文章：${title}。`;
  const originalUrl = `https://example.org/${id}`;
  const record = {
    schemaVersion: 1, id,
    source: { originalUrl, canonicalUrl: originalUrl, title },
    content: { markdown, wordCount: markdown.length, imageUrls: [] },
    capture: { capturedAt: "2026-10-22T00:00:00Z", extractor: "readability", contentHash: createHash("sha256").update(markdown).digest("hex"), warnings: [] },
    user: {}, delivery: { status: "queued", attempts: 0 },
  };
  return Buffer.from(zipSync({ "captures.json": strToU8(JSON.stringify([record])) }));
}

export const fixtureZip = fixtureZipFor("capture-a", "来源文章 A");
