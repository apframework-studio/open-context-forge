import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, vi } from "vitest";
import Database from "better-sqlite3";
import { createApp } from "../app.js";

const headers = { "x-ocf-client": "1" };
const maintainerRoot = resolve(process.cwd(), "../../../open-context-forge-vault-maintainer");

function upload(text: string, filename: string) {
  const boundary = "ocf-filing-route";
  return { headers: { ...headers, "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/markdown\r\n\r\n${text}\r\n--${boundary}--\r\n`) };
}

test("manual filing returns a job immediately and membership appears after completion", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-filing-http-"));
  const app = createApp({ dataDir, maintainerRoot });
  try {
    const uploaded = await app.inject({ method: "POST", url: "/api/v1/imports/preflight", ...upload("# Queue\n\nArticle body", "queue.md") });
    const { batchId, candidates } = uploaded.json();
    const filed = await app.inject({ method: "POST", url: `/api/v1/imports/${batchId}/items/${candidates[0].id}/commit`,
      headers, payload: { vaultId: "default" } });
    expect(filed.statusCode).toBe(202);
    expect(filed.json().job).toMatchObject({ batchId, captureId: candidates[0].id, vaultId: "default" });
    await vi.waitFor(async () => {
      const jobs = (await app.inject({ method: "GET", url: "/api/v1/imports/filing-jobs" })).json().jobs;
      expect(jobs[0]).toMatchObject({ id: filed.json().job.id, status: "completed" });
      const batch = (await app.inject({ method: "GET", url: `/api/v1/imports/${batchId}` })).json();
      expect(batch.candidates[0].vaults).toHaveLength(1);
    }, { timeout: 5000, interval: 20 });
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
}, 15_000);

test("auto-file policy enqueues each ready source at receipt", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-auto-filing-http-"));
  const app = createApp({ dataDir, maintainerRoot });
  try {
    await app.inject({ method: "PUT", url: "/api/v1/imports/policy", headers, payload: { mode: "auto-file", vaultId: "default" } });
    const uploaded = await app.inject({ method: "POST", url: "/api/v1/imports/preflight", ...upload("# Automatic\n\nArticle body", "automatic.md") });
    expect(uploaded.statusCode).toBe(201);
    const { batchId, candidates } = uploaded.json();
    const jobs = (await app.inject({ method: "GET", url: "/api/v1/imports/filing-jobs" })).json().jobs;
    expect(jobs).toEqual(expect.arrayContaining([expect.objectContaining({ batchId, captureId: candidates[0].id, vaultId: "default" })]));
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
}, 15_000);

test("repeat local upload reuses the verified snapshot despite a new receive time", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-source-reuse-"));
  const app = createApp({ dataDir, maintainerRoot });
  try {
    const snapshots: { snapshot: string; fingerprint: string }[] = [];
    for (let i = 0; i < 2; i++) {
      const uploaded = (await app.inject({ method: "POST", url: "/api/v1/imports/preflight",
        ...upload("# Same\n\nContent", "same.md") })).json();
      const filed = await app.inject({ method: "POST", url: `/api/v1/imports/${uploaded.batchId}/items/${uploaded.candidates[0].id}/commit`,
        headers, payload: { vaultId: "default" } });
      expect(filed.statusCode).toBe(202);
      await vi.waitFor(async () => {
        const job = (await app.inject({ method: "GET", url: "/api/v1/imports/filing-jobs" })).json().jobs
          .find((item: { id: string }) => item.id === filed.json().job.id);
        expect(job.status).toBe("completed");
        snapshots[i] = job.result;
      }, { timeout: 5000, interval: 20 });
    }
    expect(snapshots[1].snapshot).toBe(snapshots[0].snapshot);
    expect(snapshots[1].fingerprint).toBe(snapshots[0].fingerprint);
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
}, 15_000);

test("shelving a queued automatic source cancels its filing until manually submitted", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-auto-shelve-"));
  const app = createApp({ dataDir, maintainerRoot });
  try {
    await app.ready();
    const db = new Database(join(dataDir, "state.sqlite"));
    try { db.prepare("UPDATE filing_lane_state SET paused_reason = 'TEST_PAUSE' WHERE id = 1").run(); }
    finally { db.close(); }
    const uploaded = (await app.inject({ method: "POST", url: "/api/v1/imports/preflight",
      ...upload("# Shelved\n\nArticle body", "shelved.md") })).json();
    const source = { batchId: uploaded.batchId, captureId: uploaded.candidates[0].id };
    const shelved = await app.inject({ method: "POST", url: "/api/v1/imports/items/actions", headers,
      payload: { action: "shelve", items: [source] } });
    expect(shelved.json().results[0].ok).toBe(true);
    expect((await app.inject({ method: "GET", url: "/api/v1/imports/filing-jobs" })).json().jobs[0].status)
      .toBe("cancelled");
    await app.inject({ method: "POST", url: "/api/v1/imports/filing-lane/resume", headers });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await app.inject({ method: "GET", url: `/api/v1/imports/${source.batchId}` })).json()
      .candidates[0].vaults).toEqual([]);
    expect((await app.inject({ method: "GET", url: "/api/v1/imports/items?view=all" })).json()
      .items[0].disposition).toBe("shelved");
    const submitted = await app.inject({ method: "POST",
      url: `/api/v1/imports/${source.batchId}/items/${source.captureId}/commit`, headers,
      payload: { vaultId: "default" } });
    expect(submitted.statusCode).toBe(202);
    await vi.waitFor(async () => expect((await app.inject({ method: "GET",
      url: `/api/v1/imports/${source.batchId}` })).json().candidates[0].vaults).toHaveLength(1));
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
}, 15_000);

