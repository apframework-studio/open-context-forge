import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, vi } from "vitest";
import { strToU8, zipSync } from "fflate";
import Database from "better-sqlite3";
import { syncCaptureAnalysis } from "./service.js";
import { createApp } from "../app.js";
import { importSnapshot } from "../vaults/maintainer.js";
import type { AgentRunner } from "../agents/runner.js";
import { waitForFiling } from "../import/test-filings.js";

const maintainerRoot = resolve(process.cwd(), "../../../open-context-forge-vault-maintainer");
const writerRoot = resolve(process.cwd(), "../../../open-context-forge-tech-article-writer");
const readerRoot = resolve(process.cwd(), "../../../open-context-article-reader");

async function fixture(runner: AgentRunner) {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-analysis-"));
  const app = createApp({ dataDir, maintainerRoot, writerRoot, readerRoot,
    agentOptions: { runner, environment: {}, claudePath: "/fake/claude" } });
  await app.inject({ method: "GET", url: "/api/v1/vaults" });
  const vaultPath = realpathSync(join(dataDir, "vaults", "default"));
  const imported = await importSnapshot({
    title: "测例", originalUrl: "https://example.org/one", capturedAt: "2026-10-23T00:00:00Z",
    contentHash: "abc", markdown: "## 观察\n\n作者报告效率提高。\n\n## 限制\n\n只测试了一个团队。",
  } as Parameters<typeof importSnapshot>[0], vaultPath, maintainerRoot);
  const lines = readFileSync(join(vaultPath, imported.snapshot), "utf8").split("\n");
  const evidenceLine = lines.findIndex((line) => line === "作者报告效率提高。") + 1;
  return { app, dataDir, vaultPath, ...imported, evidenceLine };
}

const headers = { "x-ocf-client": "1" };

