import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, vi } from "vitest";
import Database from "better-sqlite3";
import { createApp } from "../app.js";

const maintainerRoot = resolve(process.cwd(), "../../../open-context-forge-vault-maintainer");
const headers = { "x-ocf-client": "1" };
test("filed metadata correction updates manifest and item, preserving raw bytes", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-provenance-correct-"));
  const app = createApp({ dataDir, maintainerRoot });
  try {
    await app.inject({ method: "PUT", url: "/api/v1/imports/policy", headers,
      payload: { mode: "manual", defaultAuthorship: "unknown" } });
    const boundary = "ocf-correction";
    const uploaded = (await app.inject({ method: "POST", url: "/api/v1/imports/preflight",
      headers: { ...headers, "content-type": "multipart/form-data; boundary=" + boundary },
      payload: Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"x.md\"\r\nContent-Type: text/markdown\r\n\r\n# X\n\nBody\r\n--" + boundary + "--\r\n") })).json();
    const { batchId } = uploaded;
    const captureId = uploaded.candidates[0].id;
    const url = "/api/v1/imports/" + batchId + "/items/" + captureId;
    const accepted = await app.inject({ method: "POST", url: url + "/commit", headers,
      payload: { vaultId: "default" } });
    await vi.waitFor(async () => {
      const jobs = (await app.inject({ method: "GET", url: "/api/v1/imports/filing-jobs" })).json().jobs;
      expect(jobs.find((job: { id: string }) => job.id === accepted.json().job.id).status).toBe("completed");
    });
    const filed = (await app.inject({ method: "GET", url: "/api/v1/imports/" + batchId })).json().candidates[0];
    const vault = join(dataDir, "vaults", "default");
    const snapshot = readFileSync(join(vault, filed.snapshot));
    const changed = await app.inject({ method: "PATCH", url: url + "/metadata", headers,
      payload: { expectedVersion: filed.metadataVersion, author: "Benjamin Wan Rothschild",
        authorship: "third_party" } });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ author: "Benjamin Wan Rothschild", authorship: "third_party",
      metadataVersion: filed.metadataVersion + 1 });
    const manifest = JSON.parse(readFileSync(join(vault, ".ocf", "ingest-manifest.json"), "utf8"));
    expect(manifest.sources[filed.fingerprint]).toMatchObject({ author: "Benjamin Wan Rothschild",
      authorship: "third_party" });
    expect(readFileSync(join(vault, filed.snapshot))).toEqual(snapshot);
    const stale = await app.inject({ method: "PATCH", url: url + "/metadata", headers,
      payload: { expectedVersion: filed.metadataVersion, authorship: "self" } });
    expect(stale.statusCode).toBe(409);
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
}, 15000);

test("partial correction across two vaults remains visible and resumes without rewriting raw", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-provenance-multivault-"));
  const app = createApp({ dataDir, maintainerRoot });
  try {
    await app.inject({ method: "PUT", url: "/api/v1/imports/policy", headers, payload: { mode: "manual" } });
    const other = join(dataDir, "other");
    mkdirSync(other);
    expect((await app.inject({ method: "POST", url: "/api/v1/vaults", headers,
      payload: { id: "other", path: other, adopt: true } })).statusCode).toBe(201);
    const boundary = "ocf-multivault-correction";
    const uploaded = (await app.inject({ method: "POST", url: "/api/v1/imports/preflight",
      headers: { ...headers, "content-type": "multipart/form-data; boundary=" + boundary },
      payload: Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"x.md\"\r\nContent-Type: text/markdown\r\n\r\n# X\n\nBody\r\n--" + boundary + "--\r\n") })).json();
    const { batchId } = uploaded;
    const captureId = uploaded.candidates[0].id;
    const url = "/api/v1/imports/" + batchId + "/items/" + captureId;
    for (const vaultId of ["default", "other"]) {
      const accepted = await app.inject({ method: "POST", url: url + "/commit", headers,
        payload: { vaultId } });
      await vi.waitFor(async () => {
        const jobs = (await app.inject({ method: "GET", url: "/api/v1/imports/filing-jobs" })).json().jobs;
        expect(jobs.find((job: { id: string }) => job.id === accepted.json().job.id).status).toBe("completed");
      });
    }
    const lock = join(other, ".ocf", "ingest.lock");
    writeFileSync(lock, "held");
    const body = { expectedVersion: 0, author: "Ada", authorship: "third_party" };
    const partial = await app.inject({ method: "PATCH", url: url + "/metadata", headers, payload: body });
    expect(partial.statusCode).toBe(409);
    expect(partial.json().error).toBe("PARTIAL_METADATA_CORRECTION");
    expect((await app.inject({ method: "GET", url: "/api/v1/attention?localDate=2026-10-29" }))
      .json().items.some((item: { errorCode: string }) => item.errorCode === "PARTIAL_METADATA_CORRECTION")).toBe(true);
    unlinkSync(lock);
    const resumed = await app.inject({ method: "PATCH", url: url + "/metadata", headers, payload: body });
    expect(resumed.statusCode).toBe(200);
    for (const root of [join(dataDir, "vaults", "default"), other]) {
      const manifest = JSON.parse(readFileSync(join(root, ".ocf", "ingest-manifest.json"), "utf8"));
      expect(Object.values(manifest.sources)[0]).toMatchObject({ author: "Ada", authorship: "third_party" });
    }
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
}, 15000);

