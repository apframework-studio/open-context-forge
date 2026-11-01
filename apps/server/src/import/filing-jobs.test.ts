import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { insertBatch, openDatabase } from "../state/db.js";
import { FilingJobs } from "./filing-jobs.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ocf-filing-queue-"));
  const db = openDatabase(dir);
  insertBatch(db, { batchId: "batch", createdAt: "2026-10-29T00:00:00Z", candidates: ["first", "second"].map((id) => ({
    id, title: id, originalUrl: null, sourceFilename: `${id}.md`, capturedAt: "2026-10-29T00:00:00Z",
    markdown: `# ${id}`, contentHash: "a".repeat(64), warnings: [], status: "ready" as const,
  })) });
  return { dir, db, close: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("filing jobs are durable, unique per item and vault, and execute one at a time", async () => {
  const { db, close } = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let active = 0;
  let maximum = 0;
  const jobs = new FilingJobs(db, async (job) => {
    active++;
    maximum = Math.max(maximum, active);
    if (job.captureId === "first") await gate;
    active--;
    return { vaultId: job.vaultId, snapshot: `raw/${job.captureId}.md`, fingerprint: "b".repeat(64), duplicate: false, analysisSyncError: false };
  });
  try {
    const first = jobs.enqueue("batch", "first", "default");
    expect(jobs.enqueue("batch", "first", "default").id).toBe(first.id);
    const second = jobs.enqueue("batch", "second", "default");
    jobs.resume();
    await vi.waitFor(() => expect(jobs.list().find((job) => job.id === first.id)?.status).toBe("running"));
    expect(jobs.list().find((job) => job.id === second.id)?.status).toBe("queued");
    release();
    await vi.waitFor(() => expect(jobs.list().map((job) => job.status)).toEqual(["completed", "completed"]));
    expect(maximum).toBe(1);
  } finally { release(); await jobs.stop(); close(); }
});

test("one failed filing needs attention while the next queued item proceeds", async () => {
  const { db, close } = fixture();
  const jobs = new FilingJobs(db, async (job) => {
    if (job.captureId === "first") throw new Error("VAULT_IMPORT_FAILED");
    return { vaultId: job.vaultId, snapshot: "raw/second.md", fingerprint: "b".repeat(64), duplicate: false, analysisSyncError: false };
  });
  try {
    jobs.enqueue("batch", "first", "default");
    jobs.enqueue("batch", "second", "default");
    jobs.resume();
    await vi.waitFor(() => expect(jobs.list().map((job) => job.status)).toEqual(["needs_attention", "completed"]));
  } finally { await jobs.stop(); close(); }
});

test("cancels queued work and preserves interrupted writes for inspection on restart", async () => {
  const { dir, db, close } = fixture();
  const first = new FilingJobs(db, async (job) => ({ vaultId: job.vaultId,
    snapshot: "raw/x.md", fingerprint: "b".repeat(64), duplicate: false, analysisSyncError: false }));
  const queued = first.enqueue("batch", "second", "default");
  expect(first.cancel(queued.id).status).toBe("cancelled");
  const interrupted = first.enqueue("batch", "first", "default");
  db.prepare("UPDATE filing_jobs SET status = 'running', run_token = 'old', stage = 'writing' WHERE id = ?").run(interrupted.id);
  await first.stop();
  db.close();
  const reopened = openDatabase(dir);
  const resumed = new FilingJobs(reopened, async () => { throw new Error("should not run uncertain write"); });
  try {
    resumed.resume();
    expect(resumed.list().find((job) => job.id === interrupted.id)).toMatchObject({ status: "needs_attention", errorCode: "RAW_WRITE_UNCERTAIN" });
  } finally { await resumed.stop(); reopened.close(); rmSync(dir, { recursive: true, force: true }); }
  void close;
});

test("manual submission can requeue a previously cancelled filing", async () => {
  const { db, close } = fixture();
  const jobs = new FilingJobs(db, async (job) => ({ vaultId: job.vaultId,
    snapshot: "raw/first.md", fingerprint: "b".repeat(64), duplicate: false, analysisSyncError: false }));
  try {
    const cancelled = jobs.cancel(jobs.enqueue("batch", "first", "default").id);
    expect(cancelled.status).toBe("cancelled");
    const submitted = jobs.enqueue("batch", "first", "default");
    expect(submitted).toMatchObject({ id: cancelled.id, status: "queued", stage: "queued" });
    await jobs.resume();
    await vi.waitFor(() => expect(jobs.get(cancelled.id)?.status).toBe("completed"));
  } finally { await jobs.stop(); close(); }
});

test("unconfirmed child exit pauses the raw lane without starting another item", async () => {
  const { db, close } = fixture();
  let secondRan = false;
  const jobs = new FilingJobs(db, async (job) => {
    if (job.captureId === "first") throw new Error("PROCESS_EXIT_UNCONFIRMED");
    secondRan = true;
    return { vaultId: job.vaultId, snapshot: "raw/second.md", fingerprint: "b".repeat(64), duplicate: false, analysisSyncError: false };
  });
  try {
    jobs.enqueue("batch", "first", "default");
    jobs.enqueue("batch", "second", "default");
    await jobs.resume();
    await vi.waitFor(() => expect(jobs.list()[0].status).toBe("needs_attention"));
    expect(jobs.list()[1].status).toBe("queued");
    expect(secondRan).toBe(false);
    expect(jobs.laneState()).toEqual({ pausedReason: "PROCESS_EXIT_UNCONFIRMED" });
  } finally { await jobs.stop(); close(); }
});

test("inspection requeues only when reconciliation proves raw was not written", async () => {
  const { db, close } = fixture();
  let ran = false;
  const jobs = new FilingJobs(db, async (job) => {
    ran = true;
    return { vaultId: job.vaultId, snapshot: "raw/first.md", fingerprint: "b".repeat(64), duplicate: false, analysisSyncError: false };
  }, async () => "retryable");
  try {
    const job = jobs.enqueue("batch", "first", "default");
    db.prepare(`UPDATE filing_jobs SET status = 'needs_attention', stage = 'reconcile',
      error_code = 'RAW_WRITE_UNCERTAIN' WHERE id = ?`).run(job.id);
    await jobs.resume();
    expect(() => jobs.retry(job.id)).toThrow("FILING_INSPECTION_REQUIRED");
    const inspected = await jobs.inspect(job.id);
    expect(["queued", "running", "completed"]).toContain(inspected.status);
    await vi.waitFor(() => expect(jobs.get(job.id)?.status).toBe("completed"));
    expect(ran).toBe(true);
  } finally { await jobs.stop(); close(); }
});

test("a proven unwritten raw failure retries later without blocking another source", async () => {
  const { db, close } = fixture();
  let firstAttempts = 0;
  const jobs = new FilingJobs(db, async (job) => {
    if (job.captureId === "first" && firstAttempts++ === 0) throw new Error("VAULT_IMPORT_FAILED");
    return { vaultId: job.vaultId, snapshot: `raw/${job.captureId}.md`,
      fingerprint: "b".repeat(64), duplicate: false, analysisSyncError: false };
  }, async () => "retryable");
  try {
    const first = jobs.enqueue("batch", "first", "default");
    const second = jobs.enqueue("batch", "second", "default");
    await jobs.resume();
    await vi.waitFor(() => {
      expect(jobs.get(first.id)).toMatchObject({ status: "retry_wait", attempt: 1 });
      expect(jobs.get(first.id)?.nextRetryAt).toBeTruthy();
      expect(jobs.get(second.id)?.status).toBe("completed");
    });
    db.prepare("UPDATE filing_jobs SET next_retry_at = '2000-01-01T00:00:00Z' WHERE id = ?").run(first.id);
    jobs.wake();
    await vi.waitFor(() => expect(jobs.get(first.id)?.status).toBe("completed"));
  } finally { await jobs.stop(); close(); }
});
