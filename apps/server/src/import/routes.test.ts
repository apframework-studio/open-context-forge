import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { expect, test } from "vitest";
import { createApp } from "../app.js";

function capture(id: string, warnings: string[] = []) {
  const markdown = "一篇可供整理的文章正文";
  return {
    schemaVersion: 1, id,
    source: { originalUrl: `https://example.org/${id}`, canonicalUrl: `https://example.org/${id}`, title: id },
    content: { markdown, wordCount: markdown.length, imageUrls: [] },
    capture: {
      capturedAt: "2026-10-22T00:00:00Z", extractor: "readability",
      contentHash: createHash("sha256").update(markdown).digest("hex"), warnings,
    },
    user: {}, delivery: { status: "queued", attempts: 0 },
  };
}

function multipart(bytes: Uint8Array) {
  const boundary = "ocf-test-boundary";
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "x-ocf-client": "1" },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="clipper.zip"\r\nContent-Type: application/zip\r\n\r\n`),
      Buffer.from(bytes),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

test("preflight persists ready and incomplete candidates across restart", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-import-"));
  const bytes = zipSync({ "captures.json": strToU8(JSON.stringify([
    capture("ready"), capture("short", ["content_too_short"]),
  ])) });
  const first = createApp({ dataDir });
  try {
    const response = await first.inject({ method: "POST", url: "/api/v1/imports/preflight", ...multipart(bytes) });
    expect(response.statusCode).toBe(201);
    const { batchId, candidates } = response.json();
    expect(candidates.map((item: { status: string }) => item.status)).toEqual(["ready", "incomplete"]);
    await first.close();

    const restarted = createApp({ dataDir });
    try {
      const saved = await restarted.inject({ method: "GET", url: `/api/v1/imports/${batchId}` });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().candidates.map((item: { id: string }) => item.id)).toEqual(["ready", "short"]);
    } finally {
      await restarted.close();
    }
  } finally {
    await first.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("rejects a multipart file larger than 20 MiB", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-import-"));
  const app = createApp({ dataDir });
  try {
    const bytes = new Uint8Array(20 * 1024 * 1024 + 1);
    const response = await app.inject({ method: "POST", url: "/api/v1/imports/preflight", ...multipart(bytes) });
    expect(response.statusCode).toBe(413);
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