test("repeat receipt enriches unknown mapped metadata through the controlled correction path", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-source-enrich-"));
  const app = createApp({ dataDir, maintainerRoot });
  try {
    await app.inject({ method: "PUT", url: "/api/v1/imports/policy", headers, payload: { mode: "manual" } });
    const ids: { batchId: string; captureId: string; fingerprint: string; snapshot: string }[] = [];
    for (let i = 0; i < 3; i++) {
      const batch = (await app.inject({ method: "POST", url: "/api/v1/imports/preflight",
        ...upload("# Same\n\nContent", "same.md") })).json();
      const captureId = batch.candidates[0].id;
      if (i === 1) expect((await app.inject({ method: "PATCH",
        url: `/api/v1/imports/${batch.batchId}/items/${captureId}/metadata`, headers,
        payload: { expectedVersion: 0, author: "Ada", authorship: "third_party" } })).statusCode).toBe(200);
      const accepted = await app.inject({ method: "POST",
        url: `/api/v1/imports/${batch.batchId}/items/${captureId}/commit`, headers,
        payload: { vaultId: "default" } });
      await vi.waitFor(async () => {
        const job = (await app.inject({ method: "GET", url: "/api/v1/imports/filing-jobs" })).json().jobs
          .find((entry: { id: string }) => entry.id === accepted.json().job.id);
        expect(job.status).toBe("completed");
      });
      const filed = (await app.inject({ method: "GET", url: `/api/v1/imports/${batch.batchId}` })).json().candidates[0];
      ids.push({ batchId: batch.batchId, captureId, fingerprint: filed.fingerprint, snapshot: filed.snapshot });
    }
    expect(ids.map((item) => item.snapshot)).toEqual([ids[0].snapshot, ids[0].snapshot, ids[0].snapshot]);
    const manifest = JSON.parse(readFileSync(join(dataDir, "vaults", "default", ".ocf", "ingest-manifest.json"), "utf8"));
    expect(manifest.sources[ids[0].fingerprint]).toMatchObject({ author: "Ada", authorship: "third_party" });
    const items = (await app.inject({ method: "GET", url: "/api/v1/imports/items?view=all" })).json().items;
    expect(items).toEqual(expect.arrayContaining([expect.objectContaining({ batchId: ids[0].batchId,
      author: "Ada", authorship: "third_party" })]));
    expect(items).toEqual(expect.arrayContaining([expect.objectContaining({ batchId: ids[2].batchId,
      author: "Ada", authorship: "third_party" })]));
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
}, 15_000);

