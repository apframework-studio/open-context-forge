import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, vi } from "vitest";
import { createApp } from "../app.js";
import type { AgentRunner } from "../agents/runner.js";
import Database from "better-sqlite3";
import { openDatabase } from "../state/db.js";
import { AnalysisJobs } from "./jobs.js";
import type { AnalysisService } from "./service.js";

const headers = { "x-ocf-client": "1" };
const maintainerRoot = resolve(process.cwd(), "../../../open-context-forge-vault-maintainer");
function upload(id: string) {
  const boundary = `ocf-maint-${id}`;
  return { headers: { ...headers, "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${id}.md"\r\nContent-Type: text/markdown\r\n\r\n# ${id}\n\nEvidence ${id}\r\n--${boundary}--\r\n`) };
}
function decisionRunner(decision: "defer" | "ask_user", failFirst = false): AgentRunner {
  let failed = false;
  return async (input) => {
    if (failFirst && !failed) { failed = true; throw new Error("AGENT_TIMEOUT"); }
    const fingerprint = input.prompt.match(/Source fingerprint: ([a-f\d]{64})/)?.[1]!;
    if (input.prompt.includes("<analysis_stage>")) {
      const source = input.prompt.match(/^L(\d+) (Evidence [^\n]+)/m)!;
      return { sessionId: "analysis", text: JSON.stringify({ fingerprint, summary: "Evidence",
        mainPoints: [{ claim: "Evidence", kind: "article_statement", evidence: [{ startLine: Number(source[1]),
          endLine: Number(source[1]), excerpt: source[2] }] }], limitations: [], recommendation: decision, reason: "Needs judgment" }) };
    }
    return { sessionId: "plan", text: JSON.stringify({ fingerprint, decision, reason: "Needs judgment", changes: [] }) };
  };
}

test("ask_user is attention while ordinary defer is skipped", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-maint-decisions-"));
  const app = createApp({ dataDir, maintainerRoot, agentOptions: { runner: decisionRunner("ask_user"), claudePath: "/fake/claude" } });
  try {
    await app.inject({ method: "PUT", url: "/api/v1/vaults/default/maintenance-policy", headers, payload: { enabled: true } });
    await app.inject({ method: "POST", url: "/api/v1/imports/preflight", ...upload("judgment") });
    await vi.waitFor(async () => {
      const jobs = (await app.inject({ method: "GET", url: "/api/v1/maintenance/jobs" })).json().jobs;
      expect(jobs[0]).toMatchObject({ status: "needs_attention", result: { recommendation: "ask_user" } });
    }, { timeout: 5000, interval: 20 });
    const id = (await app.inject({ method: "GET", url: "/api/v1/maintenance/jobs" })).json().jobs[0].id;
    const resolved = await app.inject({ method: "POST", url: `/api/v1/maintenance/jobs/${id}/resolve`, headers,
      payload: { decision: "keep_raw_only" } });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().job).toMatchObject({ status: "skipped", result: { recommendation: "keep_raw_only" } });
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
}, 15_000);

test("read-only Claude timeout waits for retry while a later source continues", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-maint-retry-"));
  const app = createApp({ dataDir, maintainerRoot, agentOptions: { runner: decisionRunner("defer", true), claudePath: "/fake/claude" } });
  try {
    await app.inject({ method: "PUT", url: "/api/v1/vaults/default/maintenance-policy", headers, payload: { enabled: true } });
    await app.inject({ method: "POST", url: "/api/v1/imports/preflight", ...upload("first") });
    await app.inject({ method: "POST", url: "/api/v1/imports/preflight", ...upload("second") });
    await vi.waitFor(async () => {
      const jobs = (await app.inject({ method: "GET", url: "/api/v1/maintenance/jobs" })).json().jobs;
      expect(jobs).toHaveLength(2);
      expect(jobs.map((job: { status: string }) => job.status).sort()).toEqual(["retry_wait", "skipped"]);
      expect(jobs.find((job: { status: string }) => job.status === "retry_wait").nextRetryAt).toBeTruthy();
    }, { timeout: 5000, interval: 20 });
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
}, 15_000);

test("missing Claude pauses one shared lane without consuming every queued source", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-maint-lane-pause-"));
  const app = createApp({ dataDir, maintainerRoot, agentOptions: { claudePath: null } });
  try {
    await app.inject({ method: "PUT", url: "/api/v1/vaults/default/maintenance-policy", headers, payload: { enabled: true } });
    await app.inject({ method: "POST", url: "/api/v1/imports/preflight", ...upload("lane-first") });
    await app.inject({ method: "POST", url: "/api/v1/imports/preflight", ...upload("lane-second") });
    await vi.waitFor(async () => {
      const jobs = (await app.inject({ method: "GET", url: "/api/v1/maintenance/jobs" })).json().jobs;
      expect(jobs).toHaveLength(2);
      expect(jobs.map((job: { status: string }) => job.status).sort()).toEqual(["blocked", "queued"]);
      expect((await app.inject({ method: "GET", url: "/api/v1/maintenance/lane" })).json()).toEqual({ pausedReason: "AGENT_UNAVAILABLE" });
    }, { timeout: 5000, interval: 20 });
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
}, 15_000);

test("service stop cancels an active Claude stage and leaves read-only work queued", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-maint-stop-"));
  let started!: () => void;
  const began = new Promise<void>((resolve) => { started = resolve; });
  const runner: AgentRunner = (input) => new Promise((_resolve, reject) => {
    started();
    input.signal?.addEventListener("abort", () => reject(new Error("AGENT_CANCELLED")), { once: true });
  });
  const app = createApp({ dataDir, maintainerRoot,
    agentOptions: { runner, claudePath: "/fake/claude" } });
  try {
    await app.inject({ method: "PUT", url: "/api/v1/vaults/default/maintenance-policy",
      headers, payload: { enabled: true } });
    await app.inject({ method: "POST", url: "/api/v1/imports/preflight", ...upload("stop-me") });
    await began;
    await app.close();
    const db = new Database(join(dataDir, "state.sqlite"));
    try {
      const row = db.prepare("SELECT status, child_pid FROM analysis_jobs WHERE mode = 'maintain' LIMIT 1")
        .get() as { status: string; child_pid: number | null };
      expect(row).toMatchObject({ status: "queued", child_pid: null });
    } finally { db.close(); }
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
}, 15_000);

test("manual cancellation stops a read-only maintenance stage", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-maint-cancel-"));
  let started!: () => void;
  const began = new Promise<void>((resolve) => { started = resolve; });
  const runner: AgentRunner = (input) => new Promise((_resolve, reject) => {
    started();
    input.signal?.addEventListener("abort", () => reject(new Error("AGENT_CANCELLED")), { once: true });
  });
  const app = createApp({ dataDir, maintainerRoot,
    agentOptions: { runner, claudePath: "/fake/claude" } });
  try {
    await app.inject({ method: "PUT", url: "/api/v1/vaults/default/maintenance-policy",
      headers, payload: { enabled: true } });
    await app.inject({ method: "POST", url: "/api/v1/imports/preflight", ...upload("cancel-me") });
    await began;
    const jobs = (await app.inject({ method: "GET", url: "/api/v1/maintenance/jobs" })).json().jobs;
    const cancelled = await app.inject({ method: "POST", url: `/api/v1/maintenance/jobs/${jobs[0].id}/cancel`, headers });
    expect(cancelled.statusCode).toBe(200);
    await vi.waitFor(async () => {
      const current = (await app.inject({ method: "GET", url: "/api/v1/maintenance/jobs" })).json().jobs[0];
      expect(current).toMatchObject({ status: "cancelled", stage: "cancelled" });
    });
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
}, 15_000);

test("a queued direct Claude call rechecks a lane paused by the preceding call", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-analysis-tail-pause-"));
  const db = openDatabase(dataDir);
  const jobs = new AnalysisJobs(db, {} as AnalysisService);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  try {
    const first = jobs.runExclusive(async () => { markStarted(); await gate; });
    await started;
    let startedSecond = false;
    const second = jobs.runExclusive(async () => { startedSecond = true; });
    db.prepare("UPDATE analysis_lane_state SET paused_reason = 'AGENT_EXIT_UNCONFIRMED' WHERE id = 1").run();
    release();
    await first;
    await expect(second).rejects.toMatchObject({ code: "AGENT_LANE_PAUSED" });
    expect(startedSecond).toBe(false);
  } finally { await jobs.stop(); db.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("metadata correction waits for active Claude work and prevents the next claim", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-metadata-serial-"));
  const db = openDatabase(dataDir);
  const jobs = new AnalysisJobs(db, {} as AnalysisService);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const order: string[] = [];
  try {
    const first = jobs.runExclusive(async () => { markStarted(); await gate; order.push("analysis"); });
    await started;
    const correction = jobs.runMetadataCorrection(async () => { order.push("correction"); });
    const next = jobs.runExclusive(async () => { order.push("next"); });
    expect(order).toEqual([]);
    release();
    await Promise.all([first, correction, next]);
    expect(order).toEqual(["analysis", "correction", "next"]);
  } finally { await jobs.stop(); db.close(); rmSync(dataDir, { recursive: true, force: true }); }
});
