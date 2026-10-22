import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { CaptureCandidate } from "@ocf/contracts";

export interface ImportBatch {
  batchId: string;
  createdAt: string;
  candidates: CaptureCandidate[];
}

export function openDatabase(dataDir: string) {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, "state.sqlite"));
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS import_batches (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS import_items (
      batch_id TEXT NOT NULL REFERENCES import_batches(id),
      capture_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      error_code TEXT,
      PRIMARY KEY (batch_id, capture_id)
    );
  `);
  return db;
}

export function insertBatch(db: Database.Database, batch: ImportBatch): void {
  db.transaction(() => {
    db.prepare("INSERT INTO import_batches (id, created_at) VALUES (?, ?)")
      .run(batch.batchId, batch.createdAt);
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
  const items = db.prepare("SELECT payload_json FROM import_items WHERE batch_id = ? ORDER BY rowid")
    .all(batchId) as { payload_json: string }[];
  return {
    batchId: row.id,
    createdAt: row.created_at,
    candidates: items.map((item) => JSON.parse(item.payload_json) as CaptureCandidate),
  };
}
