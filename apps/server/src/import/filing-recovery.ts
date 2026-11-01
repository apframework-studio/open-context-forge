import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type Database from "better-sqlite3";
import type { CaptureCandidate } from "@ocf/contracts";
import type { VaultRegistry } from "../vaults/registry.js";
import type { AnalysisJobs } from "../analysis/jobs.js";
import type { FilingJob, FilingResult } from "./filing-jobs.js";
import { renderCaptureMarkdown } from "../vaults/maintainer.js";
import { sourceKey } from "./source-identity.js";

export async function backfillSourceKeys(db: Database.Database, vaults: VaultRegistry): Promise<void> {
  const rows = db.prepare(`SELECT i.batch_id, i.capture_id, i.payload_json, i.source_key,
    m.vault_id, m.snapshot, m.fingerprint FROM import_items i
    LEFT JOIN import_item_vaults m ON m.batch_id = i.batch_id AND m.capture_id = i.capture_id
    ORDER BY m.created_at, m.rowid, i.rowid`).all() as {
    batch_id: string; capture_id: string; payload_json: string; source_key: string | null;
    vault_id: string | null; snapshot: string | null; fingerprint: string | null }[];
  const seen = new Set<string>();
  for (const row of rows) {
    const key = row.source_key ?? sourceKey(JSON.parse(row.payload_json) as CaptureCandidate);
    if (!row.source_key) db.prepare(`UPDATE import_items SET source_key = ? WHERE batch_id = ? AND capture_id = ?
      AND source_key IS NULL`).run(key, row.batch_id, row.capture_id);
    if (!row.vault_id || !row.snapshot || !row.fingerprint) continue;
    const pair = `${row.vault_id}\u0000${key}`;
    if (seen.has(pair)) continue;
    const existing = db.prepare("SELECT 1 FROM vault_source_keys WHERE vault_id = ? AND source_key = ?")
      .get(row.vault_id, key);
    if (existing) { seen.add(pair); continue; }
    const vault = vaults.get(row.vault_id);
    if (!vault || !await verifiedSnapshot(vault.path, row.snapshot, row.fingerprint)) continue;
    db.prepare(`INSERT OR IGNORE INTO vault_source_keys (vault_id,source_key,snapshot,fingerprint,created_at)
      VALUES (?,?,?,?,?)`).run(row.vault_id, key, row.snapshot, row.fingerprint, new Date().toISOString());
    seen.add(pair);
  }
}

export async function verifiedSnapshot(vaultPath: string, snapshot: string, fingerprint: string): Promise<boolean> {
  if (!/^[a-f\d]{64}$/.test(fingerprint) || !snapshot || isAbsolute(snapshot) ||
    snapshot.includes("\\") || snapshot.split("/").some((part) => part === "." || part === "..")) return false;
  try {
    const root = await realpath(vaultPath);
    const target = resolve(root, snapshot);
    const rel = relative(root, target);
    if (!rel || rel.startsWith("..") || isAbsolute(rel) || !target.startsWith(`${root}${sep}`) ||
      await realpath(target) !== target) return false;
    const manifest = JSON.parse(await readFile(join(root, ".ocf", "ingest-manifest.json"), "utf8")) as {
      sources?: Record<string, { snapshot?: string }> };
    if (manifest.sources?.[fingerprint]?.snapshot !== snapshot) return false;
    return createHash("sha256").update(await readFile(target)).digest("hex") === fingerprint;
  } catch { return false; }
}