test("enriching one mapped vault does not silently change another vault", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-source-enrich-scope-"));
  const app = createApp({ dataDir, maintainerRoot });
  try {
    await app.inject({ method: "PUT", url: "/api/v1/imports/policy", headers, payload: { mode: "manual" } });
    const otherPath = join(dataDir, "other-vault");
    mkdirSync(otherPath);
    expect((await app.inject({ method: "POST", url: "/api/v1/vaults", headers,
      payload: { id: "other", path: otherPath, adopt: true } })).statusCode).toBe(201);
    const first = (await app.inject({ method: "POST", url: "/api/v1/imports/preflight",
      ...upload("# Same\n\nContent", "same.md") })).json();
    const firstUrl = `/api/v1/imports/${first.batchId}/items/${first.candidates[0].id}`;
    for (const vaultId of ["default", "other"]) {
      const accepted = await app.inject({ method: "POST", url: firstUrl + "/commit", headers,
        payload: { vaultId } });
      await vi.waitFor(async () => expect((await app.inject({ method: "GET",
        url: "/api/v1/imports/filing-jobs" })).json().jobs
        .find((item: { id: string }) => item.id === accepted.json().job.id).status).toBe("completed"));
    }
    const second = (await app.inject({ method: "POST", url: "/api/v1/imports/preflight",
      ...upload("# Same\n\nContent", "same.md") })).json();
    const secondUrl = `/api/v1/imports/${second.batchId}/items/${second.candidates[0].id}`;
    await app.inject({ method: "PATCH", url: secondUrl + "/metadata", headers,
      payload: { expectedVersion: 0, author: "Ada", authorship: "third_party" } });
    const accepted = await app.inject({ method: "POST", url: secondUrl + "/commit", headers,
      payload: { vaultId: "default" } });
    await vi.waitFor(async () => expect((await app.inject({ method: "GET",
      url: "/api/v1/imports/filing-jobs" })).json().jobs
      .find((item: { id: string }) => item.id === accepted.json().job.id).status).toBe("completed"));
    const firstFiled = (await app.inject({ method: "GET", url: `/api/v1/imports/${first.batchId}` })).json().candidates[0];
    const primary = JSON.parse(readFileSync(join(dataDir, "vaults", "default", ".ocf", "ingest-manifest.json"), "utf8"));
    const other = JSON.parse(readFileSync(join(otherPath, ".ocf", "ingest-manifest.json"), "utf8"));
    expect(primary.sources[firstFiled.fingerprint]).toMatchObject({ author: "Ada", authorship: "third_party" });
    expect(other.sources[firstFiled.vaults.find((vault: { vaultId: string }) => vault.vaultId === "other").fingerprint])
      .toMatchObject({ authorship: "unknown" });
    expect((await app.inject({ method: "GET", url: "/api/v1/attention?localDate=2026-10-30" })).json().items)
      .toEqual(expect.arrayContaining([expect.objectContaining({ kind: "metadata", batchId: first.batchId })]));
    const reconciled = await app.inject({ method: "PATCH", url: firstUrl + "/metadata", headers,
      payload: { expectedVersion: 0, author: "Ada", authorship: "third_party" } });
    expect(reconciled.statusCode).toBe(200);
    const otherAfter = JSON.parse(readFileSync(join(otherPath, ".ocf", "ingest-manifest.json"), "utf8"));
    expect(otherAfter.sources[firstFiled.vaults.find((vault: { vaultId: string }) => vault.vaultId === "other").fingerprint])
      .toMatchObject({ author: "Ada", authorship: "third_party" });
    expect((await app.inject({ method: "GET", url: "/api/v1/attention?localDate=2026-10-30" })).json().items)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ kind: "metadata", batchId: first.batchId })]));
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
}, 15_000);
