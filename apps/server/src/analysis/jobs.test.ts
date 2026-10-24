import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { strToU8, zipSync } from "fflate";
import { expect, test, vi } from "vitest";
import { createApp } from "../app.js";
import type { AgentRunner } from "../agents/runner.js";

const maintainerRoot = resolve(process.cwd(), "../../../open-context-forge-vault-maintainer");
const readerRoot = resolve(process.cwd(), "../../../open-context-article-reader");
const headers = { "x-ocf-client": "1" };

function candidate(id: string) {
  const markdown = `原文证据 ${id}`;
  const url = `https://example.org/${id}`;
  return { schemaVersion: 1, id,
    source: { originalUrl: url, canonicalUrl: url, title: `资料 ${id}` },
    content: { markdown, wordCount: markdown.length, imageUrls: [] },
    capture: { capturedAt: "2026-10-24T00:00:00Z", extractor: "readability",
      contentHash: createHash("sha256").update(markdown).digest("hex"), warnings: [] },
    user: {}, delivery: { status: "queued", attempts: 0 } };
}

async function importCaptures(app: ReturnType<typeof createApp>, ids: string[]) {
  const archive = zipSync({ "captures.json": strToU8(JSON.stringify(ids.map(candidate))) });
  const boundary = `ocf-analysis-jobs-${randomUUID()}`;
  const response = await app.inject({ method: "POST", url: "/api/v1/imports/preflight",
    headers: { ...headers, "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="captures.zip"\r\nContent-Type: application/zip\r\n\r\n`),
      Buffer.from(archive), Buffer.from(`\r\n--${boundary}--\r\n`)]) });
  expect(response.statusCode).toBe(201);
  return response.json().batchId as string;
}

const runnerResult = (prompt: string) => {
  const line = prompt.split("\n").find((part) => /^L\d+ /.test(part) && part.includes("原文证据"));
  const number = Number(line?.match(/^L(\d+)/)?.[1]);
  const excerpt = line?.match(/原文证据 \w+/)?.[0] ?? "";
  return { sessionId: "job-test", text: JSON.stringify({ summary: "资料摘要",
    mainPoints: [{ claim: "作者给出原文证据", kind: "article_statement",
      evidence: [{ startLine: number, endLine: number, excerpt }] }],
    limitations: [], recommendation: "defer", reason: "待核对" }) };
};

test("analysis jobs return immediately, run in the server, and persist a card after the page leaves", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-analysis-jobs-"));
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const began = new Promise<void>((resolve) => { started = resolve; });
  const runner: AgentRunner = async (input) => { started(); await gate; return runnerResult(input.prompt); };
  const app = createApp({ dataDir, maintainerRoot, readerRoot,
    agentOptions: { runner, environment: {}, claudePath: "/fake/claude" } });
  try {
    const batchId = await importCaptures(app, ["one", "two"]);
    const request = { items: [{ batchId, captureId: "one" }, { batchId, captureId: "two" }] };
    const accepted = await app.inject({ method: "POST", url: "/api/v1/analysis/jobs", headers, payload: request });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json().jobs).toHaveLength(2);
    await began;
    const duplicate = await app.inject({ method: "POST", url: "/api/v1/analysis/jobs", headers,
      payload: { items: [{ batchId, captureId: "one" }] } });
    expect(duplicate.json().jobs[0].id).toBe(accepted.json().jobs[0].id);
    await app.inject({ method: "GET", url: "/api/v1/vaults" });
    const whileRunning = (await app.inject({ method: "GET", url: "/api/v1/analysis/jobs" })).json().jobs;
    expect(whileRunning.find((job: { captureId: string }) => job.captureId === "one").status).toBe("running");
    expect(whileRunning.find((job: { captureId: string }) => job.captureId === "two").status).toBe("queued");
    release();
    await vi.waitFor(async () => {
      const response = await app.inject({ method: "GET", url: "/api/v1/analysis/jobs" });
      expect(response.json().jobs.filter((job: { status: string }) => job.status === "completed")).toHaveLength(2);
    }, { timeout: 5000, interval: 20 });
    const card = await app.inject({ method: "GET", url: `/api/v1/imports/${batchId}/items/one/analysis` });
    expect(card.statusCode).toBe(200);
    expect(card.json().status).toBe("proposed");
    const secondCard = await app.inject({ method: "GET", url: `/api/v1/imports/${batchId}/items/two/analysis` });
    expect(secondCard.statusCode).toBe(200);
  } finally { release(); await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("an unfinished analysis job resumes from SQLite when the server starts again", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-analysis-job-resume-"));
  const options = { dataDir, maintainerRoot, readerRoot,
    agentOptions: { runner: (async (input) => runnerResult(input.prompt)) as AgentRunner,
      environment: {}, claudePath: "/fake/claude" } };
  const first = createApp(options);
  let second: ReturnType<typeof createApp> | null = null;
  try {
    const batchId = await importCaptures(first, ["resume"]);
    await first.close();
    const db = new Database(join(dataDir, "state.sqlite"));
    const jobId = randomUUID();
    db.prepare(`INSERT INTO analysis_jobs
      (id, batch_id, capture_id, status, error_code, created_at, updated_at)
      VALUES (?, ?, ?, 'running', NULL, ?, ?)`).run(jobId, batchId, "resume", new Date().toISOString(), new Date().toISOString());
    db.close();
    second = createApp(options);
    await second.inject({ method: "GET", url: "/api/v1/vaults" });
    await vi.waitFor(async () => {
      const response = await second!.inject({ method: "GET", url: "/api/v1/analysis/jobs" });
      expect(response.json().jobs.find((job: { id: string }) => job.id === jobId)?.status).toBe("completed");
    }, { timeout: 5000, interval: 20 });
    const card = await second.inject({ method: "GET", url: `/api/v1/imports/${batchId}/items/resume/analysis` });
    expect(card.statusCode).toBe(200);
  } finally { if (second) await second.close(); rmSync(dataDir, { recursive: true, force: true }); }
});
