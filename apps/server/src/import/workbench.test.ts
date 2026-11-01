import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { strToU8, zipSync } from "fflate";
import { expect, test } from "vitest";
import Database from "better-sqlite3";
import { createApp } from "../app.js";
import { waitForFiling } from "./test-filings.js";

const maintainerRoot = resolve(process.cwd(), "../../../open-context-forge-vault-maintainer");
const headers = { "x-ocf-client": "1" };

function multipart(ids: string[]) {
  const captures = ids.map((id) => {
    const markdown = `正文 ${id} 足以供用户整理和检索。`;
    return { schemaVersion: 1, id,
      source: { originalUrl: `https://example.org/${id}`, canonicalUrl: `https://example.org/${id}`, title: `标题 ${id}` },
      content: { markdown, wordCount: markdown.length, imageUrls: [] },
      capture: { capturedAt: new Date().toISOString(), extractor: "readability",
        contentHash: createHash("sha256").update(markdown).digest("hex"), warnings: [] },
      user: {}, delivery: { status: "queued", attempts: 0 } };
  });
  const bytes = zipSync({ "captures.json": strToU8(JSON.stringify(captures)) });
  const boundary = "ocf-workbench";
  return { headers: { ...headers, "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="captures.zip"\r\nContent-Type: application/zip\r\n\r\n`),
      Buffer.from(bytes), Buffer.from(`\r\n--${boundary}--\r\n`)]) };
}

