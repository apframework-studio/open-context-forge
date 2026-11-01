import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { strToU8, zipSync } from "fflate";
import Database from "better-sqlite3";
import { expect, test, vi } from "vitest";
import { createApp } from "../app.js";
import type { AgentRunner } from "../agents/runner.js";
import { waitForFiling } from "../import/test-filings.js";
import { applyMaintenanceChanges } from "./maintenance-writer.js";

const maintainerRoot = resolve(process.cwd(), "../../../open-context-forge-vault-maintainer");
const readerRoot = resolve(process.cwd(), "../../../open-context-article-reader");
const headers = { "x-ocf-client": "1" };

function multipart(id: string) {
  const markdown = `# ${id}\n\n固定规则生成查询 ${id}。`;
  const candidate = { schemaVersion: 1, id, source: { originalUrl: `https://example.org/${id}`, canonicalUrl: `https://example.org/${id}`, title: id },
    content: { markdown, wordCount: markdown.length, imageUrls: [] }, capture: { capturedAt: "2026-10-27T00:00:00Z", extractor: "readability",
      contentHash: createHash("sha256").update(markdown).digest("hex"), warnings: [] }, user: {}, delivery: { status: "queued", attempts: 0 } };
  const archive = zipSync({ "captures.json": strToU8(JSON.stringify([candidate])) });
  const boundary = `ocf-maintenance-${randomUUID()}`;
  return { headers: { ...headers, "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="captures.zip"\r\nContent-Type: application/zip\r\n\r\n`),
      Buffer.from(archive), Buffer.from(`\r\n--${boundary}--\r\n`)]) };
}

