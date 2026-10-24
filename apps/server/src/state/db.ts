import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { CaptureCandidate } from "@ocf/contracts";

export interface ImportBatch {
  batchId: string;
  createdAt: string;
  candidates: (Omit<CaptureCandidate, "status"> & { status: CaptureCandidate["status"] | "processing" | "imported" | "failed"; errorCode?: string;
    vaultId?: string; snapshot?: string; fingerprint?: string;
    vaults: { vaultId: string; snapshot: string; fingerprint: string; analysisSyncError: boolean }[] })[];
}

export function openDatabase(dataDir: string) {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, "state.sqlite"));
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS import_batches (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      auto_vault_id TEXT
    );
    CREATE TABLE IF NOT EXISTS import_items (
      batch_id TEXT NOT NULL REFERENCES import_batches(id),
      capture_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      error_code TEXT,
      vault_id TEXT,
      snapshot TEXT,
      fingerprint TEXT,
      disposition TEXT NOT NULL DEFAULT 'active',
      processed_at TEXT,
      analysis_sync_error INTEGER NOT NULL DEFAULT 0,
      auto_file_suppressed INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (batch_id, capture_id)
    );
    CREATE TABLE IF NOT EXISTS import_item_vaults (
      batch_id TEXT NOT NULL,
      capture_id TEXT NOT NULL,
      vault_id TEXT NOT NULL,
      snapshot TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      analysis_sync_error INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      PRIMARY KEY (batch_id, capture_id, vault_id),
      FOREIGN KEY (batch_id, capture_id) REFERENCES import_items(batch_id, capture_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS import_policy (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      mode TEXT NOT NULL,
      vault_id TEXT
    );
    CREATE TABLE IF NOT EXISTS capture_analyses (
      batch_id TEXT NOT NULL,
      capture_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      status TEXT NOT NULL,
      card_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (batch_id, capture_id),
      FOREIGN KEY (batch_id, capture_id) REFERENCES import_items(batch_id, capture_id)
    );
  `);
  const columns = new Set((db.pragma("table_info(import_items)") as { name: string }[]).map((item) => item.name));
  const batchColumns = new Set((db.pragma("table_info(import_batches)") as { name: string }[]).map((item) => item.name));
  if (!batchColumns.has("auto_vault_id")) db.exec("ALTER TABLE import_batches ADD COLUMN auto_vault_id TEXT");
  for (const name of ["vault_id", "snapshot", "fingerprint"]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE import_items ADD COLUMN ${name} TEXT`);
  }
  if (!columns.has("disposition")) db.exec("ALTER TABLE import_items ADD COLUMN disposition TEXT NOT NULL DEFAULT 'active'");
  if (!columns.has("processed_at")) db.exec("ALTER TABLE import_items ADD COLUMN processed_at TEXT");
  if (!columns.has("analysis_sync_error")) db.exec("ALTER TABLE import_items ADD COLUMN analysis_sync_error INTEGER NOT NULL DEFAULT 0");
  if (!columns.has("auto_file_suppressed")) db.exec("ALTER TABLE import_items ADD COLUMN auto_file_suppressed INTEGER NOT NULL DEFAULT 0");
  db.prepare(`INSERT OR IGNORE INTO import_item_vaults
    (batch_id, capture_id, vault_id, snapshot, fingerprint, analysis_sync_error, created_at)
    SELECT batch_id, capture_id, vault_id, snapshot, fingerprint, analysis_sync_error,
      COALESCE(processed_at, CURRENT_TIMESTAMP) FROM import_items
    WHERE vault_id IS NOT NULL AND snapshot IS NOT NULL AND fingerprint IS NOT NULL`).run();
  db.prepare(`UPDATE import_items SET status = CASE WHEN EXISTS (
    SELECT 1 FROM import_item_vaults v WHERE v.batch_id = import_items.batch_id AND v.capture_id = import_items.capture_id
  ) THEN 'imported' ELSE 'ready' END WHERE status = 'processing'`).run();
  db.prepare("INSERT OR IGNORE INTO import_policy (id, mode, vault_id) VALUES (1, 'manual', NULL)").run();
  return db;
}

export function insertBatch(db: Database.Database, batch: { batchId: string; createdAt: string; candidates: CaptureCandidate[]; autoVaultId?: string | null }): void {
  db.transaction(() => {
    db.prepare("INSERT INTO import_batches (id, created_at, auto_vault_id) VALUES (?, ?, ?)")
      .run(batch.batchId, batch.createdAt, batch.autoVaultId ?? null);
    const insertItem = db.prepare(`
      INSERT INTO import_items (batch_id, capture_id, payload_json, status, error_code)
      VALUES (?, ?, ?, ?, NULL)
    `);
    for (const item of batch.candidates) {
      insertItem.run(batch.batchId, item.id, JSON.stringify(item), item.status);
    }
  })();
}

export function getBatch(db: Database.Database, batchId: string): ImportBatch | undefined {
  const row = db.prepare("SELECT id, created_at FROM import_batches WHERE id = ?")
    .get(batchId) as { id: string; created_at: string } | undefined;
  if (!row) return undefined;
  const items = db.prepare("SELECT payload_json, status, error_code, vault_id, snapshot, fingerprint FROM import_items WHERE batch_id = ? ORDER BY rowid")
    .all(batchId) as { payload_json: string; status: ImportBatch["candidates"][number]["status"]; error_code: string | null;
      vault_id: string | null; snapshot: string | null; fingerprint: string | null }[];
  const memberships = db.prepare(`SELECT capture_id, vault_id, snapshot, fingerprint, analysis_sync_error
    FROM import_item_vaults WHERE batch_id = ? ORDER BY created_at, rowid`).all(batchId) as {
      capture_id: string; vault_id: string; snapshot: string; fingerprint: string; analysis_sync_error: number }[];
  return {
    batchId: row.id,
    createdAt: row.created_at,
    candidates: items.map((item) => ({
      ...(JSON.parse(item.payload_json) as CaptureCandidate), status: item.status,
      ...(item.error_code ? { errorCode: item.error_code } : {}),
      ...(item.vault_id && item.snapshot && item.fingerprint ?
        { vaultId: item.vault_id, snapshot: item.snapshot, fingerprint: item.fingerprint } : {}),
      vaults: memberships.filter((membership) => membership.capture_id === (JSON.parse(item.payload_json) as CaptureCandidate).id)
        .map((membership) => ({ vaultId: membership.vault_id, snapshot: membership.snapshot,
          fingerprint: membership.fingerprint, analysisSyncError: !!membership.analysis_sync_error })),
    })),
  };
}