test("lists pending captures across batches with server pagination and search", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-workbench-"));
  const app = createApp({ dataDir, maintainerRoot });
  try {
    await app.inject({ method: "POST", url: "/api/v1/imports/preflight", ...multipart(["alpha", "beta"]) });
    await app.inject({ method: "POST", url: "/api/v1/imports/preflight", ...multipart(["gamma"]) });
    const first = await app.inject({ method: "GET", url: "/api/v1/imports/items?view=pending&page=1&pageSize=2" });
    expect(first.statusCode).toBe(200);
    expect(first.json().total).toBe(3);
    expect(first.json().items).toHaveLength(2);
    const second = await app.inject({ method: "GET", url: "/api/v1/imports/items?view=pending&page=2&pageSize=2&q=标题" });
    expect(second.json().items).toHaveLength(1);
    const searched = await app.inject({ method: "GET", url: "/api/v1/imports/items?view=all&q=gamma" });
    expect(searched.json().items.map((item: { captureId: string }) => item.captureId)).toEqual(["gamma"]);
    const malformed = await app.inject({ method: "GET", url: "/api/v1/imports/items?q=alpha&q=beta" });
    expect(malformed.statusCode).toBe(422);
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("analysis list filter groups generated and legacy confirmed cards as analyzed", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-analysis-filter-"));
  const app = createApp({ dataDir, maintainerRoot });
  try {
    const uploaded = await app.inject({ method: "POST", url: "/api/v1/imports/preflight",
      ...multipart(["new-card", "old-card", "no-card"]) });
    const batchId = uploaded.json().batchId;
    const db = new Database(join(dataDir, "state.sqlite"));
    try {
      const insert = db.prepare(`INSERT INTO capture_analyses
        (batch_id, capture_id, fingerprint, status, card_json, updated_at) VALUES (?, ?, ?, ?, '{}', ?)`);
      insert.run(batchId, "new-card", "new", "proposed", new Date().toISOString());
      insert.run(batchId, "old-card", "old", "confirmed", new Date().toISOString());
    } finally { db.close(); }
    const analyzed = await app.inject({ method: "GET", url: "/api/v1/imports/items?view=all&analysis=analyzed" });
    expect(analyzed.statusCode).toBe(200);
    expect(analyzed.json().items.map((item: { captureId: string }) => item.captureId).sort()).toEqual(["new-card", "old-card"]);
    const unanalyzed = await app.inject({ method: "GET", url: "/api/v1/imports/items?view=all&analysis=none" });
    expect(unanalyzed.json().items.map((item: { captureId: string }) => item.captureId)).toEqual(["no-card"]);
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("shelving and trash remove captures from pending without deleting their record", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-workbench-"));
  const app = createApp({ dataDir, maintainerRoot });
  try {
    await app.inject({ method: "PUT", url: "/api/v1/imports/policy", headers, payload: { mode: "manual" } });
    const uploaded = await app.inject({ method: "POST", url: "/api/v1/imports/preflight", ...multipart(["alpha", "beta"]) });
    const batchId = uploaded.json().batchId;
    const items = (captureId: string) => [{ batchId, captureId }];
    const shelved = await app.inject({ method: "POST", url: "/api/v1/imports/items/actions", headers,
      payload: { action: "shelve", items: items("alpha") } });
    expect(shelved.statusCode).toBe(200);
    const trashed = await app.inject({ method: "POST", url: "/api/v1/imports/items/actions", headers,
      payload: { action: "trash", items: items("beta") } });
    expect(trashed.statusCode).toBe(200);
    const pending = await app.inject({ method: "GET", url: "/api/v1/imports/items?view=pending" });
    expect(pending.json().total).toBe(0);
    const all = await app.inject({ method: "GET", url: "/api/v1/imports/items?view=all" });
    expect(all.json().items.map((item: { captureId: string }) => item.captureId)).toEqual(["alpha"]);
    const trash = await app.inject({ method: "GET", url: "/api/v1/imports/items?view=trash" });
    expect(trash.json().items.map((item: { captureId: string }) => item.captureId)).toEqual(["beta"]);
    const recent = await app.inject({ method: "GET", url: "/api/v1/imports/items?view=recent" });
    expect(recent.json().items.map((item: { captureId: string }) => item.captureId)).toEqual(["alpha"]);
    const purged = await app.inject({ method: "POST", url: "/api/v1/imports/items/actions", headers,
      payload: { action: "purge", items: items("beta") } });
    expect(purged.json().results[0].ok).toBe(true);
    const afterPurge = await app.inject({ method: "GET", url: "/api/v1/imports/items?view=trash" });
    expect(afterPurge.json().total).toBe(0);
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("automatic filing policy stores ready captures in the selected vault", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-workbench-"));
  const app = createApp({ dataDir, maintainerRoot });
  try {
    const policy = await app.inject({ method: "PUT", url: "/api/v1/imports/policy", headers,
      payload: { mode: "auto-file", vaultId: "default" } });
    expect(policy.statusCode).toBe(200);
    const uploaded = await app.inject({ method: "POST", url: "/api/v1/imports/preflight", ...multipart(["alpha"]) });
    expect(uploaded.json().candidates[0]).toMatchObject({ status: "ready" });
    let filed = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      const batch = await app.inject({ method: "GET", url: `/api/v1/imports/${uploaded.json().batchId}` });
      if (batch.json().candidates[0].status === "imported") { filed = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(filed).toBe(true);
    const pending = await app.inject({ method: "GET", url: "/api/v1/imports/items?view=pending" });
    expect(pending.json().total).toBe(0);
    const recent = await app.inject({ method: "GET", url: "/api/v1/imports/items?view=recent" });
    expect(recent.json().items[0]).toMatchObject({ captureId: "alpha", vaultId: "default" });
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("vault maintenance is opt-in and filing enqueues one durable job per source fingerprint", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-maintenance-policy-"));
  const app = createApp({ dataDir, maintainerRoot, agentOptions: { claudePath: null } });
  try {
    await app.inject({ method: "GET", url: "/api/v1/vaults" });
    const initial = await app.inject({ method: "GET", url: "/api/v1/vaults/default/maintenance-policy" });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().enabled).toBe(false);
    const enabled = await app.inject({ method: "PUT", url: "/api/v1/vaults/default/maintenance-policy", headers,
      payload: { enabled: true } });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().enabled).toBe(true);
    const uploaded = await app.inject({ method: "POST", url: "/api/v1/imports/preflight", ...multipart(["maintain-me"]) });
    const batchId = uploaded.json().batchId;
    const commitUrl = `/api/v1/imports/${batchId}/items/maintain-me/commit`;
    const first = await app.inject({ method: "POST", url: commitUrl, headers, payload: { vaultId: "default" } });
    expect(first.statusCode).toBe(202);
    const filing = await waitForFiling(app, first.json().job.id);
    const second = await app.inject({ method: "POST", url: commitUrl, headers, payload: { vaultId: "default" } });
    expect(second.statusCode).toBe(202);
    expect(second.json().job.id).toBe(first.json().job.id);
    const jobs = await app.inject({ method: "GET", url: "/api/v1/maintenance/jobs?vaultId=default" });
    expect(jobs.statusCode).toBe(200);
    expect(jobs.json().jobs.filter((job: { fingerprint: string }) => job.fingerprint === filing.fingerprint)).toHaveLength(1);
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("an automatically filed source cannot be unlinked from the source workbench", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-unlink-auto-"));
  const first = createApp({ dataDir, maintainerRoot });
  try {
    await first.inject({ method: "PUT", url: "/api/v1/imports/policy", headers,
      payload: { mode: "auto-file", vaultId: "default" } });
    const uploaded = await first.inject({ method: "POST", url: "/api/v1/imports/preflight", ...multipart(["unlink-auto"]) });
    const batchId = uploaded.json().batchId;
    let status = "ready";
    for (let attempt = 0; attempt < 50; attempt++) {
      const batch = await first.inject({ method: "GET", url: `/api/v1/imports/${batchId}` });
      status = batch.json().candidates[0].status;
      if (status === "imported") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(status).toBe("imported");
    const unlinked = await first.inject({ method: "PUT", url: `/api/v1/imports/${batchId}/items/unlink-auto/vaults`,
      headers, payload: { vaultIds: [] } });
    expect(unlinked.statusCode).toBe(409);
    expect(unlinked.json().error).toBe("VAULT_ASSOCIATION_IMMUTABLE");
    await first.close();
    const restarted = createApp({ dataDir, maintainerRoot });
    try {
      const batch = await restarted.inject({ method: "GET", url: `/api/v1/imports/${batchId}` });
      expect(batch.json().candidates[0]).toMatchObject({ status: "imported" });
      expect(batch.json().candidates[0].vaults).toHaveLength(1);
      const list = await restarted.inject({ method: "GET", url: "/api/v1/imports/items?view=pending" });
      expect(list.json().total).toBe(0);
    } finally { await restarted.close(); }
  } finally { await first.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("one capture can be filed into two vaults and found by either vault filter", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-multivault-"));
  const secondPath = join(dataDir, "external");
  mkdirSync(secondPath);
  const app = createApp({ dataDir, maintainerRoot });
  try {
    const added = await app.inject({ method: "POST", url: "/api/v1/vaults", headers,
      payload: { id: "research", path: secondPath, adopt: true } });
    expect(added.statusCode).toBe(201);
    const uploaded = await app.inject({ method: "POST", url: "/api/v1/imports/preflight", ...multipart(["shared"]) });
    const batchId = uploaded.json().batchId;
    const commit = (vaultId: string) => app.inject({ method: "POST", url: `/api/v1/imports/${batchId}/items/shared/commit`,
      headers, payload: { vaultId } });
    const firstFiling = await commit("default");
    expect(firstFiling.statusCode).toBe(202);
    const firstResult = await waitForFiling(app, firstFiling.json().job.id);
    const secondFiling = await commit("research");
    expect(secondFiling.statusCode).toBe(202);
    await waitForFiling(app, secondFiling.json().job.id);
    const repeated = await commit("research");
    expect(repeated.statusCode).toBe(202);
    expect(repeated.json().job.id).toBe(secondFiling.json().job.id);
    for (const vaultId of ["default", "research"]) {
      const listed = await app.inject({ method: "GET", url: `/api/v1/imports/items?view=all&vaultId=${vaultId}` });
      expect(listed.json().items[0].vaults.map((entry: { vaultId: string }) => entry.vaultId)).toEqual(["default", "research"]);
      const sources = await app.inject({ method: "GET", url: `/api/v1/vaults/${vaultId}/sources` });
      expect(sources.json().items[0].title).toBe("标题 shared");
    }
    const batch = await app.inject({ method: "GET", url: `/api/v1/imports/${batchId}` });
    expect(batch.json().candidates[0].vaults).toHaveLength(2);
    const fingerprint = firstResult.fingerprint;
    const db = new Database(join(dataDir, "state.sqlite"));
    try {
      const card = { vaultId: "", snapshot: `inbox/${batchId}/shared`, fingerprint, status: "proposed",
        authorship: "third_party", author: null, summary: "摘要", mainPoints: [], limitations: [],
        recommendation: "defer", reason: "待整理" };
      db.prepare(`INSERT INTO capture_analyses (batch_id, capture_id, fingerprint, status, card_json, updated_at)
        VALUES (?, ?, ?, 'proposed', ?, ?)`).run(batchId, "shared", fingerprint, JSON.stringify(card), new Date().toISOString());
    } finally { db.close(); }
    const confirmed = await app.inject({ method: "POST", url: `/api/v1/imports/${batchId}/items/shared/analysis/confirm`,
      headers, payload: { expectedFingerprint: fingerprint } });
    expect(confirmed.statusCode).toBe(200);
    for (const vaultId of ["default", "research"]) {
      const analysis = await app.inject({ method: "GET", url: `/api/v1/vaults/${vaultId}/sources` });
      expect(analysis.json().items[0].analysisStatus).toBe("confirmed");
    }
    const researchFile = join(secondPath, batch.json().candidates[0].vaults[1].snapshot);
    const updated = await app.inject({ method: "PUT", url: `/api/v1/imports/${batchId}/items/shared/vaults`,
      headers, payload: { vaultIds: ["default"] } });
    expect(updated.statusCode).toBe(409);
    expect(updated.json().error).toBe("VAULT_ASSOCIATION_IMMUTABLE");
    expect(existsSync(researchFile)).toBe(true);
    const stillLinked = await app.inject({ method: "GET", url: "/api/v1/imports/items?view=all&vaultId=research" });
    expect(stillLinked.json().total).toBe(1);
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("automatic filing picks up a new batch uploaded while another batch is running", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-workbench-concurrent-auto-"));
  const app = createApp({ dataDir, maintainerRoot });
  try {
    const policy = await app.inject({ method: "PUT", url: "/api/v1/imports/policy", headers,
      payload: { mode: "auto-file", vaultId: "default" } });
    expect(policy.statusCode).toBe(200);
    const first = await app.inject({ method: "POST", url: "/api/v1/imports/preflight",
      ...multipart(Array.from({ length: 12 }, (_, index) => `first-${index}`)) });
    let running = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      const batch = await app.inject({ method: "GET", url: `/api/v1/imports/${first.json().batchId}` });
      running = batch.json().candidates.some((item: { status: string }) => item.status === "processing");
      if (running) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(running).toBe(true);
    const second = await app.inject({ method: "POST", url: "/api/v1/imports/preflight", ...multipart(["late"]) });
    let status = "ready";
    for (let attempt = 0; attempt < 150; attempt++) {
      const batch = await app.inject({ method: "GET", url: `/api/v1/imports/${second.json().batchId}` });
      status = batch.json().candidates[0].status;
      if (status === "imported") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(status).toBe("imported");
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("concurrent filing attempts never mark a successful source as failed", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-workbench-"));
  const app = createApp({ dataDir, maintainerRoot });
  try {
    const upload = await app.inject({ method: "POST", url: "/api/v1/imports/preflight", ...multipart(["parallel"]) });
    const batchId = upload.json().batchId;
    const request = { method: "POST" as const, url: `/api/v1/imports/${batchId}/items/parallel/commit`,
      headers, payload: { vaultId: "default" } };
    const results = await Promise.all([app.inject(request), app.inject(request)]);
    expect(results.map((item) => item.statusCode).sort()).toEqual([202, 202]);
    expect(results[0].json().job.id).toBe(results[1].json().job.id);
    await waitForFiling(app, results[0].json().job.id);
    const saved = await app.inject({ method: "GET", url: `/api/v1/imports/${batchId}` });
    expect(saved.json().candidates[0].status).toBe("imported");
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("restarts an unfinished automatic filing batch from saved queue state", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-workbench-"));
  const first = createApp({ dataDir, maintainerRoot });
  try {
    const uploaded = await first.inject({ method: "POST", url: "/api/v1/imports/preflight", ...multipart(["resume"]) });
    const batchId = uploaded.json().batchId;
    await first.close();
    const db = new Database(join(dataDir, "state.sqlite"));
    db.prepare("UPDATE import_batches SET auto_vault_id = 'default' WHERE id = ?").run(batchId);
    db.close();
    const restarted = createApp({ dataDir, maintainerRoot });
    try {
      let status = "ready";
      for (let attempt = 0; attempt < 20; attempt++) {
        const batch = await restarted.inject({ method: "GET", url: `/api/v1/imports/${batchId}` });
        status = batch.json().candidates[0].status;
        if (status === "imported") break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(status).toBe("imported");
    } finally { await restarted.close(); }
  } finally { await first.close(); rmSync(dataDir, { recursive: true, force: true }); }
});