test("automatic filing compiles through one serial CLI pipeline and writes a checked wiki note", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-maintenance-integration-"));
  let active = 0; let maximum = 0;
  const runner: AgentRunner = async (input) => {
    active++; maximum = Math.max(maximum, active);
    try {
      const fingerprint = input.prompt.match(/Source fingerprint: ([a-f\d]{64})/)?.[1];
      const snapshot = input.prompt.match(/Snapshot: ([^\n]+)/)?.[1];
      const source = input.prompt.match(/^L(\d+) (固定规则生成查询 [^\n]+)/m);
      if (!fingerprint || !snapshot) throw new Error("missing prompt context");
      if (input.prompt.includes("<analysis_stage>")) {
        if (!source) throw new Error("missing source line");
        return { sessionId: "analysis", text: JSON.stringify({ fingerprint, summary: "固定规则生成查询", mainPoints: [
          { claim: "来源描述固定规则", kind: "article_statement", evidence: [
            { startLine: Number(source[1]), endLine: Number(source[1]), excerpt: source[2] }] }],
          limitations: [], recommendation: "compile_now", reason: "可复用" }) };
      }
      const evidence = input.prompt.match(new RegExp(`${snapshot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}#L(\\d+)-L(\\d+)`));
      if (!evidence) throw new Error("missing evidence");
      const path = `wiki/concepts/${fingerprint.slice(0, 12)}.md`;
      const content = `---\ntype: concept\nsource_snapshot: '${snapshot}'\nsource_fingerprint: '${fingerprint}'\n---\n# 固定规则查询\n\n来源证据： ${snapshot}#L${evidence[1]}-L${evidence[2]}\n`;
      return { sessionId: "plan", text: JSON.stringify({ fingerprint, decision: "compile_now", reason: "可复用",
        changes: [{ action: "create", path, baseHash: null, content, evidenceIds: ["E1.1"] }] }) };
    } finally { active--; }
  };
  const app = createApp({ dataDir, maintainerRoot, readerRoot,
    agentOptions: { runner, claudePath: "/fake/claude", environment: {} } });
  let restarted: ReturnType<typeof createApp> | null = null;
  try {
    await app.inject({ method: "GET", url: "/api/v1/vaults" });
    const policy = await app.inject({ method: "PUT", url: "/api/v1/vaults/default/maintenance-policy", headers,
      payload: { enabled: true } });
    expect(policy.statusCode).toBe(200);
    const uploaded = await app.inject({ method: "POST", url: "/api/v1/imports/preflight", ...multipart("source-a") });
    const batchId = uploaded.json().batchId as string;
    const filed = await app.inject({ method: "POST", url: `/api/v1/imports/${batchId}/items/source-a/commit`,
      headers, payload: { vaultId: "default" } });
    expect(filed.statusCode).toBe(202);
    await waitForFiling(app, filed.json().job.id);
    await vi.waitFor(async () => {
      const jobs = (await app.inject({ method: "GET", url: "/api/v1/maintenance/jobs?vaultId=default" })).json().jobs;
      expect(`${jobs[0].status}/${jobs[0].errorCode}`).toBe("completed/null");
      expect(jobs[0].result.files).toHaveLength(3);
      expect(existsSync(join(dataDir, "vaults", "default", jobs[0].result.files[0]))).toBe(true);
    }, { timeout: 5000, interval: 20 });
    expect(maximum).toBe(1);
    await app.close();
    const db = new Database(join(dataDir, "state.sqlite"));
    const row = db.prepare("SELECT id, vault_id, fingerprint FROM analysis_jobs WHERE mode = 'maintain' LIMIT 1")
      .get() as { id: string; vault_id: string; fingerprint: string };
    const cardRow = db.prepare("SELECT card_json FROM source_analyses WHERE vault_id = ? AND fingerprint = ?")
      .get(row.vault_id, row.fingerprint) as { card_json: string };
    const card = JSON.parse(cardRow.card_json);
    db.prepare(`UPDATE analysis_jobs SET status = 'running', stage = 'writing', result_json = ?,
      run_token = 'interrupted' WHERE id = ?`).run(JSON.stringify({ pending: true, recommendation: "compile_now",
      authorship: card.authorship, author: card.author,
      card: { summary: card.summary, mainPoints: card.mainPoints, limitations: card.limitations, reason: card.reason } }), row.id);
    db.prepare("DELETE FROM source_analyses WHERE vault_id = ? AND fingerprint = ?")
      .run(row.vault_id, row.fingerprint);
    db.close();
    restarted = createApp({ dataDir, maintainerRoot, readerRoot, agentOptions: { claudePath: null } });
    const recovered = (await restarted.inject({ method: "GET", url: "/api/v1/maintenance/jobs" })).json().jobs[0];
    expect(recovered).toMatchObject({ status: "completed", result: { recovered: true } });
    const check = new Database(join(dataDir, "state.sqlite"));
    expect((check.prepare("SELECT COUNT(*) AS n FROM source_analyses").get() as { n: number }).n).toBe(1);
    check.prepare(`UPDATE analysis_jobs SET status = 'needs_attention', stage = 'writing',
      result_json = ?, error_code = 'INTERRUPTED_WRITE' WHERE id = ?`)
      .run(JSON.stringify({ pending: true, recommendation: "compile_now", authorship: card.authorship,
        author: card.author, card: { summary: card.summary, mainPoints: card.mainPoints,
          limitations: card.limitations, reason: card.reason } }), row.id);
    check.close();
    const inspected = await restarted.inject({ method: "POST",
      url: `/api/v1/maintenance/jobs/${row.id}/inspect`, headers });
    expect(inspected.statusCode).toBe(200);
    expect(inspected.json().job).toMatchObject({ status: "completed", result: { recovered: true } });
    const manifestPath = join(dataDir, "vaults", "default", ".ocf", "ingest-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.sources[row.fingerprint].authorship = "third_party";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const stale = new Database(join(dataDir, "state.sqlite"));
    stale.prepare(`UPDATE analysis_jobs SET status = 'needs_attention', stage = 'writing',
      result_json = ?, error_code = 'INTERRUPTED_WRITE' WHERE id = ?`)
      .run(JSON.stringify({ pending: true, recommendation: "compile_now", authorship: card.authorship,
        author: card.author, card: { summary: card.summary, mainPoints: card.mainPoints,
          limitations: card.limitations, reason: card.reason } }), row.id);
    stale.close();
    const staleInspect = await restarted.inject({ method: "POST",
      url: `/api/v1/maintenance/jobs/${row.id}/inspect`, headers });
    expect(staleInspect.statusCode).toBe(409);
    expect(staleInspect.json().error).toBe("SOURCE_METADATA_CHANGED");
  } finally { await app.close(); if (restarted) await restarted.close(); rmSync(dataDir, { recursive: true, force: true }); }
}, 15_000);

