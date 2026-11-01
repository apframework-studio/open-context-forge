import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { expect, test, vi } from "vitest";
import { createApp } from "../app.js";

const headers = { "x-ocf-client": "1" };
const maintainerRoot = resolve(process.cwd(), "../../../open-context-forge-vault-maintainer");
function upload() {
  const boundary = "ocf-recovery";
  return { headers: { ...headers, "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="recovery.md"\r\nContent-Type: text/markdown\r\n\r\n# Recovery\n\nContent\r\n--${boundary}--\r\n`) };
}

test("restart completes a filed job when its verified membership survived", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-filing-recover-complete-"));
  const first = createApp({ dataDir, maintainerRoot });
  let second: ReturnType<typeof createApp> | null = null;
  try {
    const batch = (await first.inject({ method: "POST", url: "/api/v1/imports/preflight", ...upload() })).json();
    const accepted = await first.inject({ method: "POST", url: `/api/v1/imports/${batch.batchId}/items/${batch.candidates[0].id}/commit`,
      headers, payload: { vaultId: "default" } });
    const id = accepted.json().job.id as string;
    await vi.waitFor(async () => {
      const job = (await first.inject({ method: "GET", url: "/api/v1/imports/filing-jobs" })).json().jobs[0];
      expect(job.status).toBe("completed");
    });
    await first.close();
    const db = new Database(join(dataDir, "state.sqlite"));
    db.prepare("UPDATE filing_jobs SET status = 'running', result_json = NULL, run_token = 'old', stage = 'writing' WHERE id = ?").run(id);
    db.close();
    second = createApp({ dataDir, maintainerRoot });
    const recovered = (await second.inject({ method: "GET", url: "/api/v1/imports/filing-jobs" })).json().jobs[0];
    expect(recovered).toMatchObject({ id, status: "completed", errorCode: null });
    expect(recovered.result.snapshot).toBeTruthy();
  } finally { await first.close(); if (second) await second.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("restart retains an unknown raw lock for human inspection", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-filing-recover-lock-"));
  const first = createApp({ dataDir, maintainerRoot });
  let second: ReturnType<typeof createApp> | null = null;
  try {
    await first.inject({ method: "PUT", url: "/api/v1/imports/policy", headers,
      payload: { mode: "manual" } });
    const batch = (await first.inject({ method: "POST", url: "/api/v1/imports/preflight", ...upload() })).json();
    await first.close();
    const db = new Database(join(dataDir, "state.sqlite"));
    const id = "interrupted";
    db.prepare(`INSERT INTO filing_jobs (id,batch_id,capture_id,vault_id,status,stage,attempt,run_token,created_at,updated_at)
      VALUES (?, ?, ?, 'default', 'running', 'writing', 1, 'old', ?, ?)`).run(id, batch.batchId, batch.candidates[0].id,
      new Date().toISOString(), new Date().toISOString());
    db.close();
    writeFileSync(join(dataDir, "vaults", "default", ".ocf", "ingest.lock"), "unknown");
    second = createApp({ dataDir, maintainerRoot });
    const recovered = (await second.inject({ method: "GET", url: "/api/v1/imports/filing-jobs" })).json().jobs[0];
    expect(recovered).toMatchObject({ id, status: "needs_attention", errorCode: "RAW_WRITE_UNCERTAIN" });
  } finally { await first.close(); if (second) await second.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("restart backfills a verified source key mapping for legacy filed rows", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-filing-backfill-"));
  const first = createApp({ dataDir, maintainerRoot });
  let second: ReturnType<typeof createApp> | null = null;
  try {
    const batch = (await first.inject({ method: "POST", url: "/api/v1/imports/preflight", ...upload() })).json();
    const id = (await first.inject({ method: "POST",
      url: `/api/v1/imports/${batch.batchId}/items/${batch.candidates[0].id}/commit`,
      headers, payload: { vaultId: "default" } })).json().job.id;
    await vi.waitFor(async () => {
      const job = (await first.inject({ method: "GET", url: "/api/v1/imports/filing-jobs" })).json().jobs
        .find((entry: { id: string }) => entry.id === id);
      expect(job.status).toBe("completed");
    });
    await first.close();
    const db = new Database(join(dataDir, "state.sqlite"));
    db.prepare("DELETE FROM vault_source_keys").run();
    db.prepare("UPDATE import_items SET source_key = NULL WHERE batch_id = ?").run(batch.batchId);
    db.close();
    second = createApp({ dataDir, maintainerRoot });
    await second.inject({ method: "GET", url: "/api/v1/health" });
    const reopened = new Database(join(dataDir, "state.sqlite"));
    try {
      const count = reopened.prepare("SELECT COUNT(*) AS n FROM vault_source_keys").get() as { n: number };
      expect(count.n).toBe(1);
      const key = reopened.prepare("SELECT source_key FROM import_items WHERE batch_id = ?")
        .get(batch.batchId) as { source_key: string };
      expect(key.source_key).toMatch(/^[a-f\d]{64}$/);
    } finally { reopened.close(); }
  } finally { await first.close(); if (second) await second.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("recovery refuses a manifest whose attribution differs from the item", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-filing-recover-attribution-"));
  const first = createApp({ dataDir, maintainerRoot });
  let second: ReturnType<typeof createApp> | null = null;
  try {
    await first.inject({ method: "PUT", url: "/api/v1/imports/policy", headers, payload: { mode: "manual" } });
    const batch = (await first.inject({ method: "POST", url: "/api/v1/imports/preflight", ...upload() })).json();
    const id = (await first.inject({ method: "POST",
      url: `/api/v1/imports/${batch.batchId}/items/${batch.candidates[0].id}/commit`,
      headers, payload: { vaultId: "default" } })).json().job.id;
    await vi.waitFor(async () => expect((await first.inject({ method: "GET",
      url: "/api/v1/imports/filing-jobs" })).json().jobs[0].status).toBe("completed"));
    await first.close();
    const db = new Database(join(dataDir, "state.sqlite"));
    try {
      db.prepare("DELETE FROM import_item_vaults WHERE batch_id = ?").run(batch.batchId);
      db.prepare("UPDATE import_items SET authorship = 'third_party' WHERE batch_id = ?").run(batch.batchId);
      db.prepare("UPDATE filing_jobs SET status = 'running', stage = 'writing', run_token = 'old' WHERE id = ?").run(id);
    } finally { db.close(); }
    second = createApp({ dataDir, maintainerRoot });
    const recovered = (await second.inject({ method: "GET", url: "/api/v1/imports/filing-jobs" })).json().jobs[0];
    expect(recovered).toMatchObject({ id, status: "needs_attention", errorCode: "RAW_WRITE_UNCERTAIN" });
  } finally { await first.close(); if (second) await second.close(); rmSync(dataDir, { recursive: true, force: true }); }
}, 15_000);
