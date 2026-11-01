import type Database from "better-sqlite3";
import type { CaptureCandidate } from "@ocf/contracts";
import { importSnapshot, type SnapshotResult } from "../vaults/maintainer.js";
import type { VaultRegistry } from "../vaults/registry.js";
import { syncCaptureAnalysis } from "../analysis/service.js";
import type { AnalysisJobs } from "../analysis/jobs.js";
import { sourceKey } from "./source-identity.js";
import { verifiedSnapshot } from "./filing-recovery.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ProvenanceError, correctFiledMetadata, correctManifestEntry } from "./provenance.js";

export class FilingError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}

export async function fileCapture(db: Database.Database, registry: VaultRegistry, batchId: string, captureId: string, vaultId: string,
  options: { automatic?: boolean; maintenanceJobs?: AnalysisJobs } = {}) {
  const vault = registry.get(vaultId);
  if (!vault) throw new FilingError("VAULT_NOT_FOUND", 404);
  const row = db.prepare(`SELECT payload_json, source_key, authorship, status, disposition, vault_id, snapshot, fingerprint, analysis_sync_error
    FROM import_items WHERE batch_id = ? AND capture_id = ?`).get(batchId, captureId) as {
    payload_json: string; source_key: string | null; authorship: "self" | "third_party" | "unknown";
    status: string; disposition: string; vault_id: string | null;
    snapshot: string | null; fingerprint: string | null; analysis_sync_error: number;
  } | undefined;
  if (!row) throw new FilingError("SOURCE_NOT_FOUND", 404);
  if (row.disposition === "trashed") throw new FilingError("SOURCE_TRASHED", 409);
  if (options.automatic && row.disposition !== "active") throw new FilingError("SOURCE_SHELVED", 409);
  if (row.status === "incomplete") throw new FilingError("INCOMPLETE_SOURCE", 409);
  if (row.status === "processing") throw new FilingError("SOURCE_BUSY", 409);
  const existing = db.prepare(`SELECT snapshot, fingerprint, analysis_sync_error FROM import_item_vaults
    WHERE batch_id = ? AND capture_id = ? AND vault_id = ?`).get(batchId, captureId, vaultId) as {
      snapshot: string; fingerprint: string; analysis_sync_error: number } | undefined;
  if (existing) return { vaultId, snapshot: existing.snapshot, fingerprint: existing.fingerprint, duplicate: true,
    analysisSyncError: !!existing.analysis_sync_error };
  const claim = db.prepare(`UPDATE import_items SET status = 'processing' WHERE batch_id = ? AND capture_id = ?
    AND status IN ('ready', 'failed', 'imported') AND disposition != 'trashed'`).run(batchId, captureId);
  if (claim.changes !== 1) throw new FilingError("SOURCE_BUSY", 409);
  let result: SnapshotResult;
  try {
    const originalCandidate = JSON.parse(row.payload_json) as CaptureCandidate;
    const candidate = { ...originalCandidate, authorship: row.authorship };
    const key = row.source_key ?? sourceKey(candidate);
    const mapped = db.prepare("SELECT snapshot, fingerprint FROM vault_source_keys WHERE vault_id = ? AND source_key = ?")
      .get(vaultId, key) as { snapshot: string; fingerprint: string } | undefined;
    if (mapped) {
      if (!await verifiedSnapshot(vault.path, mapped.snapshot, mapped.fingerprint)) throw new FilingError("SOURCE_CHANGED", 409);
      const manifest = JSON.parse(await readFile(join(vault.path, ".ocf", "ingest-manifest.json"), "utf8")) as {
        sources?: Record<string, { author?: string | null; authorship?: string; metadata_version?: number }> };
      let entry = manifest.sources?.[mapped.fingerprint];
      if (!entry) throw new FilingError("SOURCE_CHANGED", 409);
      const oldAuthor = entry.author ?? null;
      const oldAuthorship = entry.authorship ?? "unknown";
      const requestedAuthor = candidate.author ?? null;
      const requestedAuthorship = candidate.authorship ?? "unknown";
      if ((oldAuthor && requestedAuthor && oldAuthor !== requestedAuthor) ||
        (oldAuthorship !== "unknown" && requestedAuthorship !== "unknown" && oldAuthorship !== requestedAuthorship))
        throw new FilingError("SOURCE_METADATA_CONFLICT", 409);
      const canonicalAuthor = oldAuthor ?? requestedAuthor;
      const canonicalAuthorship = oldAuthorship === "unknown" ? requestedAuthorship : oldAuthorship;
      if (canonicalAuthor !== oldAuthor || canonicalAuthorship !== oldAuthorship) {
        const prior = db.prepare(`SELECT m.batch_id, m.capture_id, i.metadata_version FROM import_item_vaults m
          JOIN import_items i ON i.batch_id = m.batch_id AND i.capture_id = m.capture_id
          WHERE m.vault_id = ? AND m.fingerprint = ? ORDER BY m.created_at LIMIT 1`)
          .get(vaultId, mapped.fingerprint) as {
            batch_id: string; capture_id: string; metadata_version: number } | undefined;
        if (!prior) throw new FilingError("SOURCE_METADATA_CONFLICT", 409);
        const priorVaults = (db.prepare(`SELECT COUNT(*) AS n FROM import_item_vaults
          WHERE batch_id = ? AND capture_id = ?`).get(prior.batch_id, prior.capture_id) as { n: number }).n;
        const scoped = priorVaults > 1;
        if (scoped) db.prepare(`INSERT OR REPLACE INTO source_metadata_attention
          (batch_id,capture_id,reason,created_at) VALUES (?,?,'VAULT_METADATA_DIFFERS',?)`)
          .run(prior.batch_id, prior.capture_id, new Date().toISOString());
        const correct = async (): Promise<void> => {
          if (scoped) await correctManifestEntry(registry, { vaultPath: vault.path,
            fingerprint: mapped.fingerprint, snapshot: mapped.snapshot, expectedAuthor: oldAuthor,
            expectedAuthorship: oldAuthorship, expectedVersion: entry?.metadata_version ?? 0,
            author: canonicalAuthor, authorship: canonicalAuthorship });
          else await correctFiledMetadata(db, registry, prior.batch_id, prior.capture_id,
            { expectedVersion: prior.metadata_version, author: canonicalAuthor, authorship: canonicalAuthorship });
        };
        try { if (options.maintenanceJobs) await options.maintenanceJobs.runMetadataCorrection(correct);
          else await correct(); }
        catch (error) {
          if (error instanceof ProvenanceError) throw new FilingError(error.code, error.status);
          if (scoped) throw new FilingError("SOURCE_METADATA_CORRECTION_UNCERTAIN", 409);
          throw error;
        }
        if (scoped) {
          const priorJob = db.prepare(`SELECT id, status, result_json FROM analysis_jobs WHERE mode = 'maintain'
            AND vault_id = ? AND fingerprint = ? ORDER BY rowid DESC LIMIT 1`)
            .get(vaultId, mapped.fingerprint) as { id: string; status: string; result_json: string | null } | undefined;
          if (priorJob && ["completed", "skipped"].includes(priorJob.status)) {
            const previous = priorJob.result_json ? JSON.parse(priorJob.result_json) as Record<string, unknown> : {};
            db.prepare(`UPDATE analysis_jobs SET status = 'needs_attention', stage = 'metadata_sync',
              error_code = 'SOURCE_METADATA_CHANGED', result_json = ?, updated_at = ? WHERE id = ?`)
              .run(JSON.stringify({ ...previous, metadataSync: { previousStatus: priorJob.status,
                previousAuthor: oldAuthor, previousAuthorship: oldAuthorship,
                author: canonicalAuthor, authorship: canonicalAuthorship } }), new Date().toISOString(), priorJob.id);
          }
        }
        const currentManifest = JSON.parse(await readFile(join(vault.path, ".ocf", "ingest-manifest.json"), "utf8")) as
          { sources?: Record<string, { author?: string | null; authorship?: string }> };
        entry = currentManifest.sources?.[mapped.fingerprint];
        if (!entry || (entry.author ?? null) !== canonicalAuthor ||
          (entry.authorship ?? "unknown") !== canonicalAuthorship)
          throw new FilingError("SOURCE_METADATA_CORRECTION_UNCERTAIN", 409);
      }
      if (canonicalAuthor === null) delete candidate.author;
      else candidate.author = canonicalAuthor;
      candidate.authorship = canonicalAuthorship as "self" | "third_party" | "unknown";
      result = { snapshot: mapped.snapshot, fingerprint: mapped.fingerprint, duplicate: true };
    } else {
      result = await importSnapshot(candidate, vault.path, registry.maintainerRoot);
      if (!await verifiedSnapshot(vault.path, result.snapshot, result.fingerprint)) throw new FilingError("SOURCE_CHANGED", 409);
    }
    db.transaction(() => {
      db.prepare(`INSERT OR IGNORE INTO vault_source_keys (vault_id, source_key, snapshot, fingerprint, created_at)
        VALUES (?, ?, ?, ?, ?)`).run(vaultId, key, result.snapshot, result.fingerprint, new Date().toISOString());
      const canonical = db.prepare("SELECT snapshot, fingerprint FROM vault_source_keys WHERE vault_id = ? AND source_key = ?")
        .get(vaultId, key) as { snapshot: string; fingerprint: string };
      if (canonical.snapshot !== result.snapshot || canonical.fingerprint !== result.fingerprint) throw new FilingError("SOURCE_KEY_CONFLICT", 409);
      db.prepare(`INSERT INTO import_item_vaults (batch_id, capture_id, vault_id, snapshot, fingerprint, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(batchId, captureId, vaultId, result.snapshot, result.fingerprint, new Date().toISOString());
      if ((candidate.author ?? null) !== (originalCandidate.author ?? null) ||
        candidate.authorship !== row.authorship) {
        db.prepare(`UPDATE import_items SET payload_json = ?, authorship = ?, metadata_version = metadata_version + 1
          WHERE batch_id = ? AND capture_id = ?`).run(JSON.stringify(candidate), candidate.authorship, batchId, captureId);
      }
      db.prepare(`UPDATE import_items SET status = 'imported', disposition = 'active', error_code = NULL,
        vault_id = COALESCE(vault_id, ?), snapshot = COALESCE(snapshot, ?), fingerprint = COALESCE(fingerprint, ?),
        processed_at = ? WHERE batch_id = ? AND capture_id = ?`)
        .run(vaultId, result.snapshot, result.fingerprint, new Date().toISOString(), batchId, captureId);
      if (registry.maintenancePolicy(vaultId).enabled) {
        options.maintenanceJobs?.recordFiled(batchId, captureId, vaultId, result.snapshot, result.fingerprint);
      }
    })();
    options.maintenanceJobs?.wake();
  } catch (error) {
    db.prepare("UPDATE import_items SET status = ?, error_code = ? WHERE batch_id = ? AND capture_id = ? AND status = 'processing'")
      .run(row.status === "imported" ? "imported" : "failed", row.status === "imported" ? null :
        error instanceof FilingError ? error.code : "VAULT_IMPORT_FAILED", batchId, captureId);
    throw error instanceof FilingError ? error : error instanceof Error && error.message === "PROCESS_EXIT_UNCONFIRMED"
      ? new FilingError("PROCESS_EXIT_UNCONFIRMED", 503) : new FilingError("VAULT_IMPORT_FAILED", 502);
  }
  let analysisSyncError = false;
  try { await syncCaptureAnalysis(db, batchId, captureId, vaultId, result.snapshot, result.fingerprint, vault.path); }
  catch { analysisSyncError = true; }
  db.transaction(() => {
    db.prepare(`UPDATE import_item_vaults SET analysis_sync_error = ? WHERE batch_id = ? AND capture_id = ? AND vault_id = ?`)
      .run(analysisSyncError ? 1 : 0, batchId, captureId, vaultId);
    db.prepare(`UPDATE import_items SET analysis_sync_error = (SELECT MAX(analysis_sync_error) FROM import_item_vaults
      WHERE batch_id = ? AND capture_id = ?) WHERE batch_id = ? AND capture_id = ?`)
      .run(batchId, captureId, batchId, captureId);
  })();
  return { vaultId, ...result, analysisSyncError };
}
