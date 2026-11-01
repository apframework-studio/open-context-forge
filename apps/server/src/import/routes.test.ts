import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { expect, test } from "vitest";
import { createApp } from "../app.js";
import { waitForFiling } from "./test-filings.js";

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

function multipart(bytes: Uint8Array, filename = "clipper.zip", type = "application/zip") {
  const boundary = "ocf-test-boundary";
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "x-ocf-client": "1" },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`),
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

test("imports a local Markdown file through the existing pending and vault flow", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-local-import-"));
  const app = createApp({ dataDir });
  try {
    await app.inject({ method: "PUT", url: "/api/v1/imports/policy", headers: { "x-ocf-client": "1" },
      payload: { mode: "manual" } });
    const response = await app.inject({ method: "POST", url: "/api/v1/imports/preflight",
      ...multipart(strToU8("# 本地研究\n\n完整正文"), "本地研究.md", "text/markdown") });
    expect(response.statusCode).toBe(201);
    const candidate = response.json().candidates[0];
    expect(candidate).toMatchObject({ title: "本地研究", originalUrl: null, sourceFilename: "本地研究.md" });
    const pending = await app.inject({ method: "GET", url: "/api/v1/imports/items?view=pending" });
    expect(pending.json().items.map((item: { title: string }) => item.title)).toContain("本地研究");
    const byFilename = await app.inject({ method: "GET", url: "/api/v1/imports/items?view=all&q=%E6%9C%AC%E5%9C%B0%E7%A0%94%E7%A9%B6.md" });
    expect(byFilename.json().total).toBe(1);

    const filed = await app.inject({ method: "POST", url: "/api/v1/imports/items/actions",
      headers: { "x-ocf-client": "1" },
      payload: { action: "file", vaultId: "default", items: [{ batchId: response.json().batchId, captureId: candidate.id }] } });
    expect(filed.json().results[0].ok).toBe(true);
    const snapshot = (await waitForFiling(app, filed.json().results[0].jobId)).snapshot;
    const markdown = readFileSync(join(dataDir, "vaults", "default", snapshot), "utf8");
    expect(markdown).toContain("本地文件：本地研究.md");
    expect(markdown).not.toContain("https://local");
    const manifest = JSON.parse(readFileSync(join(dataDir, "vaults", "default", ".ocf", "ingest-manifest.json"), "utf8"));
    const origin = Object.values(manifest.sources)[0] as { authorship: string; origins: { filename: string }[] };
    expect(origin.authorship).toBe("unknown");
    expect(origin.origins[0].filename).toBe("本地研究.md");
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("a regular text ZIP creates multiple pending items in one batch", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-text-zip-"));
  const app = createApp({ dataDir });
  try {
    const zip = zipSync({ "a.md": strToU8("# A\n\n正文"), "b.html": strToU8("<h1>B</h1><p>内容</p>"), "image.png": strToU8("not text") });
    const response = await app.inject({ method: "POST", url: "/api/v1/imports/preflight", ...multipart(zip, "documents.zip") });
    expect(response.statusCode).toBe(201);
    expect(response.json().candidates.map((item: { title: string }) => item.title)).toEqual(["A", "B"]);
    expect(response.json().skippedFiles).toBe(1);
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
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
