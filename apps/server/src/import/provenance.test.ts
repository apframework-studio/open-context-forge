import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, vi } from "vitest";
import Database from "better-sqlite3";
import { createApp } from "../app.js";

const headers = { "x-ocf-client": "1" };
const maintainerRoot = resolve(process.cwd(), "../../../open-context-forge-vault-maintainer");
function upload(text: string) {
  const boundary = "ocf-provenance";
  return { headers: { ...headers, "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="author.md"\r\nContent-Type: text/markdown\r\n\r\n${text}\r\n--${boundary}--\r\n`) };
}

test("fresh install auto-files to default vault with unknown authorship and preserves an upgraded policy", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-provenance-policy-"));
  const first = createApp({ dataDir, maintainerRoot });
  let second: ReturnType<typeof createApp> | null = null;
  try {
    const initial = (await first.inject({ method: "GET", url: "/api/v1/imports/policy" })).json();
    expect(initial).toEqual({ mode: "auto-file", vaultId: "default", defaultAuthorship: "unknown" });
    const saved = await first.inject({ method: "PUT", url: "/api/v1/imports/policy", headers,
      payload: { mode: "manual", defaultAuthorship: "third_party" } });
    expect(saved.json()).toEqual({ mode: "manual", vaultId: null, defaultAuthorship: "third_party" });
    await first.close();
    second = createApp({ dataDir, maintainerRoot });
    expect((await second.inject({ method: "GET", url: "/api/v1/imports/policy" })).json()).toEqual(saved.json());
  } finally { await first.close(); if (second) await second.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("item override changes attribution without altering detected author evidence", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-provenance-item-"));
  const app = createApp({ dataDir, maintainerRoot });
  try {
    await app.inject({ method: "PUT", url: "/api/v1/imports/policy", headers,
      payload: { mode: "manual", defaultAuthorship: "third_party" } });
    const uploaded = (await app.inject({ method: "POST", url: "/api/v1/imports/preflight",
      ...upload("---\nauthor: Ada Lovelace\n---\n# Engines\n\nBody") })).json();
    const { batchId } = uploaded;
    const captureId = uploaded.candidates[0].id;
    const before = uploaded.candidates[0];
    expect(before).toMatchObject({ author: "Ada Lovelace", authorship: "third_party",
      authorEvidence: { kind: "frontmatter" }, metadataVersion: 0 });
    const changed = await app.inject({ method: "PATCH", url: `/api/v1/imports/${batchId}/items/${captureId}/metadata`,
      headers, payload: { expectedVersion: 0, authorship: "self", author: "Ada Lovelace" } });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ authorship: "self", authorEvidence: { kind: "frontmatter" }, metadataVersion: 1 });
    const listed = (await app.inject({ method: "GET", url: "/api/v1/imports/items?view=all" })).json();
    expect(listed.items[0]).toMatchObject({ author: "Ada Lovelace", authorship: "self",
      authorEvidence: { kind: "frontmatter" }, metadataVersion: 1 });
    const stale = await app.inject({ method: "PATCH", url: `/api/v1/imports/${batchId}/items/${captureId}/metadata`,
      headers, payload: { expectedVersion: 0, authorship: "unknown" } });
    expect(stale.statusCode).toBe(409);
    const accepted = await app.inject({ method: "POST", url: `/api/v1/imports/${batchId}/items/${captureId}/commit`,
      headers, payload: { vaultId: "default" } });
    await vi.waitFor(async () => {
      const job = (await app.inject({ method: "GET", url: "/api/v1/imports/filing-jobs" })).json().jobs
        .find((entry: { id: string }) => entry.id === accepted.json().job.id);
      expect(job.status).toBe("completed");
    }, { timeout: 5000, interval: 20 });
    const manifest = JSON.parse(readFileSync(join(dataDir, "vaults", "default", ".ocf", "ingest-manifest.json"), "utf8"));
    const source = Object.values(manifest.sources)[0] as { authorship: string; author: string };
    expect(source).toMatchObject({ authorship: "self", author: "Ada Lovelace" });
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
}, 15_000);

test("metadata stays frozen while an uncertain raw write awaits inspection", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-provenance-uncertain-"));
  const app = createApp({ dataDir, maintainerRoot });
  try {
    await app.inject({ method: "PUT", url: "/api/v1/imports/policy", headers, payload: { mode: "manual" } });
    const batch = (await app.inject({ method: "POST", url: "/api/v1/imports/preflight",
      ...upload("# Uncertain\n\nBody") })).json();
    const captureId = batch.candidates[0].id;
    const db = new Database(join(dataDir, "state.sqlite"));
    try { db.prepare(`INSERT INTO filing_jobs (id,batch_id,capture_id,vault_id,status,stage,attempt,created_at,updated_at)
      VALUES ('uncertain',?,?,'default','needs_attention','reconcile',1,?,?)`)
      .run(batch.batchId, captureId, new Date().toISOString(), new Date().toISOString()); }
    finally { db.close(); }
    const changed = await app.inject({ method: "PATCH",
      url: `/api/v1/imports/${batch.batchId}/items/${captureId}/metadata`, headers,
      payload: { expectedVersion: 0, authorship: "third_party" } });
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error).toBe("SOURCE_BUSY");
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
}, 15_000);
