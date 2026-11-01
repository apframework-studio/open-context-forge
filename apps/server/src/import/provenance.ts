import type Database from "better-sqlite3";
import type { CaptureCandidate } from "@ocf/contracts";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { runTool } from "../process/run.js";
import type { VaultRegistry } from "../vaults/registry.js";
import { verifiedSnapshot } from "./filing-recovery.js";

export class ProvenanceError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}

export async function correctManifestEntry(vaults: VaultRegistry, input: {
  vaultPath: string; fingerprint: string; snapshot: string; expectedAuthor: string | null;
  expectedAuthorship: string; expectedVersion: number; author: string | null; authorship: string;
  repairAudit?: boolean;
}): Promise<void> {
  const args = [join(vaults.maintainerRoot, "scripts", "correct-source-metadata.js"),
    "--vault", input.vaultPath, "--fingerprint", input.fingerprint,
    "--expected-snapshot", input.snapshot, "--expected-author", input.expectedAuthor ?? "",
    "--expected-authorship", input.expectedAuthorship, "--expected-version", String(input.expectedVersion),
    "--author", input.author ?? "", "--authorship", input.authorship, "--json"];
  if (input.repairAudit) args.push("--repair-audit");
  const result = await runTool(process.execPath, args, { cwd: vaults.maintainerRoot, timeoutMs: 60_000 });
  let report: { fingerprint?: string; snapshot?: string; author?: string | null; authorship?: string;
    reconciled?: boolean };
  try { report = JSON.parse(result.stdout) as typeof report; }
  catch { throw new ProvenanceError("SOURCE_METADATA_CORRECTION_UNCERTAIN", 409); }
  if (report.fingerprint !== input.fingerprint || report.snapshot !== input.snapshot ||
    (report.author ?? null) !== input.author || report.authorship !== input.authorship ||
    (input.repairAudit && report.reconciled !== true))
    throw new ProvenanceError("SOURCE_METADATA_CORRECTION_UNCERTAIN", 409);
}

export function updateItemMetadata(db: Database.Database, batchId: string, captureId: string, input: unknown) {
  if (!input || typeof input !== "object") throw new ProvenanceError("INVALID_SOURCE_METADATA", 422);
  const body = input as { author?: unknown; authorship?: unknown; expectedVersion?: unknown };
  if (!Number.isInteger(body.expectedVersion) || (body.expectedVersion as number) < 0 ||
    (body.author === undefined && body.authorship === undefined) ||
    (body.author !== undefined && body.author !== null &&
      (typeof body.author !== "string" || !body.author.trim() || body.author.length > 200)) ||
    (body.authorship !== undefined && !["self", "third_party", "unknown"].includes(String(body.authorship)))) {
    throw new ProvenanceError("INVALID_SOURCE_METADATA", 422);
  }
  return db.transaction(() => {
    const row = db.prepare(`SELECT payload_json, authorship, metadata_version, status FROM import_items
      WHERE batch_id = ? AND capture_id = ?`).get(batchId, captureId) as {
        payload_json: string; authorship: string; metadata_version: number; status: string } | undefined;
    if (!row) throw new ProvenanceError("SOURCE_NOT_FOUND", 404);
    if (row.metadata_version !== body.expectedVersion) throw new ProvenanceError("SOURCE_METADATA_CHANGED", 409);
    if (row.status === "processing" || db.prepare(`SELECT 1 FROM filing_jobs WHERE batch_id = ? AND capture_id = ?
      AND (status = 'running' OR (status = 'needs_attention' AND stage = 'reconcile')) LIMIT 1`)
      .get(batchId, captureId)) throw new ProvenanceError("SOURCE_BUSY", 409);
    if (db.prepare(`SELECT 1 FROM import_item_vaults WHERE batch_id = ? AND capture_id = ? LIMIT 1`)
      .get(batchId, captureId)) throw new ProvenanceError("SOURCE_ALREADY_FILED", 409);
    const candidate = JSON.parse(row.payload_json) as CaptureCandidate;
    if (body.author !== undefined) {
      if (body.author === null) delete candidate.author;
      else candidate.author = (body.author as string).trim();
    }
    const authorship = body.authorship === undefined ? row.authorship : body.authorship as string;
    db.prepare(`UPDATE import_items SET payload_json = ?, authorship = ?, metadata_version = metadata_version + 1,
      author_overridden = CASE WHEN ? THEN 1 ELSE author_overridden END,
      authorship_overridden = CASE WHEN ? THEN 1 ELSE authorship_overridden END
      WHERE batch_id = ? AND capture_id = ? AND metadata_version = ?`).run(JSON.stringify(candidate), authorship,
      body.author !== undefined ? 1 : 0, body.authorship !== undefined ? 1 : 0,
      batchId, captureId, body.expectedVersion);
    return { ...candidate, authorship, metadataVersion: row.metadata_version + 1,
      authorOverridden: body.author !== undefined, authorshipOverridden: body.authorship !== undefined };
  })();
}