test("filing a confirmed capture card preserves an existing vault analysis file", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocf-analysis-existing-"));
  const db = new Database(":memory:");
  const snapshot = "raw/sources/source.md";
  const contents = "内容";
  const fingerprint = createHash("sha256").update(contents).digest("hex");
  const cardPath = join(root, ".ocf", "compilations", fingerprint, "analysis.md");
  mkdirSync(join(root, ".ocf", "compilations", fingerprint), { recursive: true });
  mkdirSync(join(root, "raw", "sources"), { recursive: true });
  writeFileSync(join(root, snapshot), contents);
  writeFileSync(join(root, ".ocf", "ingest-manifest.json"), JSON.stringify({ sources: { [fingerprint]: { snapshot } } }));
  writeFileSync(cardPath, "用户编辑过的分析卡");
  db.exec(`CREATE TABLE capture_analyses (batch_id TEXT, capture_id TEXT, fingerprint TEXT, status TEXT, card_json TEXT);
    CREATE TABLE source_analyses (vault_id TEXT, fingerprint TEXT, snapshot TEXT, status TEXT, card_json TEXT, updated_at TEXT,
      PRIMARY KEY (vault_id, fingerprint));`);
  const card = { vaultId: "", snapshot: "inbox/batch/one", fingerprint, status: "confirmed", authorship: "third_party", author: null,
    summary: "摘要", mainPoints: [{ claim: "结论", kind: "article_statement", evidence: [{ startLine: 1, endLine: 1, excerpt: "内容" }] }],
    limitations: [], recommendation: "defer", reason: "待核对" };
  db.prepare("INSERT INTO capture_analyses VALUES (?, ?, ?, ?, ?)").run("batch", "one", fingerprint, "confirmed", JSON.stringify(card));
  try {
    await expect(syncCaptureAnalysis(db, "batch", "one", "default", snapshot, fingerprint, realpathSync(root)))
      .rejects.toMatchObject({ code: "ANALYSIS_ALREADY_EXISTS" });
    expect(readFileSync(cardPath, "utf8")).toBe("用户编辑过的分析卡");
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("rejects capture confirmation when its filed vault snapshot has changed", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-capture-changed-"));
  const app = createApp({ dataDir, maintainerRoot, readerRoot, agentOptions: {
    environment: {}, claudePath: "/fake/claude", runner: async (input) => {
      const line = Number(input.prompt.split("\n").find((part) => part.startsWith("L") && part.includes("原文证据"))?.match(/^L(\d+)/)?.[1]);
      return { sessionId: "capture-changed", text: JSON.stringify({ summary: "摘要",
        mainPoints: [{ claim: "主张", kind: "article_statement", evidence: [{ startLine: line, endLine: line, excerpt: "原文证据" }] }],
        limitations: [], recommendation: "defer", reason: "待确认" }) };
    },
  } });
  try {
    const markdown = "原文证据";
    const capture = { schemaVersion: 1, id: "changed",
      source: { originalUrl: "https://example.org/changed", canonicalUrl: "https://example.org/changed", title: "待分析" },
      content: { markdown, wordCount: markdown.length, imageUrls: [] },
      capture: { capturedAt: new Date().toISOString(), extractor: "readability",
        contentHash: createHash("sha256").update(markdown).digest("hex"), warnings: [] },
      user: {}, delivery: { status: "queued", attempts: 0 } };
    const bytes = zipSync({ "captures.json": strToU8(JSON.stringify([capture])) });
    const boundary = "ocf-capture-changed";
    const upload = await app.inject({ method: "POST", url: "/api/v1/imports/preflight",
      headers: { ...headers, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="captures.zip"\r\nContent-Type: application/zip\r\n\r\n`),
        Buffer.from(bytes), Buffer.from(`\r\n--${boundary}--\r\n`)]) });
    const batchId = upload.json().batchId;
    const base = `/api/v1/imports/${batchId}/items/changed/analysis`;
    const proposed = await app.inject({ method: "POST", url: base, headers, payload: { profileId: "claude-current" } });
    expect(proposed.statusCode).toBe(201);
    const filed = await app.inject({ method: "POST", url: `/api/v1/imports/${batchId}/items/changed/commit`, headers,
      payload: { vaultId: "default" } });
    expect(filed.statusCode).toBe(202);
    const filing = await waitForFiling(app, filed.json().job.id);
    const vaultPath = realpathSync(join(dataDir, "vaults", "default"));
    writeFileSync(join(vaultPath, filing.snapshot), "内容已改动");
    const confirmed = await app.inject({ method: "POST", url: `${base}/confirm`, headers,
      payload: { expectedFingerprint: proposed.json().fingerprint } });
    expect(confirmed.statusCode).toBe(409);
    expect(confirmed.json().error).toBe("SOURCE_CHANGED");
    const saved = await app.inject({ method: "GET", url: base });
    expect(saved.json().status).toBe("proposed");
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("confirms a captured source card before filing and carries it into the vault", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-capture-analysis-"));
  const app = createApp({ dataDir, maintainerRoot, readerRoot, agentOptions: {
    environment: {}, claudePath: "/fake/claude", runner: async (input) => {
      const evidenceLine = Number(input.prompt.split("\n").find((line) => line.includes("作者报告效率提高。") && line.startsWith("L"))?.match(/^L(\d+)/)?.[1]);
      return { sessionId: "capture-analysis", text: JSON.stringify({
        summary: "作者报告效率提高。", mainPoints: [{ claim: "效率提高", kind: "article_statement",
          evidence: [{ startLine: evidenceLine, endLine: evidenceLine, excerpt: "作者报告效率提高。" }] }],
        limitations: [], recommendation: "defer", reason: "还需核对", 
      }) };
    },
  } });
  try {
    const markdown = "作者报告效率提高。";
    const capture = { schemaVersion: 1, id: "one",
      source: { originalUrl: "https://example.org/one", canonicalUrl: "https://example.org/one", title: "第一篇" },
      content: { markdown, wordCount: markdown.length, imageUrls: [] },
      capture: { capturedAt: new Date().toISOString(), extractor: "readability",
        contentHash: createHash("sha256").update(markdown).digest("hex"), warnings: [] },
      user: {}, delivery: { status: "queued", attempts: 0 } };
    const bytes = zipSync({ "captures.json": strToU8(JSON.stringify([capture])) });
    const boundary = "ocf-capture-analysis";
    const upload = await app.inject({ method: "POST", url: "/api/v1/imports/preflight",
      headers: { ...headers, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="captures.zip"\r\nContent-Type: application/zip\r\n\r\n`),
        Buffer.from(bytes), Buffer.from(`\r\n--${boundary}--\r\n`)]) });
    const batchId = upload.json().batchId;
    const base = `/api/v1/imports/${batchId}/items/one/analysis`;
    const proposed = await app.inject({ method: "POST", url: base, headers, payload: { profileId: "claude-current" } });
    expect(proposed.statusCode).toBe(201);
    expect(proposed.json().status).toBe("proposed");
    const confirmed = await app.inject({ method: "POST", url: `${base}/confirm`, headers,
      payload: { expectedFingerprint: proposed.json().fingerprint } });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().status).toBe("confirmed");
    const filed = await app.inject({ method: "POST", url: `/api/v1/imports/${batchId}/items/one/commit`, headers,
      payload: { vaultId: "default" } });
    expect(filed.statusCode).toBe(202);
    const filing = await waitForFiling(app, filed.json().job.id);
    const vaultPath = realpathSync(join(dataDir, "vaults", "default"));
    const cardPath = join(vaultPath, ".ocf", "compilations", filing.fingerprint, "analysis.md");
    expect(readFileSync(cardPath, "utf8")).toContain(`source_snapshot: '${filing.snapshot}'`);
    expect(readFileSync(cardPath, "utf8")).toContain("作者报告效率提高。");
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("proposes a line-grounded card without writing into vault, then confirms it", async () => {
  let prompt = "";
  let runs = 0;
  const context = await fixture(async (input) => {
    runs += 1;
    prompt = input.prompt;
    const line = Number(input.prompt.match(/作者报告效率提高。/g)?.length); // verifies full source appears once
    expect(line).toBe(1);
    const evidenceLine = input.prompt.split("\n").find((item) => item.includes("作者报告效率提高。") && item.startsWith("L"))?.match(/^L(\d+)/)?.[1];
    return { sessionId: "analysis-1", text: JSON.stringify({
      summary: "作者报告单团队效率提高，但范围有限。",
      mainPoints: [{ claim: "作者报告效率提高", kind: "article_statement", evidence: [{ startLine: Number(evidenceLine), endLine: Number(evidenceLine), excerpt: "作者报告效率提高。" }] }],
      limitations: ["只测试了一个团队"], recommendation: "defer", reason: "需要更多团队数据",
    }) };
  });
  try {
    const request = { vaultId: "default", snapshot: context.snapshot, profileId: "claude-current" };
    const proposed = await context.app.inject({ method: "POST", url: "/api/v1/sources/analysis", headers, payload: request });
    expect(proposed.statusCode).toBe(201);
    expect(proposed.json()).toMatchObject({ status: "proposed", fingerprint: context.fingerprint,
      mainPoints: [{ evidence: [{ startLine: context.evidenceLine, excerpt: "作者报告效率提高。" }] }] });
    expect(prompt).toContain("Reconstruct what the author actually says");
    const cardPath = join(context.vaultPath, ".ocf", "compilations", context.fingerprint, "analysis.md");
    expect(() => readFileSync(cardPath, "utf8")).toThrow();

    const confirmed = await context.app.inject({ method: "POST", url: "/api/v1/sources/analysis/confirm", headers,
      payload: { vaultId: "default", snapshot: context.snapshot, expectedFingerprint: context.fingerprint } });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().status).toBe("confirmed");
    expect(readFileSync(cardPath, "utf8")).toContain(`L${context.evidenceLine}-L${context.evidenceLine}`);
    expect(readFileSync(cardPath, "utf8")).toContain(context.snapshot);
    expect(readFileSync(cardPath, "utf8")).toContain("source_authorship: 'unknown'");
    const again = await context.app.inject({ method: "POST", url: "/api/v1/sources/analysis/confirm", headers,
      payload: { vaultId: "default", snapshot: context.snapshot, expectedFingerprint: context.fingerprint } });
    expect(again.statusCode).toBe(200);
    const repeatedAnalysis = await context.app.inject({ method: "POST", url: "/api/v1/sources/analysis", headers, payload: request });
    expect(repeatedAnalysis.json().status).toBe("confirmed");
    expect(runs).toBe(1);
  } finally { await context.app.close(); rmSync(context.dataDir, { recursive: true, force: true }); }
});