test("failed audit append after manifest replacement remains visible for reconciliation", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-provenance-audit-"));
  const app = createApp({ dataDir, maintainerRoot });
  try {
    await app.inject({ method: "PUT", url: "/api/v1/imports/policy", headers, payload: { mode: "manual" } });
    const boundary = "ocf-audit-correction";
    const uploaded = (await app.inject({ method: "POST", url: "/api/v1/imports/preflight",
      headers: { ...headers, "content-type": "multipart/form-data; boundary=" + boundary },
      payload: Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"x.md\"\r\nContent-Type: text/markdown\r\n\r\n# X\n\nBody\r\n--" + boundary + "--\r\n") })).json();
    const { batchId } = uploaded;
    const captureId = uploaded.candidates[0].id;
    const url = "/api/v1/imports/" + batchId + "/items/" + captureId;
    expect((await app.inject({ method: "PATCH", url: url + "/metadata", headers,
      payload: { expectedVersion: 0, author: "Old", authorship: "self" } })).statusCode).toBe(200);
    const accepted = await app.inject({ method: "POST", url: url + "/commit", headers,
      payload: { vaultId: "default" } });
    await vi.waitFor(async () => {
      const jobs = (await app.inject({ method: "GET", url: "/api/v1/imports/filing-jobs" })).json().jobs;
      expect(jobs.find((job: { id: string }) => job.id === accepted.json().job.id).status).toBe("completed");
    });
    const vault = join(dataDir, "vaults", "default");
    const auditPath = join(vault, ".ocf", "source-metadata-audit.jsonl");
    mkdirSync(auditPath);
    const body = { expectedVersion: 1, author: "Ada", authorship: "third_party" };
    const response = await app.inject({ method: "PATCH", url: url + "/metadata", headers, payload: body });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("PARTIAL_METADATA_CORRECTION");
    expect((await app.inject({ method: "GET", url: "/api/v1/attention?localDate=2026-10-29" }))
      .json().items.some((item: { errorCode: string }) => item.errorCode === "PARTIAL_METADATA_CORRECTION")).toBe(true);
    const filed = (await app.inject({ method: "GET", url: "/api/v1/imports/" + batchId })).json().candidates[0];
    const manifest = JSON.parse(readFileSync(join(vault, ".ocf", "ingest-manifest.json"), "utf8"));
    expect(manifest.sources[filed.fingerprint]).toMatchObject({ author: "Ada", authorship: "third_party" });
    rmSync(auditPath, { recursive: true });
    expect((await app.inject({ method: "PATCH", url: url + "/metadata", headers, payload: body })).statusCode).toBe(200);
    const audit = readFileSync(auditPath, "utf8");
    expect(audit).toContain('"reconciled":true');
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
}, 15000);

test("filed correction exposes a verifiable metadata sync action for prior maintenance", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-provenance-sync-"));
  const app = createApp({ dataDir, maintainerRoot });
  try {
    await app.inject({ method: "PUT", url: "/api/v1/imports/policy", headers, payload: { mode: "manual" } });
    const boundary = "ocf-metadata-sync";
    const uploaded = (await app.inject({ method: "POST", url: "/api/v1/imports/preflight",
      headers: { ...headers, "content-type": "multipart/form-data; boundary=" + boundary },
      payload: Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"x.md\"\r\nContent-Type: text/markdown\r\n\r\n# X\n\nBody\r\n--" + boundary + "--\r\n") })).json();
    const { batchId } = uploaded;
    const captureId = uploaded.candidates[0].id;
    const url = "/api/v1/imports/" + batchId + "/items/" + captureId;
    const accepted = await app.inject({ method: "POST", url: url + "/commit", headers,
      payload: { vaultId: "default" } });
    await vi.waitFor(async () => {
      const jobs = (await app.inject({ method: "GET", url: "/api/v1/imports/filing-jobs" })).json().jobs;
      expect(jobs.find((job: { id: string }) => job.id === accepted.json().job.id).status).toBe("completed");
    });
    const filed = (await app.inject({ method: "GET", url: "/api/v1/imports/" + batchId })).json().candidates[0];
    const db = new Database(join(dataDir, "state.sqlite"));
    try { db.prepare(`INSERT INTO analysis_jobs (id,batch_id,capture_id,mode,vault_id,fingerprint,snapshot,
      status,stage,attempt,result_json,created_at,updated_at)
      VALUES ('prior-maintenance',?,?,'maintain','default',?,?,'skipped','complete',1,?,?,?)`)
      .run(batchId, captureId, filed.fingerprint, filed.snapshot,
        JSON.stringify({ recommendation: "defer", files: [] }), new Date().toISOString(), new Date().toISOString()); }
    finally { db.close(); }
    expect((await app.inject({ method: "PATCH", url: url + "/metadata", headers,
      payload: { expectedVersion: 0, author: "Ada", authorship: "third_party" } })).statusCode).toBe(200);
    const pending = (await app.inject({ method: "GET", url: "/api/v1/maintenance/jobs" })).json().jobs[0];
    expect(pending).toMatchObject({ id: "prior-maintenance", status: "needs_attention", stage: "metadata_sync" });
    const resolved = await app.inject({ method: "POST",
      url: "/api/v1/maintenance/jobs/prior-maintenance/metadata-sync/resolve", headers,
      payload: { confirmed: true } });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().job).toMatchObject({ status: "skipped", stage: "complete" });
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
}, 15000);