export async function correctFiledMetadata(db: Database.Database, vaults: VaultRegistry,
  batchId: string, captureId: string, input: unknown) {
  if (!input || typeof input !== "object") throw new ProvenanceError("INVALID_SOURCE_METADATA", 422);
  const body = input as { author?: unknown; authorship?: unknown; expectedVersion?: unknown };
  if (!Number.isInteger(body.expectedVersion) || (body.expectedVersion as number) < 0 ||
    (body.author === undefined && body.authorship === undefined) ||
    (body.author !== undefined && body.author !== null &&
      (typeof body.author !== "string" || !body.author.trim() || body.author.length > 200)) ||
    (body.authorship !== undefined && !["self", "third_party", "unknown"].includes(String(body.authorship))))
    throw new ProvenanceError("INVALID_SOURCE_METADATA", 422);
  const row = db.prepare(`SELECT payload_json, authorship, metadata_version FROM import_items
    WHERE batch_id = ? AND capture_id = ?`).get(batchId, captureId) as {
    payload_json: string; authorship: string; metadata_version: number } | undefined;
  if (!row) throw new ProvenanceError("SOURCE_NOT_FOUND", 404);
  if (row.metadata_version !== body.expectedVersion) throw new ProvenanceError("SOURCE_METADATA_CHANGED", 409);
  const memberships = db.prepare(`SELECT vault_id, fingerprint, snapshot FROM import_item_vaults
    WHERE batch_id = ? AND capture_id = ? ORDER BY vault_id`).all(batchId, captureId) as {
    vault_id: string; fingerprint: string; snapshot: string }[];
  if (!memberships.length) return updateItemMetadata(db, batchId, captureId, input);
  if (db.prepare(`SELECT 1 FROM filing_jobs WHERE batch_id = ? AND capture_id = ? AND status IN ('queued','running','retry_wait')
    LIMIT 1`).get(batchId, captureId) ||
    db.prepare(`SELECT 1 FROM analysis_jobs WHERE batch_id = ? AND capture_id = ? AND status = 'running' LIMIT 1`)
      .get(batchId, captureId) || memberships.some((membership) => db.prepare(`SELECT 1 FROM analysis_jobs
        WHERE mode = 'maintain' AND vault_id = ? AND fingerprint = ? AND status = 'running' LIMIT 1`)
      .get(membership.vault_id, membership.fingerprint))) throw new ProvenanceError("SOURCE_BUSY", 409);
  const candidate = JSON.parse(row.payload_json) as CaptureCandidate;
  const nextAuthor = body.author === undefined ? candidate.author ?? null : body.author === null ? null : body.author.trim();
  const nextAuthorship = body.authorship === undefined ? row.authorship : body.authorship as string;
  const expectedAuthor = candidate.author ?? null;
  const recovering = !!db.prepare(`SELECT 1 FROM source_metadata_attention WHERE batch_id = ? AND capture_id = ?`)
    .get(batchId, captureId);
  let corrected = 0;
  let correctionStarted = false;
  try {
    const pending: { vaultPath: string; fingerprint: string; snapshot: string; version: number;
      repairAudit: boolean }[] = [];
    for (const membership of memberships) {
      const vault = vaults.get(membership.vault_id);
      if (!vault) throw new ProvenanceError("VAULT_NOT_FOUND", 404);
      const manifest = JSON.parse(await readFile(join(vault.path, ".ocf", "ingest-manifest.json"), "utf8")) as {
        sources?: Record<string, { snapshot?: string; author?: string | null; authorship?: string; metadata_version?: number }> };
      const entry = manifest.sources?.[membership.fingerprint];
      if (!entry || entry.snapshot !== membership.snapshot)
        throw new ProvenanceError("SOURCE_METADATA_CHANGED", 409);
      if (!await verifiedSnapshot(vault.path, membership.snapshot, membership.fingerprint))
        throw new ProvenanceError("SOURCE_CHANGED", 409);
      const currentAuthor = entry.author ?? null;
      const currentAuthorship = entry.authorship ?? "unknown";
      const currentVersion = entry.metadata_version ?? 0;
      if (currentAuthor === nextAuthor && currentAuthorship === nextAuthorship) {
        if (currentAuthor === expectedAuthor && currentAuthorship === row.authorship) continue;
        if (!recovering || currentVersion < 1)
          throw new ProvenanceError("SOURCE_METADATA_CHANGED", 409);
        pending.push({ vaultPath: vault.path, fingerprint: membership.fingerprint,
          snapshot: membership.snapshot, version: currentVersion - 1, repairAudit: true });
        continue;
      }
      if (currentAuthor !== expectedAuthor || currentAuthorship !== row.authorship)
        throw new ProvenanceError("SOURCE_METADATA_CHANGED", 409);
      pending.push({ vaultPath: vault.path, fingerprint: membership.fingerprint,
        snapshot: membership.snapshot, version: currentVersion, repairAudit: false });
    }
    for (const membership of pending) {
      correctionStarted = true;
      await correctManifestEntry(vaults, { vaultPath: membership.vaultPath,
        fingerprint: membership.fingerprint, snapshot: membership.snapshot,
        expectedAuthor, expectedAuthorship: row.authorship, expectedVersion: membership.version,
        author: nextAuthor, authorship: nextAuthorship, repairAudit: membership.repairAudit });
      corrected++;
    }
  } catch (error) {
    if (corrected || correctionStarted || error instanceof ProvenanceError && error.code === "SOURCE_METADATA_CORRECTION_UNCERTAIN") {
      db.exec(`CREATE TABLE IF NOT EXISTS source_metadata_attention (
        batch_id TEXT NOT NULL, capture_id TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(batch_id,capture_id))`);
      db.prepare(`INSERT OR REPLACE INTO source_metadata_attention VALUES (?,?,'PARTIAL_METADATA_CORRECTION',?)`)
        .run(batchId, captureId, new Date().toISOString());
      throw new ProvenanceError("PARTIAL_METADATA_CORRECTION", 409);
    }
    if (error instanceof ProvenanceError) throw error;
    throw new ProvenanceError(error instanceof Error && /conflict/i.test(error.message) ?
      "SOURCE_METADATA_CHANGED" : "SOURCE_METADATA_CORRECTION_FAILED", 409);
  }
  if (body.author !== undefined) {
    if (nextAuthor === null) delete candidate.author;
    else candidate.author = nextAuthor;
  }
  try { db.transaction(() => {
    const changed = db.prepare(`UPDATE import_items SET payload_json = ?, authorship = ?, metadata_version = metadata_version + 1,
      author_overridden = CASE WHEN ? THEN 1 ELSE author_overridden END,
      authorship_overridden = CASE WHEN ? THEN 1 ELSE authorship_overridden END
      WHERE batch_id = ? AND capture_id = ? AND metadata_version = ?`).run(JSON.stringify(candidate), nextAuthorship,
      body.author !== undefined ? 1 : 0, body.authorship !== undefined ? 1 : 0,
      batchId, captureId, body.expectedVersion);
    if (changed.changes !== 1) throw new ProvenanceError("SOURCE_METADATA_CHANGED", 409);
    for (const membership of memberships) {
      const prior = db.prepare(`SELECT id, status, result_json FROM analysis_jobs WHERE mode = 'maintain'
        AND vault_id = ? AND fingerprint = ? ORDER BY rowid DESC LIMIT 1`)
        .get(membership.vault_id, membership.fingerprint) as {
          id: string; status: string; result_json: string | null } | undefined;
      if (prior && ["completed", "skipped"].includes(prior.status)) {
        const result = prior.result_json ? JSON.parse(prior.result_json) as Record<string, unknown> : {};
        const metadataSync = { previousStatus: prior.status, previousAuthor: expectedAuthor,
          previousAuthorship: row.authorship, author: nextAuthor, authorship: nextAuthorship };
        db.prepare(`UPDATE analysis_jobs SET status = 'needs_attention', stage = 'metadata_sync',
          error_code = 'SOURCE_METADATA_CHANGED', result_json = ?, updated_at = ? WHERE id = ?`)
          .run(JSON.stringify({ ...result, metadataSync }), new Date().toISOString(), prior.id);
      }
    }
    db.prepare("DELETE FROM source_metadata_attention WHERE batch_id = ? AND capture_id = ?")
      .run(batchId, captureId);
  })(); }
  catch (error) {
    db.prepare(`INSERT OR REPLACE INTO source_metadata_attention VALUES (?,?,'PARTIAL_METADATA_CORRECTION',?)`)
      .run(batchId, captureId, new Date().toISOString());
    throw error;
  }
  return { ...candidate, authorship: nextAuthorship, metadataVersion: row.metadata_version + 1,
    authorOverridden: body.author !== undefined, authorshipOverridden: body.authorship !== undefined };
}
