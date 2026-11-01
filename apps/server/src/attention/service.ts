import type Database from "better-sqlite3";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { VaultRegistry } from "../vaults/registry.js";

export interface AttentionItem {
  id: string;
  kind: "filing" | "maintenance" | "analysis" | "metadata" | "lane";
  batchId: string | null;
  captureId: string | null;
  vaultId: string | null;
  title: string;
  stage: string;
  errorCode: string | null;
  createdAt: string;
  result: unknown;
}

export interface AttentionDetail extends AttentionItem {
  snapshot: string | null;
  plan: { path: string; markdown: string } | null;
  journal: { path: string; data: unknown } | null;
  targets: string[];
}

export class AttentionService {
  constructor(private readonly db: Database.Database, private readonly vaults?: VaultRegistry) {
    db.exec(`CREATE TABLE IF NOT EXISTS attention_reminder (
      id INTEGER PRIMARY KEY CHECK (id = 1), last_local_date TEXT
    );
    CREATE TABLE IF NOT EXISTS source_metadata_attention (
      batch_id TEXT NOT NULL, capture_id TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(batch_id,capture_id)
    );`);
    db.prepare("INSERT OR IGNORE INTO attention_reminder (id,last_local_date) VALUES (1,NULL)").run();
  }

  list(localDate: string): { count: number; items: AttentionItem[]; reminderDue: boolean } {
    const filing = this.db.prepare(`SELECT f.id, f.batch_id, f.capture_id, f.vault_id, f.stage, f.error_code,
      f.updated_at, i.payload_json FROM filing_jobs f JOIN import_items i ON i.batch_id = f.batch_id
      AND i.capture_id = f.capture_id WHERE f.status = 'needs_attention' ORDER BY f.updated_at LIMIT 200`).all() as {
      id: string; batch_id: string; capture_id: string; vault_id: string; stage: string; error_code: string | null;
      updated_at: string; payload_json: string }[];
    const maintenance = this.db.prepare(`SELECT j.id, j.batch_id, j.capture_id, j.vault_id, j.mode, j.stage,
      j.error_code, j.updated_at, j.result_json, i.payload_json FROM analysis_jobs j JOIN import_items i
      ON i.batch_id = j.batch_id AND i.capture_id = j.capture_id
      WHERE j.status IN ('needs_attention','blocked') ORDER BY j.updated_at LIMIT 200`).all() as {
      id: string; batch_id: string; capture_id: string; vault_id: string | null; mode: string; stage: string;
      error_code: string | null; updated_at: string; result_json: string | null; payload_json: string }[];
    const lanes = ["filing", "analysis"].flatMap((lane) => {
      const row = this.db.prepare(`SELECT paused_reason, updated_at FROM ${lane}_lane_state WHERE id = 1`)
        .get() as { paused_reason: string | null; updated_at: string };
      return row.paused_reason ? [{ id: `lane:${lane}`, kind: "lane" as const, batchId: null, captureId: null,
        vaultId: null, title: lane === "filing" ? "raw 入库执行位已暂停" : "Claude 知识维护执行位已暂停",
        stage: "paused", errorCode: row.paused_reason, createdAt: row.updated_at, result: null }] : [];
    });
    const metadata = this.db.prepare(`SELECT a.batch_id, a.capture_id, a.reason, a.created_at, i.payload_json
      FROM source_metadata_attention a JOIN import_items i ON i.batch_id = a.batch_id
      AND i.capture_id = a.capture_id ORDER BY a.created_at LIMIT 200`).all() as {
      batch_id: string; capture_id: string; reason: string; created_at: string; payload_json: string }[];
    const items: AttentionItem[] = [
      ...lanes,
      ...metadata.map((row) => ({ id: `metadata:${row.batch_id}:${row.capture_id}`, kind: "metadata" as const,
        batchId: row.batch_id, captureId: row.capture_id, vaultId: null,
        title: (JSON.parse(row.payload_json) as { title: string }).title, stage: "metadata_sync",
        errorCode: row.reason, createdAt: row.created_at, result: null })),
      ...filing.map((row) => ({ id: `filing:${row.id}`, kind: "filing" as const, batchId: row.batch_id,
        captureId: row.capture_id, vaultId: row.vault_id, title: (JSON.parse(row.payload_json) as { title: string }).title,
        stage: row.stage, errorCode: row.error_code, createdAt: row.updated_at, result: null })),
      ...maintenance.map((row) => ({ id: `${row.mode === "maintain" ? "maintenance" : "analysis"}:${row.id}`,
        kind: row.mode === "maintain" ? "maintenance" as const : "analysis" as const,
        batchId: row.batch_id, captureId: row.capture_id, vaultId: row.vault_id,
        title: (JSON.parse(row.payload_json) as { title: string }).title, stage: row.stage,
        errorCode: row.error_code, createdAt: row.updated_at,
        result: row.result_json ? JSON.parse(row.result_json) : null })),
    ];
    const last = this.db.prepare("SELECT last_local_date FROM attention_reminder WHERE id = 1")
      .get() as { last_local_date: string | null };
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    return { count: items.length, items,
      reminderDue: !!items.some((item) => item.createdAt <= old) && last.last_local_date !== localDate };
  }

  markReminderSeen(localDate: string): void {
    this.db.prepare("UPDATE attention_reminder SET last_local_date = ? WHERE id = 1").run(localDate);
  }

  async detail(id: string): Promise<AttentionDetail | null> {
    const item = this.list(new Date().toISOString().slice(0, 10)).items.find((entry) => entry.id === id);
    if (!item) return null;
    const detail: AttentionDetail = { ...item, snapshot: null, plan: null, journal: null, targets: [] };
    if (item.kind !== "maintenance" || !item.vaultId) return detail;
    const row = this.db.prepare("SELECT fingerprint, snapshot FROM analysis_jobs WHERE id = ? AND mode = 'maintain'")
      .get(id.slice("maintenance:".length)) as { fingerprint: string; snapshot: string } | undefined;
    const vault = this.vaults?.get(item.vaultId);
    if (!row || !vault || !/^[a-f\d]{64}$/.test(row.fingerprint)) return detail;
    detail.snapshot = row.snapshot;
    const folder = join(vault.path, ".ocf", "compilations", row.fingerprint);
    try { if (await realpath(folder) !== folder) return detail; }
    catch { return detail; }
    const planPath = join(folder, "plan.md");
    const journalPath = join(folder, "journal.json");
    try {
      const planStat = await lstat(planPath);
      if (planStat.isFile() && planStat.size <= 100_000) {
        const markdown = await readFile(planPath, "utf8");
        detail.plan = { path: planPath, markdown };
      }
    } catch { /* Plan may not have been written yet. */ }
    try {
      const journalStat = await lstat(journalPath);
      if (journalStat.isFile() && journalStat.size <= 100_000) {
        const raw = await readFile(journalPath, "utf8");
        const data = JSON.parse(raw) as { paths?: { path?: string }[] };
        detail.journal = { path: journalPath, data };
        if (Array.isArray(data.paths)) detail.targets = data.paths.slice(0, 14).flatMap((entry) =>
          typeof entry.path === "string" ? [entry.path] : []);
      }
    } catch { /* Journal may not have been written yet. */ }
    return detail;
  }
}