test("two filed sources wait for the same CLI lane", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-maintenance-serial-"));
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const began = new Promise<void>((resolve) => { started = resolve; });
  let active = 0; let maximum = 0; let analysisCalls = 0;
  const runner: AgentRunner = async (input) => {
    active++; maximum = Math.max(maximum, active);
    try {
      const fingerprint = input.prompt.match(/Source fingerprint: ([a-f\d]{64})/)?.[1];
      if (!fingerprint) throw new Error("missing fingerprint");
      if (input.prompt.includes("<analysis_stage>")) {
        analysisCalls++;
        if (analysisCalls === 1) { started(); await gate; }
        const source = input.prompt.match(/^L(\d+) (固定规则生成查询 [^\n]+)/m)!;
        return { sessionId: "analysis", text: JSON.stringify({ fingerprint, summary: "固定规则生成查询",
          mainPoints: [{ claim: "固定规则", kind: "article_statement", evidence: [
            { startLine: Number(source[1]), endLine: Number(source[1]), excerpt: source[2] }] }],
          limitations: [], recommendation: "defer", reason: "需要更多对照" }) };
      }
      return { sessionId: "plan", text: JSON.stringify({ fingerprint, decision: "defer", reason: "需要更多对照", changes: [] }) };
    } finally { active--; }
  };
  const app = createApp({ dataDir, maintainerRoot, readerRoot,
    agentOptions: { runner, claudePath: "/fake/claude", environment: {} } });
  try {
    await app.inject({ method: "PUT", url: "/api/v1/vaults/default/maintenance-policy", headers, payload: { enabled: true } });
    const first = await app.inject({ method: "POST", url: "/api/v1/imports/preflight", ...multipart("serial-a") });
    await app.inject({ method: "POST", url: `/api/v1/imports/${first.json().batchId}/items/serial-a/commit`,
      headers, payload: { vaultId: "default" } });
    await began;
    const second = await app.inject({ method: "POST", url: "/api/v1/imports/preflight", ...multipart("serial-b") });
    const secondAccepted = await app.inject({ method: "POST", url: `/api/v1/imports/${second.json().batchId}/items/serial-b/commit`,
      headers, payload: { vaultId: "default" } });
    await waitForFiling(app, secondAccepted.json().job.id);
    const jobs = (await app.inject({ method: "GET", url: "/api/v1/maintenance/jobs" })).json().jobs;
    expect(jobs.filter((job: { status: string }) => job.status === "running")).toHaveLength(1);
    expect(jobs.filter((job: { status: string }) => job.status === "queued")).toHaveLength(1);
    expect(analysisCalls).toBe(1);
    release();
    await vi.waitFor(async () => {
      const done = (await app.inject({ method: "GET", url: "/api/v1/maintenance/jobs" })).json().jobs;
      expect(done.map((job: { status: string }) => job.status)).toEqual(["skipped", "skipped"]);
    }, { timeout: 5000, interval: 20 });
    expect(maximum).toBe(1);
  } finally { release(); await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
}, 15_000);

