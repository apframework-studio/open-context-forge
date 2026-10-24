import type Database from "better-sqlite3";
import type { CaptureCandidate } from "@ocf/contracts";
import { importSnapshot, type SnapshotResult } from "../vaults/maintainer.js";
import type { VaultRegistry } from "../vaults/registry.js";
import { syncCaptureAnalysis } from "../analysis/service.js";

export class FilingError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}

export async function fileCapture(db: Database.Database, registry: VaultRegistry, batchId: string, captureId: string, vaultId: string,
  options: { automatic?: boolean } = {}) {
  const vault = registry.get(vaultId);
  if (!vault) throw new FilingError("VAULT_NOT_FOUND", 404);
  const row = db.prepare(`SELECT payload_json, status, disposition, vault_id, snapshot, fingerprint, analysis_sync_error
    FROM import_items WHERE batch_id = ? AND capture_id = ?`).get(batchId, captureId) as {
    payload_json: string; status: string; disposition: string; vault_id: string | null;
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
    const candidate = JSON.parse(row.payload_json) as CaptureCandidate;
    result = await importSnapshot(candidate, vault.path, registry.maintainerRoot);
    db.transaction(() => {
      db.prepare(`INSERT INTO import_item_vaults (batch_id, capture_id, vault_id, snapshot, fingerprint, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(batchId, captureId, vaultId, result.snapshot, result.fingerprint, new Date().toISOString());
      db.prepare(`UPDATE import_items SET status = 'imported', disposition = 'active', error_code = NULL,
        vault_id = COALESCE(vault_id, ?), snapshot = COALESCE(snapshot, ?), fingerprint = COALESCE(fingerprint, ?),
        processed_at = ? WHERE batch_id = ? AND capture_id = ?`)
        .run(vaultId, result.snapshot, result.fingerprint, new Date().toISOString(), batchId, captureId);
    })();
  } catch {
    db.prepare("UPDATE import_items SET status = ?, error_code = ? WHERE batch_id = ? AND capture_id = ? AND status = 'processing'")
      .run(row.status === "imported" ? "imported" : "failed", row.status === "imported" ? null : "VAULT_IMPORT_FAILED", batchId, captureId);
    throw new FilingError("VAULT_IMPORT_FAILED", 502);
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