export async function reconcileFiling(db: Database.Database, vaults: VaultRegistry, analysisJobs: AnalysisJobs,
  job: FilingJob): Promise<FilingResult | "retryable" | "needs_attention"> {
  const vault = vaults.get(job.vaultId);
  if (!vault) return "needs_attention";
  const item = db.prepare("SELECT payload_json, source_key, authorship, metadata_version FROM import_items WHERE batch_id = ? AND capture_id = ?")
    .get(job.batchId, job.captureId) as { payload_json: string; source_key: string | null;
      authorship: string; metadata_version: number } | undefined;
  if (!item) return "needs_attention";
  const candidate = JSON.parse(item.payload_json) as CaptureCandidate;
  const key = item.source_key ?? sourceKey(candidate);
  const membership = db.prepare(`SELECT snapshot, fingerprint, analysis_sync_error FROM import_item_vaults
    WHERE batch_id = ? AND capture_id = ? AND vault_id = ?`).get(job.batchId, job.captureId, job.vaultId) as {
    snapshot: string; fingerprint: string; analysis_sync_error: number } | undefined;
  if (membership) {
    if (!await verifiedSnapshot(vault.path, membership.snapshot, membership.fingerprint)) return "needs_attention";
    try {
      const manifest = JSON.parse(await readFile(join(vault.path, ".ocf", "ingest-manifest.json"), "utf8")) as {
        sources?: Record<string, { author?: string | null; authorship?: string }> };
      const entry = manifest.sources?.[membership.fingerprint];
      if ((entry?.author ?? null) !== (candidate.author ?? null) ||
        (entry?.authorship ?? "unknown") !== item.authorship) return "needs_attention";
    } catch { return "needs_attention"; }
    return { vaultId: job.vaultId, snapshot: membership.snapshot, fingerprint: membership.fingerprint,
      duplicate: true, analysisSyncError: !!membership.analysis_sync_error };
  }
  if (existsSync(join(vault.path, ".ocf", "ingest.lock"))) return "needs_attention";
  const bytes = renderCaptureMarkdown(candidate);
  const fingerprint = createHash("sha256").update(bytes).digest("hex");
  let entry: { snapshot?: string; author?: string | null; authorship?: string } | undefined;
  let sourcesPath: string;
  try {
    const manifest = JSON.parse(await readFile(join(vault.path, ".ocf", "ingest-manifest.json"), "utf8")) as {
      sources?: Record<string, { snapshot?: string; author?: string | null; authorship?: string }> };
    const profile = JSON.parse(await readFile(join(vault.path, ".ocf", "vault.json"), "utf8")) as {
      paths?: { sources?: string } };
    entry = manifest.sources?.[fingerprint];
    sourcesPath = resolve(vault.path, profile.paths?.sources ?? "raw/sources");
  } catch { return "needs_attention"; }
  if (entry) {
    if (!entry.snapshot || !await verifiedSnapshot(vault.path, entry.snapshot, fingerprint)) return "needs_attention";
    if ((entry.author ?? null) !== (candidate.author ?? null) ||
      (entry.authorship ?? "unknown") !== item.authorship) return "needs_attention";
    try {
      db.transaction(() => {
        const latest = db.prepare("SELECT payload_json, authorship, metadata_version FROM import_items WHERE batch_id = ? AND capture_id = ?")
          .get(job.batchId, job.captureId) as { payload_json: string; authorship: string; metadata_version: number };
        if (latest.metadata_version !== item.metadata_version || latest.authorship !== item.authorship ||
          (JSON.parse(latest.payload_json) as CaptureCandidate).author !== candidate.author)
          throw new Error("SOURCE_METADATA_CHANGED");
        db.prepare(`INSERT OR IGNORE INTO vault_source_keys (vault_id,source_key,snapshot,fingerprint,created_at)
          VALUES (?,?,?,?,?)`).run(job.vaultId, key, entry.snapshot, fingerprint, new Date().toISOString());
        db.prepare(`INSERT INTO import_item_vaults (batch_id,capture_id,vault_id,snapshot,fingerprint,created_at)
          VALUES (?,?,?,?,?,?)`).run(job.batchId, job.captureId, job.vaultId, entry.snapshot, fingerprint, new Date().toISOString());
        db.prepare(`UPDATE import_items SET status = 'imported', error_code = NULL, vault_id = COALESCE(vault_id, ?),
          snapshot = COALESCE(snapshot, ?), fingerprint = COALESCE(fingerprint, ?), processed_at = ?
          WHERE batch_id = ? AND capture_id = ?`).run(job.vaultId, entry.snapshot, fingerprint,
          new Date().toISOString(), job.batchId, job.captureId);
        if (vaults.maintenancePolicy(job.vaultId).enabled) {
          analysisJobs.recordFiled(job.batchId, job.captureId, job.vaultId, entry!.snapshot!, fingerprint);
        }
      })();
      analysisJobs.wake();
    } catch { return "needs_attention"; }
    return { vaultId: job.vaultId, snapshot: entry.snapshot, fingerprint, duplicate: false, analysisSyncError: false };
  }
  try {
    if (readdirSync(sourcesPath).some((name) => name.endsWith(`-${fingerprint}.md`))) return "needs_attention";
  } catch { return "needs_attention"; }
  return "retryable";
}