test("keeps analysis content when evidence does not match and still rejects changed source", async () => {
  const context = await fixture(async () => ({ sessionId: "analysis-2", text: JSON.stringify({
    summary: "可展示的摘要", mainPoints: [{ claim: "待核对的要点", kind: "article_statement",
      evidence: [{ startLine: 999, endLine: 999, excerpt: "伪证据" }] }],
    limitations: [], recommendation: "defer", reason: "待核对",
  }) }));
  try {
    const body = { vaultId: "default", snapshot: context.snapshot, profileId: "claude-current" };
    const response = await context.app.inject({ method: "POST", url: "/api/v1/sources/analysis", headers, payload: body });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ summary: "可展示的摘要", mainPoints: [{ claim: "待核对的要点", evidence: [] }] });
    writeFileSync(join(context.vaultPath, context.snapshot), "changed");
    const changed = await context.app.inject({ method: "POST", url: "/api/v1/sources/analysis", headers, payload: body });
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error).toBe("SOURCE_CHANGED");
  } finally { await context.app.close(); rmSync(context.dataDir, { recursive: true, force: true }); }
});

test("keeps a grounded analysis when Claude returns more than eight main points", async () => {
  const context = await fixture(async (input) => {
    const line = Number(input.prompt.split("\n").find((item) => item.includes("作者报告效率提高。") && item.startsWith("L"))?.match(/^L(\d+)/)?.[1]);
    return { sessionId: "analysis-many-points", text: JSON.stringify({
      summary: "作者报告效率提高，但证据范围有限。",
      mainPoints: Array.from({ length: 13 }, (_, index) => ({
        claim: `要点 ${index + 1}`, kind: "article_statement",
        evidence: [{ startLine: line, endLine: line, excerpt: "作者报告效率提高。" }],
      })),
      limitations: ["只测试了一个团队"], recommendation: "defer", reason: "还需验证",
    }) };
  });
  try {
    const response = await context.app.inject({ method: "POST", url: "/api/v1/sources/analysis", headers,
      payload: { vaultId: "default", snapshot: context.snapshot, profileId: "claude-current" } });
    expect(response.statusCode).toBe(201);
    expect(response.json().mainPoints).toHaveLength(13);
  } finally { await context.app.close(); rmSync(context.dataDir, { recursive: true, force: true }); }
});