test("a maintenance write interrupted by restart requires inspection", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-maintenance-restart-"));
  const first = createApp({ dataDir, maintainerRoot, readerRoot, agentOptions: { claudePath: null } });
  let second: ReturnType<typeof createApp> | null = null;
  try {
    const uploaded = await first.inject({ method: "POST", url: "/api/v1/imports/preflight", ...multipart("restart") });
    const batchId = uploaded.json().batchId as string;
    const filed = await first.inject({ method: "POST", url: `/api/v1/imports/${batchId}/items/restart/commit`,
      headers, payload: { vaultId: "default" } });
    expect(filed.statusCode).toBe(202);
    const filing = await waitForFiling(first, filed.json().job.id);
    await first.close();
    const db = new Database(join(dataDir, "state.sqlite"));
    const id = randomUUID();
    db.prepare(`INSERT INTO analysis_jobs (id,batch_id,capture_id,mode,vault_id,fingerprint,snapshot,status,stage,created_at,updated_at)
      VALUES (?, ?, 'restart', 'maintain', 'default', ?, ?, 'running', 'writing', ?, ?)`)
      .run(id, batchId, filing.fingerprint, filing.snapshot, new Date().toISOString(), new Date().toISOString());
    db.close();
    second = createApp({ dataDir, maintainerRoot, readerRoot, agentOptions: { claudePath: null } });
    const jobs = (await second.inject({ method: "GET", url: "/api/v1/maintenance/jobs" })).json().jobs;
    expect(jobs.find((job: { id: string }) => job.id === id)).toMatchObject({ status: "needs_attention", errorCode: "INTERRUPTED_WRITE" });
  } finally { await first.close(); if (second) await second.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("inspection requeues a verified rolled back write", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-maintenance-rollback-inspect-"));
  const app = createApp({ dataDir, maintainerRoot, readerRoot, agentOptions: { claudePath: null } });
  try {
    await app.inject({ method: "GET", url: "/api/v1/vaults" });
    const uploaded = await app.inject({ method: "POST", url: "/api/v1/imports/preflight", ...multipart("rollback-inspect") });
    const batchId = uploaded.json().batchId as string;
    const accepted = await app.inject({ method: "POST", url: `/api/v1/imports/${batchId}/items/rollback-inspect/commit`,
      headers, payload: { vaultId: "default" } });
    const filing = await waitForFiling(app, accepted.json().job.id);
    const vaultPath = join(dataDir, "vaults", "default");
    const snapshotLines = readFileSync(join(vaultPath, filing.snapshot), "utf8").split("\n");
    const line = snapshotLines.findIndex((value) => value.includes("固定规则生成查询")) + 1;
    const vault = { path: vaultPath } as Parameters<typeof applyMaintenanceChanges>[0];
    await expect(applyMaintenanceChanges(vault, filing.fingerprint, filing.snapshot,
      [{ action: "create", path: "wiki/concepts/broken.md", baseHash: null,
        content: `# Broken\n\n${filing.snapshot}#L${line}-L${line}\n`, evidenceIds: ["E1.1"] }],
      maintainerRoot, { analysisMarkdown: "# Analysis", planMarkdown: "# Plan" }))
      .rejects.toMatchObject({ code: "NOTE_VALIDATION_FAILED" });
    const db = new Database(join(dataDir, "state.sqlite"));
    const id = randomUUID();
    const pending = { pending: true, recommendation: "compile_now", authorship: "unknown", author: null,
      card: { summary: "test", mainPoints: [], limitations: [], reason: "test" } };
    db.prepare(`INSERT INTO analysis_jobs
      (id,batch_id,capture_id,mode,vault_id,fingerprint,snapshot,status,stage,result_json,created_at,updated_at)
      VALUES (?,?,'rollback-inspect','maintain','default',?,?,'needs_attention','writing',?,?,?)`)
      .run(id, batchId, filing.fingerprint, filing.snapshot, JSON.stringify(pending),
        new Date().toISOString(), new Date().toISOString());
    db.prepare("UPDATE analysis_lane_state SET paused_reason = 'test' WHERE id = 1").run();
    db.close();
    const inspected = await app.inject({ method: "POST", url: `/api/v1/maintenance/jobs/${id}/inspect`, headers });
    expect(inspected.statusCode).toBe(200);
    expect(inspected.json().job).toMatchObject({ status: "queued", stage: "analyze", attempt: 2 });
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
}, 15_000);
