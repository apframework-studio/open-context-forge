import { mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { createApp } from "../app.js";

const headers = { "x-ocf-client": "1" };
const maintainerRoot = resolve(process.cwd(), "../../../open-context-forge-vault-maintainer");
function upload() {
  const boundary = "ocf-attention";
  return { headers: { ...headers, "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="attention.md"\r\nContent-Type: text/markdown\r\n\r\n# Attention\n\nBody\r\n--${boundary}--\r\n`) };
}

test("projects unresolved jobs and reminds once per local day after 24 hours", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-attention-"));
  const app = createApp({ dataDir, maintainerRoot });
  try {
    await app.inject({ method: "PUT", url: "/api/v1/imports/policy", headers, payload: { mode: "manual" } });
    const batch = (await app.inject({ method: "POST", url: "/api/v1/imports/preflight", ...upload() })).json();
    const captureId = batch.candidates[0].id;
    const db = new Database(join(dataDir, "state.sqlite"));
    try {
      const old = "2026-10-27T00:00:00Z";
      db.prepare(`INSERT INTO filing_jobs (id,batch_id,capture_id,vault_id,status,stage,attempt,error_code,created_at,updated_at)
        VALUES ('filing-attention',?,?, 'default','needs_attention','reconcile',1,'RAW_WRITE_UNCERTAIN',?,?)`)
        .run(batch.batchId, captureId, old, old);
      db.prepare(`INSERT INTO analysis_jobs (id,batch_id,capture_id,mode,vault_id,fingerprint,snapshot,status,stage,attempt,
        result_json,created_at,updated_at) VALUES ('maintenance-attention',?,?,'maintain','default',?,?,'needs_attention',
        'complete',1,?,?,?)`).run(batch.batchId, captureId, "a".repeat(64), "raw/a.md",
        JSON.stringify({ recommendation: "ask_user" }), old, old);
      db.prepare(`INSERT INTO analysis_jobs (id,batch_id,capture_id,mode,vault_id,fingerprint,snapshot,status,stage,attempt,
        result_json,created_at,updated_at) VALUES ('normal-skip',?,?,'maintain','default',?,?,'skipped',
        'complete',1,?,?,?)`).run(batch.batchId, captureId, "b".repeat(64), "raw/b.md",
        JSON.stringify({ recommendation: "defer" }), old, old);
    } finally { db.close(); }
    const processDir = join(dataDir, "vaults", "default", ".ocf", "compilations", "a".repeat(64));
    mkdirSync(processDir, { recursive: true });
    writeFileSync(join(processDir, "plan.md"), "# Plan\n");
    writeFileSync(join(processDir, "journal.json"), JSON.stringify({ status: "needs_attention",
      paths: [{ path: "wiki/concepts/example.md" }] }));
    const path = "/api/v1/attention?localDate=2026-10-29";
    const first = (await app.inject({ method: "GET", url: path })).json();
    expect(first.count).toBe(2);
    expect(first.reminderDue).toBe(true);
    expect(first.items.map((item: { id: string }) => item.id).sort()).toEqual(["filing:filing-attention", "maintenance:maintenance-attention"]);
    const detail = (await app.inject({ method: "GET",
      url: "/api/v1/attention/maintenance:maintenance-attention" })).json();
    expect(detail).toMatchObject({ snapshot: "raw/a.md", plan: { markdown: "# Plan\n" },
      targets: ["wiki/concepts/example.md"] });
    const outsidePlan = join(dataDir, "outside-plan.md");
    writeFileSync(outsidePlan, "private outside content");
    unlinkSync(join(processDir, "plan.md"));
    symlinkSync(outsidePlan, join(processDir, "plan.md"));
    const guarded = (await app.inject({ method: "GET",
      url: "/api/v1/attention/maintenance:maintenance-attention" })).json();
    expect(guarded.plan).toBeNull();
    const seen = await app.inject({ method: "POST", url: "/api/v1/attention/reminder-seen", headers,
      payload: { localDate: "2026-10-29" } });
    expect(seen.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: path })).json().reminderDue).toBe(false);
    expect((await app.inject({ method: "GET", url: "/api/v1/attention?localDate=2026-10-30" })).json().reminderDue).toBe(true);
    const paused = new Database(join(dataDir, "state.sqlite"));
    try { paused.prepare("UPDATE filing_lane_state SET paused_reason = 'PROCESS_EXIT_UNCONFIRMED' WHERE id = 1").run(); }
    finally { paused.close(); }
    const withLane = (await app.inject({ method: "GET", url: path })).json();
    expect(withLane.count).toBe(3);
    expect(withLane.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: "lane:filing", kind: "lane" })]));
    const refreshed = new Database(join(dataDir, "state.sqlite"));
    try {
      refreshed.prepare("UPDATE filing_jobs SET updated_at = ? WHERE id = 'filing-attention'")
        .run(new Date().toISOString());
      refreshed.prepare("UPDATE analysis_jobs SET updated_at = ? WHERE id = 'maintenance-attention'")
        .run(new Date().toISOString());
    } finally { refreshed.close(); }
    expect((await app.inject({ method: "GET", url: "/api/v1/attention?localDate=2026-10-31" }))
      .json().reminderDue).toBe(false);
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});