test("prints analysis stages and safe counts while a Claude run is pending", async () => {
  let finishRun!: (result: Awaited<ReturnType<AgentRunner>>) => void;
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const context = await fixture(async () => {
    signalStarted();
    return new Promise((resolve) => { finishRun = resolve; });
  });
  const messages: string[] = [];
  const log = vi.spyOn(console, "info").mockImplementation((message: unknown) => { messages.push(String(message)); });
  try {
    const pending = context.app.inject({ method: "POST", url: "/api/v1/sources/analysis", headers,
      payload: { vaultId: "default", snapshot: context.snapshot, profileId: "claude-current" } });
    await started;
    expect(messages.some((message) => message.includes('"event":"started"') &&
      message.includes('"skill":"open-context-article-reader"') && message.includes('"skillMode":"inline-rules"'))).toBe(true);
    finishRun({ sessionId: "logged-run", text: JSON.stringify({
      summary: "PRIVATE_RESULT_TEXT", mainPoints: [{ claim: "作者报告效率提高", kind: "article_statement",
        evidence: [{ startLine: context.evidenceLine, endLine: context.evidenceLine, excerpt: "作者报告效率提高。" }] }],
      limitations: [], recommendation: "defer", reason: "待核实",
    }) });
    const response = await pending;
    expect(response.statusCode).toBe(201);
    expect(messages.some((message) => message.includes('"event":"agent_completed"') && message.includes('"mainPoints":1'))).toBe(true);
    expect(messages.some((message) => message.includes('"event":"completed"') && message.includes('"mainPoints":1'))).toBe(true);
    expect(messages.join("\n")).not.toContain("PRIVATE_RESULT_TEXT");
    expect(messages.join("\n")).not.toContain("作者报告效率提高。");
  } finally {
    log.mockRestore();
    await context.app.close();
    rmSync(context.dataDir, { recursive: true, force: true });
  }
});

test("refuses confirmation when an imported snapshot changes after proposal", async () => {
  const context = await fixture(async (input) => {
    const line = Number(input.prompt.split("\n").find((item) => item.includes("作者报告效率提高。") && item.startsWith("L"))?.match(/^L(\d+)/)?.[1]);
    return { sessionId: "analysis-3", text: JSON.stringify({ summary: "作者报告效率提高。",
      mainPoints: [{ claim: "作者报告效率提高", kind: "article_statement",
        evidence: [{ startLine: line, endLine: line, excerpt: "作者报告效率提高。" }] }],
      limitations: ["只测试了一个团队"], recommendation: "defer", reason: "样本有限" }) };
  });
  try {
    const proposed = await context.app.inject({ method: "POST", url: "/api/v1/sources/analysis", headers,
      payload: { vaultId: "default", snapshot: context.snapshot, profileId: "claude-current" } });
    expect(proposed.statusCode).toBe(201);
    writeFileSync(join(context.vaultPath, context.snapshot), "已被改动");
    const confirmed = await context.app.inject({ method: "POST", url: "/api/v1/sources/analysis/confirm", headers,
      payload: { vaultId: "default", snapshot: context.snapshot, expectedFingerprint: context.fingerprint } });
    expect(confirmed.statusCode).toBe(409);
    expect(confirmed.json().error).toBe("SOURCE_CHANGED");
    expect(() => readFileSync(join(context.vaultPath, ".ocf", "compilations", context.fingerprint, "analysis.md"), "utf8")).toThrow();
  } finally { await context.app.close(); rmSync(context.dataDir, { recursive: true, force: true }); }
});
