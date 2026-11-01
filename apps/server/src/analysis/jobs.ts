import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { AnalysisError, type AnalysisService } from "./service.js";
import type { MaintenanceCompiler } from "./maintenance.js";
import { applyMaintenanceChanges, MaintenanceWriteError } from "./maintenance-writer.js";
import { reconcileMaintenanceWrite, reconcileRolledBackWrite } from "./recovery.js";
import type { VaultRegistry } from "../vaults/registry.js";
import type { KnowledgeIndex } from "../vaults/knowledge-index.js";
import { verifiedSnapshot } from "../import/filing-recovery.js";

const require = createRequire(import.meta.url);

export interface AnalysisJob {
  id: string;
  batchId: string;
  captureId: string;
  status: "queued" | "running" | "retry_wait" | "completed" | "failed" | "skipped" | "needs_attention" | "blocked" | "cancelled";
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MaintenanceJob extends AnalysisJob {
  vaultId: string; fingerprint: string; snapshot: string;
  stage: string; attempt: number; result: unknown; nextRetryAt: string | null;
  startedAt: string | null; stageDeadlineAt: string | null;
}

type JobRow = {
  id: string; batch_id: string; capture_id: string; status: AnalysisJob["status"];
  error_code: string | null; created_at: string; updated_at: string;
  mode: "analysis_only" | "maintain"; vault_id: string | null; fingerprint: string | null;
  snapshot: string | null; stage: string; attempt: number; result_json: string | null;
  next_retry_at: string | null; run_token: string | null; child_pid: number | null;
  started_at: string | null; stage_deadline_at: string | null;
};
type PendingWrite = { pending?: boolean; recommendation?: string; authorship?: string;
  author?: string | null; card?: Record<string, unknown> };

const jobTable = `CREATE TABLE IF NOT EXISTS analysis_jobs (
  id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, capture_id TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'analysis_only', vault_id TEXT, fingerprint TEXT, snapshot TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued','running','retry_wait','completed','failed','skipped','needs_attention','blocked','cancelled')),
  stage TEXT NOT NULL DEFAULT 'analyze', attempt INTEGER NOT NULL DEFAULT 1, result_json TEXT,
  error_code TEXT, next_retry_at TEXT, run_token TEXT, child_pid INTEGER, started_at TEXT, stage_deadline_at TEXT, heartbeat_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY (batch_id, capture_id) REFERENCES import_items(batch_id, capture_id)
);`;

function jobOf(row: JobRow): AnalysisJob {
  return { id: row.id, batchId: row.batch_id, captureId: row.capture_id,
    status: row.status, errorCode: row.error_code, createdAt: row.created_at, updatedAt: row.updated_at };
}

function errorCode(error: unknown): string {
  return error instanceof AnalysisError || error instanceof MaintenanceWriteError ? error.code :
    error instanceof Error && /^AGENT_[A-Z_]+$/.test(error.message) ? error.message :
    error instanceof Error && error.message === "PROCESS_EXIT_UNCONFIRMED" ? "AGENT_EXIT_UNCONFIRMED" :
    error instanceof Error && error.message === "PROCESS_CANCELLED" ? "AGENT_CANCELLED" :
    error instanceof Error && error.message === "PROCESS_TIMEOUT" ? "AGENT_TIMEOUT" : "UNEXPECTED_ERROR";
}

function processAlive(pid: number | null): boolean {
  if (!pid || !Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

export class AnalysisJobs {
  private active: Promise<void> | null = null;
  private stopped = false;
  private serialTail: Promise<unknown> = Promise.resolve();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private activeAbort: AbortController | null = null;
  private activeId: string | null = null;
  private readonly cancelRequested = new Set<string>();
  private metadataCorrectionsPending = 0;

  constructor(private readonly db: Database.Database, private readonly analysis: AnalysisService,
    private readonly compiler?: MaintenanceCompiler, private readonly vaults?: VaultRegistry,
    private readonly knowledge?: KnowledgeIndex) {
    db.exec(jobTable);
    const columns = new Set((db.pragma("table_info(analysis_jobs)") as { name: string }[]).map((column) => column.name));
    if (!columns.has("mode")) db.transaction(() => {
      db.exec(`ALTER TABLE analysis_jobs RENAME TO analysis_jobs_legacy;
        ${jobTable}
        INSERT INTO analysis_jobs (id, batch_id, capture_id, status, error_code, created_at, updated_at)
          SELECT id, batch_id, capture_id, status, error_code, created_at, updated_at FROM analysis_jobs_legacy;
        DROP TABLE analysis_jobs_legacy;`);
    })();
    const tableSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'analysis_jobs'")
      .get() as { sql: string }).sql;
    if (!tableSql.includes("'retry_wait'")) db.transaction(() => {
      db.exec(`ALTER TABLE analysis_jobs RENAME TO analysis_jobs_old_status;
        ${jobTable}
        INSERT INTO analysis_jobs (id,batch_id,capture_id,mode,vault_id,fingerprint,snapshot,status,stage,attempt,
          result_json,error_code,created_at,updated_at)
          SELECT id,batch_id,capture_id,mode,vault_id,fingerprint,snapshot,status,stage,attempt,
          result_json,error_code,created_at,updated_at FROM analysis_jobs_old_status;
        DROP TABLE analysis_jobs_old_status;`);
    })();
    const currentColumns = new Set((db.pragma("table_info(analysis_jobs)") as { name: string }[]).map((column) => column.name));
    for (const name of ["next_retry_at", "run_token", "started_at", "stage_deadline_at", "heartbeat_at", "child_pid"]) {
      if (!currentColumns.has(name)) db.exec(`ALTER TABLE analysis_jobs ADD COLUMN ${name} ${name === "child_pid" ? "INTEGER" : "TEXT"}`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_analysis_jobs_item ON analysis_jobs(batch_id, capture_id, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_analysis_active_maintenance ON analysis_jobs(vault_id, fingerprint)
      WHERE mode = 'maintain' AND status IN ('queued', 'running', 'retry_wait', 'blocked');`);
    db.exec(`CREATE TABLE IF NOT EXISTS analysis_lane_state (
      id INTEGER PRIMARY KEY CHECK (id = 1), paused_reason TEXT, updated_at TEXT NOT NULL
    );`);
    db.prepare("INSERT OR IGNORE INTO analysis_lane_state (id,paused_reason,updated_at) VALUES (1,NULL,?)")
      .run(new Date().toISOString());
    db.prepare(`UPDATE analysis_jobs SET status = 'needs_attention' WHERE mode = 'maintain' AND status = 'skipped'
      AND json_valid(result_json) AND json_extract(result_json, '$.recommendation') = 'ask_user'`).run();
  }

  list(): AnalysisJob[] {
    const rows = this.db.prepare(`SELECT * FROM analysis_jobs WHERE mode = 'analysis_only'
      ORDER BY CASE WHEN status IN ('queued', 'running') THEN 0 ELSE 1 END, rowid DESC LIMIT 200`)
      .all() as JobRow[];
    return rows.map(jobOf);
  }

  listMaintenance(vaultId?: string): MaintenanceJob[] {
    const rows = this.db.prepare(`SELECT * FROM analysis_jobs WHERE mode = 'maintain' ${vaultId ? "AND vault_id = ?" : ""}
      ORDER BY CASE WHEN status IN ('queued', 'running', 'retry_wait', 'blocked') THEN 0 ELSE 1 END, rowid DESC LIMIT 200`)
      .all(...(vaultId ? [vaultId] : [])) as JobRow[];
    return rows.map((row) => ({ ...jobOf(row), vaultId: row.vault_id!, fingerprint: row.fingerprint!, snapshot: row.snapshot!,
      stage: row.stage, attempt: row.attempt, result: row.result_json ? JSON.parse(row.result_json) : null,
      nextRetryAt: row.next_retry_at, startedAt: row.started_at, stageDeadlineAt: row.stage_deadline_at }));
  }

  recordFiled(batchId: string, captureId: string, vaultId: string, snapshot: string, fingerprint: string): void {
    if (this.db.prepare("SELECT id FROM analysis_jobs WHERE mode = 'maintain' AND vault_id = ? AND fingerprint = ? AND status != 'cancelled' LIMIT 1")
      .get(vaultId, fingerprint)) return;
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO analysis_jobs
      (id, batch_id, capture_id, mode, vault_id, fingerprint, snapshot, status, created_at, updated_at)
      VALUES (?, ?, ?, 'maintain', ?, ?, ?, 'queued', ?, ?)`).run(randomUUID(), batchId, captureId, vaultId, fingerprint, snapshot, now, now);
  }

  enqueueMaintenance(vaultId: string, fingerprint: string): MaintenanceJob {
    const vault = this.vaults?.get(vaultId);
    if (!vault || !/^[a-f\d]{64}$/.test(fingerprint)) throw new AnalysisError("SOURCE_NOT_FOUND", 404);
    const member = this.db.prepare(`SELECT m.batch_id, m.capture_id, m.snapshot FROM import_item_vaults m
      JOIN import_items i ON i.batch_id = m.batch_id AND i.capture_id = m.capture_id
      WHERE m.vault_id = ? AND m.fingerprint = ? AND i.disposition != 'trashed' LIMIT 1`)
      .get(vaultId, fingerprint) as { batch_id: string; capture_id: string; snapshot: string } | undefined;
    if (!member) throw new AnalysisError("SOURCE_NOT_FOUND", 404);
    this.recordFiled(member.batch_id, member.capture_id, vaultId, member.snapshot, fingerprint);
    this.wake();
    return this.listMaintenance(vaultId).find((job) => job.fingerprint === fingerprint)!;
  }

  retryMaintenance(id: string): MaintenanceJob {
    const row = this.db.prepare("SELECT * FROM analysis_jobs WHERE id = ? AND mode = 'maintain'").get(id) as JobRow | undefined;
    if (!row) throw new AnalysisError("MAINTENANCE_JOB_NOT_FOUND", 404);
    const askUser = row.status === "skipped" && row.result_json &&
      (JSON.parse(row.result_json) as { recommendation?: string }).recommendation === "ask_user";
    if (!["failed", "blocked", "needs_attention"].includes(row.status) && !askUser) throw new AnalysisError("MAINTENANCE_NOT_RETRYABLE", 409);
    if (["writing", "metadata_sync"].includes(row.stage)) throw new AnalysisError("MAINTENANCE_INSPECTION_REQUIRED", 409);
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE analysis_jobs SET status = 'queued', stage = 'analyze', error_code = NULL,
      attempt = attempt + 1, next_retry_at = NULL, updated_at = ? WHERE id = ?`).run(now, id);
    this.wake();
    return this.listMaintenance(row.vault_id!).find((job) => job.id === id)!;
  }

  async resolveMetadataSync(id: string, confirmed: unknown): Promise<MaintenanceJob> {
    if (confirmed !== true) throw new AnalysisError("METADATA_SYNC_CONFIRMATION_REQUIRED", 422);
    const row = this.db.prepare("SELECT * FROM analysis_jobs WHERE id = ? AND mode = 'maintain'")
      .get(id) as JobRow | undefined;
    if (!row) throw new AnalysisError("MAINTENANCE_JOB_NOT_FOUND", 404);
    if (row.status !== "needs_attention" || row.stage !== "metadata_sync" || !row.result_json)
      throw new AnalysisError("MAINTENANCE_NOT_INSPECTABLE", 409);
    const result = JSON.parse(row.result_json) as {
      files?: unknown; metadataSync?: { previousStatus?: string; author?: string | null; authorship?: string };
      [key: string]: unknown };
    const sync = result.metadataSync;
    if (!sync || !["completed", "skipped"].includes(String(sync.previousStatus)) ||
      !["self", "third_party", "unknown"].includes(String(sync.authorship)) ||
      (sync.author !== null && typeof sync.author !== "string"))
      throw new AnalysisError("MAINTENANCE_INSPECTION_REQUIRED", 409);
    const vault = this.vaults?.get(row.vault_id!);
    if (!vault || !await verifiedSnapshot(vault.path, row.snapshot!, row.fingerprint!))
      throw new AnalysisError("SOURCE_CHANGED", 409);
    let entry: { author?: string | null; authorship?: string } | undefined;
    try {
      const manifest = JSON.parse(await readFile(join(vault.path, ".ocf", "ingest-manifest.json"), "utf8")) as {
        sources?: Record<string, typeof entry> };
      entry = manifest.sources?.[row.fingerprint!];
    } catch { throw new AnalysisError("SOURCE_CHANGED", 409); }
    if ((entry?.author ?? null) !== sync.author || (entry?.authorship ?? "unknown") !== sync.authorship)
      throw new AnalysisError("SOURCE_METADATA_CHANGED", 409);
    if (sync.previousStatus === "completed" && (!Array.isArray(result.files) || result.files.length === 0))
      throw new AnalysisError("MAINTENANCE_INSPECTION_REQUIRED", 409);
    const files = Array.isArray(result.files) ? result.files : [];
    if (files.length > 14 || files.some((file) => typeof file !== "string"))
      throw new AnalysisError("MAINTENANCE_INSPECTION_REQUIRED", 409);
    const checker = require(join(this.vaults!.maintainerRoot, "scripts", "check-notes.js")) as {
      checkNotes(input: { vault: string; note: string }): { issues: unknown[] } };
    try {
      for (const file of files as string[]) {
        if (checker.checkNotes({ vault: vault.path, note: file }).issues.length)
          throw new AnalysisError("SOURCE_METADATA_NOT_SYNCED", 409);
      }
    } catch (error) {
      if (error instanceof AnalysisError) throw error;
      throw new AnalysisError("SOURCE_METADATA_NOT_SYNCED", 409);
    }
    let latestEntry: { author?: string | null; authorship?: string } | undefined;
    try {
      const latestManifest = JSON.parse(await readFile(join(vault.path, ".ocf", "ingest-manifest.json"), "utf8")) as {
        sources?: Record<string, typeof latestEntry> };
      latestEntry = latestManifest.sources?.[row.fingerprint!];
    } catch { throw new AnalysisError("SOURCE_CHANGED", 409); }
    if ((latestEntry?.author ?? null) !== sync.author ||
      (latestEntry?.authorship ?? "unknown") !== sync.authorship)
      throw new AnalysisError("SOURCE_METADATA_CHANGED", 409);
    const now = new Date().toISOString();
    this.db.transaction(() => {
      const current = this.db.prepare("SELECT status, stage, result_json FROM analysis_jobs WHERE id = ?")
        .get(id) as { status: string; stage: string; result_json: string | null };
      if (current.status !== "needs_attention" || current.stage !== "metadata_sync" ||
        current.result_json !== row.result_json)
        throw new AnalysisError("SOURCE_METADATA_CHANGED", 409);
      const cardRow = this.db.prepare("SELECT card_json FROM source_analyses WHERE vault_id = ? AND fingerprint = ?")
        .get(row.vault_id, row.fingerprint) as { card_json: string } | undefined;
      if (cardRow) {
        const card = JSON.parse(cardRow.card_json) as Record<string, unknown>;
        this.db.prepare(`UPDATE source_analyses SET card_json = ?, status = 'confirmed', updated_at = ?
          WHERE vault_id = ? AND fingerprint = ?`).run(JSON.stringify({ ...card, author: sync.author,
            authorship: sync.authorship }), now, row.vault_id, row.fingerprint);
      }
      this.db.prepare(`UPDATE analysis_jobs SET status = ?, stage = 'complete', error_code = NULL,
        result_json = ?, updated_at = ? WHERE id = ?`).run(sync.previousStatus,
        JSON.stringify({ ...result, metadataSync: { ...sync, resolvedAt: now, confirmedByUser: true } }), now, id);
    })();
    return this.listMaintenance(row.vault_id!).find((job) => job.id === id)!;
  }

  resolveAskUser(id: string, decision: unknown): MaintenanceJob {
    if (decision !== "keep_raw_only") throw new AnalysisError("INVALID_MAINTENANCE_DECISION", 422);
    const row = this.db.prepare("SELECT * FROM analysis_jobs WHERE id = ? AND mode = 'maintain'")
      .get(id) as JobRow | undefined;
    if (!row) throw new AnalysisError("MAINTENANCE_JOB_NOT_FOUND", 404);
    const result = row.result_json ? JSON.parse(row.result_json) as Record<string, unknown> : null;
    if (row.status !== "needs_attention" || result?.recommendation !== "ask_user")
      throw new AnalysisError("MAINTENANCE_NOT_RESOLVABLE", 409);
    const now = new Date().toISOString();
    const resolved = { ...result, recommendation: "keep_raw_only", userDecision: "keep_raw_only", resolvedAt: now };
    this.db.transaction(() => {
      this.db.prepare(`UPDATE analysis_jobs SET status = 'skipped', stage = 'complete', error_code = NULL,
        result_json = ?, updated_at = ? WHERE id = ? AND status = 'needs_attention'`)
        .run(JSON.stringify(resolved), now, id);
      const cardRow = this.db.prepare("SELECT card_json FROM source_analyses WHERE vault_id = ? AND fingerprint = ?")
        .get(row.vault_id, row.fingerprint) as { card_json: string } | undefined;
      if (cardRow) this.db.prepare(`UPDATE source_analyses SET card_json = ?, updated_at = ?
        WHERE vault_id = ? AND fingerprint = ?`).run(JSON.stringify({ ...JSON.parse(cardRow.card_json) as object,
          recommendation: "keep_raw_only" }), now, row.vault_id, row.fingerprint);
    })();
    return this.listMaintenance(row.vault_id!).find((job) => job.id === id)!;
  }

  async inspectMaintenance(id: string): Promise<MaintenanceJob> {
    const row = this.db.prepare("SELECT * FROM analysis_jobs WHERE id = ? AND mode = 'maintain'")
      .get(id) as JobRow | undefined;
    if (!row) throw new AnalysisError("MAINTENANCE_JOB_NOT_FOUND", 404);
    if (row.status !== "needs_attention" || row.stage !== "writing" || processAlive(row.child_pid))
      throw new AnalysisError("MAINTENANCE_INSPECTION_REQUIRED", 409);
    let pending: PendingWrite | null = null;
    try { pending = row.result_json ? JSON.parse(row.result_json) as PendingWrite : null; }
    catch { pending = null; }
    const vault = this.vaults?.get(row.vault_id!);
    if (!vault || !pending?.pending || !pending.card ||
      !["compile_now", "defer", "keep_raw_only", "ask_user"].includes(String(pending.recommendation)))
      throw new AnalysisError("MAINTENANCE_INSPECTION_REQUIRED", 409);
    if (!await this.metadataMatches(vault.path, row.fingerprint!, pending))
      throw new AnalysisError("SOURCE_METADATA_CHANGED", 409);
    const recovered = await reconcileMaintenanceWrite(vault, row.fingerprint!, row.snapshot!);
    if (recovered) this.finishRecoveredWrite(row, pending, recovered);
    else if (await reconcileRolledBackWrite(vault, row.fingerprint!, row.snapshot!)) {
      const now = new Date().toISOString();
      const updated = this.db.prepare(`UPDATE analysis_jobs SET status = 'queued', stage = 'analyze',
        error_code = NULL, result_json = NULL, attempt = attempt + 1, next_retry_at = NULL,
        child_pid = NULL, run_token = NULL, stage_deadline_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'needs_attention' AND stage = 'writing' AND result_json = ?`)
        .run(now, id, row.result_json);
      if (updated.changes !== 1) throw new AnalysisError("MAINTENANCE_INSPECTION_REQUIRED", 409);
      this.wake();
    } else throw new AnalysisError("MAINTENANCE_INSPECTION_REQUIRED", 409);
    return this.listMaintenance(row.vault_id!).find((job) => job.id === id)!;
  }

  private async metadataMatches(vaultPath: string, fingerprint: string, pending: PendingWrite): Promise<boolean> {
    try {
      const manifest = JSON.parse(await readFile(join(vaultPath, ".ocf", "ingest-manifest.json"), "utf8")) as {
        sources?: Record<string, { authorship?: string; author?: string | null }> };
      const entry = manifest.sources?.[fingerprint];
      return !!entry && (entry.authorship ?? "unknown") === pending.authorship &&
        (entry.author ?? null) === (pending.author ?? null);
    } catch { return false; }
  }

  private finishRecoveredWrite(row: JobRow, pending: PendingWrite, recovered: { files: string[] }): void {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      const card = { vaultId: row.vault_id, snapshot: row.snapshot, fingerprint: row.fingerprint,
        status: "confirmed", authorship: pending.authorship, author: pending.author,
        ...pending.card, recommendation: pending.recommendation };
      this.db.prepare(`INSERT INTO source_analyses (vault_id,fingerprint,snapshot,status,card_json,updated_at)
        VALUES (?,?,?,'confirmed',?,?) ON CONFLICT(vault_id,fingerprint) DO UPDATE SET
        snapshot=excluded.snapshot,status=excluded.status,card_json=excluded.card_json,
        updated_at=excluded.updated_at`).run(row.vault_id, row.fingerprint, row.snapshot, JSON.stringify(card), now);
      const status = pending.recommendation === "compile_now" ? "completed" :
        pending.recommendation === "ask_user" ? "needs_attention" : "skipped";
      this.db.prepare(`UPDATE analysis_jobs SET status = ?, stage = 'complete', error_code = NULL,
        result_json = ?, run_token = NULL, child_pid = NULL, stage_deadline_at = NULL, updated_at = ?
        WHERE id = ?`).run(status, JSON.stringify({ recommendation: pending.recommendation,
          files: recovered.files, warnings: [], recovered: true }), now, row.id);
    })();
    try { this.knowledge?.refresh(row.vault_id!); } catch { /* Later read refreshes the index. */ }
  }

  cancelMaintenance(id: string): MaintenanceJob {
    const row = this.db.prepare("SELECT * FROM analysis_jobs WHERE id = ? AND mode = 'maintain'")
      .get(id) as JobRow | undefined;
    if (!row) throw new AnalysisError("MAINTENANCE_JOB_NOT_FOUND", 404);
    if (["queued", "retry_wait", "blocked"].includes(row.status)) {
      this.db.prepare(`UPDATE analysis_jobs SET status = 'cancelled', stage = 'cancelled',
        next_retry_at = NULL, updated_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
      this.schedule();
      return this.listMaintenance(row.vault_id!).find((job) => job.id === id)!;
    }
    if (row.status !== "running" || row.stage === "writing" || this.activeId !== id || !this.activeAbort)
      throw new AnalysisError("MAINTENANCE_NOT_CANCELLABLE", 409);
    this.cancelRequested.add(id);
    this.activeAbort.abort();
    return this.listMaintenance(row.vault_id!).find((job) => job.id === id)!;
  }

  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.laneState().pausedReason) throw new AnalysisError("AGENT_LANE_PAUSED", 503);
    const run = () => {
      if (this.laneState().pausedReason) throw new AnalysisError("AGENT_LANE_PAUSED", 503);
      return fn();
    };
    const next = this.serialTail.then(run, run);
    this.serialTail = next.catch(() => undefined);
    return next;
  }

  runMetadataCorrection<T>(fn: () => Promise<T>): Promise<T> {
    this.metadataCorrectionsPending++;
    const next = this.serialTail.then(fn, fn);
    this.serialTail = next.catch(() => undefined);
    return next.finally(() => {
      this.metadataCorrectionsPending--;
      this.schedule();
    });
  }

  wake(): void { this.schedule(); }

  laneState(): { pausedReason: string | null } {
    const row = this.db.prepare("SELECT paused_reason FROM analysis_lane_state WHERE id = 1").get() as { paused_reason: string | null };
    return { pausedReason: row.paused_reason };
  }

  resumeLane(): { pausedReason: null } {
    const uncertain = this.db.prepare(`SELECT child_pid FROM analysis_jobs
      WHERE mode = 'maintain' AND child_pid IS NOT NULL AND status IN ('running','blocked','needs_attention')`)
      .all() as { child_pid: number }[];
    if (uncertain.some((row) => processAlive(row.child_pid)))
      throw new AnalysisError("AGENT_PROCESS_STILL_RUNNING", 409);
    this.db.transaction(() => {
      this.db.prepare("UPDATE analysis_lane_state SET paused_reason = NULL, updated_at = ? WHERE id = 1")
        .run(new Date().toISOString());
      this.db.prepare(`UPDATE analysis_jobs SET status = 'queued', error_code = NULL, updated_at = ?
        WHERE status = 'blocked' AND error_code IN ('AGENT_UNAVAILABLE','AGENT_AUTH_REQUIRED','AGENT_EXIT_UNCONFIRMED')`)
        .run(new Date().toISOString());
      this.db.prepare("UPDATE analysis_jobs SET child_pid = NULL WHERE status = 'queued'").run();
    })();
    this.wake();
    return { pausedReason: null };
  }

  enqueue(input: unknown): AnalysisJob[] {
    if (!Array.isArray(input) || input.length < 1 || input.length > 100) {
      throw new AnalysisError("INVALID_ANALYSIS_JOB", 422);
    }
    const unique = new Set<string>();
    const items: { batchId: string; captureId: string }[] = [];
    for (const item of input) {
      if (!item || typeof item.batchId !== "string" || typeof item.captureId !== "string" ||
        !item.batchId || !item.captureId || item.batchId.length > 100 || item.captureId.length > 300) {
        throw new AnalysisError("INVALID_ANALYSIS_JOB", 422);
      }
      const key = `${item.batchId}\u0000${item.captureId}`;
      if (unique.has(key)) continue;
      unique.add(key);
      items.push({ batchId: item.batchId, captureId: item.captureId });
    }
    const jobs = this.db.transaction(() => items.map(({ batchId, captureId }) => {
      const source = this.db.prepare(`SELECT disposition FROM import_items WHERE batch_id = ? AND capture_id = ?`)
        .get(batchId, captureId) as { disposition: string } | undefined;
      if (!source || source.disposition === "trashed") throw new AnalysisError("SOURCE_NOT_FOUND", 404);
      const existing = this.db.prepare(`SELECT * FROM analysis_jobs
        WHERE batch_id = ? AND capture_id = ? AND mode = 'analysis_only' AND status IN ('queued', 'running') ORDER BY rowid DESC LIMIT 1`)
        .get(batchId, captureId) as JobRow | undefined;
      if (existing) return jobOf(existing);
      const id = randomUUID();
      const now = new Date().toISOString();
      this.db.prepare(`INSERT INTO analysis_jobs
        (id, batch_id, capture_id, status, error_code, created_at, updated_at)
        VALUES (?, ?, ?, 'queued', NULL, ?, ?)`).run(id, batchId, captureId, now, now);
      return { id, batchId, captureId, status: "queued" as const, errorCode: null, createdAt: now, updatedAt: now };
    }))();
    this.schedule();
    return jobs;
  }

  async resume(): Promise<void> {
    const now = new Date().toISOString();
    const writing = this.db.prepare(`SELECT * FROM analysis_jobs
      WHERE status = 'running' AND mode = 'maintain' AND stage = 'writing'`).all() as JobRow[];
    for (const row of writing) {
      if (processAlive(row.child_pid)) {
        this.db.prepare(`UPDATE analysis_jobs SET status = 'needs_attention', error_code = 'AGENT_PROCESS_STILL_RUNNING',
          updated_at = ? WHERE id = ?`).run(now, row.id);
        this.db.prepare("UPDATE analysis_lane_state SET paused_reason = ?, updated_at = ? WHERE id = 1")
          .run("AGENT_PROCESS_STILL_RUNNING", now);
        continue;
      }
      let recovered: { files: string[] } | null = null;
      let pending: PendingWrite | null = null;
      try { pending = row.result_json ? JSON.parse(row.result_json) as PendingWrite : null; }
      catch { pending = null; }
      const vault = this.vaults?.get(row.vault_id!);
      const metadataMatches = vault && pending?.pending && pending.card &&
        ["compile_now", "defer", "keep_raw_only", "ask_user"].includes(String(pending.recommendation)) &&
        await this.metadataMatches(vault.path, row.fingerprint!, pending);
      if (vault && metadataMatches) {
        recovered = await reconcileMaintenanceWrite(vault, row.fingerprint!, row.snapshot!);
      }
      if (!recovered || !pending) {
        this.db.prepare(`UPDATE analysis_jobs SET status = 'needs_attention', error_code = ?,
          updated_at = ? WHERE id = ?`).run(vault && pending?.pending && pending.card && !metadataMatches ?
          "SOURCE_METADATA_CHANGED" : "INTERRUPTED_WRITE", now, row.id);
        continue;
      }
      this.finishRecoveredWrite(row, pending, recovered);
    }
    const running = this.db.prepare("SELECT id, child_pid FROM analysis_jobs WHERE status = 'running' AND mode = 'maintain'")
      .all() as { id: string; child_pid: number | null }[];
    for (const row of running) {
      if (processAlive(row.child_pid)) {
        this.db.prepare(`UPDATE analysis_jobs SET status = 'needs_attention', error_code = 'AGENT_PROCESS_STILL_RUNNING',
          updated_at = ? WHERE id = ?`).run(now, row.id);
        this.db.prepare("UPDATE analysis_lane_state SET paused_reason = ?, updated_at = ? WHERE id = 1")
          .run("AGENT_PROCESS_STILL_RUNNING", now);
      } else this.db.prepare(`UPDATE analysis_jobs SET status = 'queued', child_pid = NULL, updated_at = ?
        WHERE id = ?`).run(now, row.id);
    }
    this.db.prepare("UPDATE analysis_jobs SET status = 'queued', updated_at = ? WHERE status = 'running'").run(now);
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped || this.active || this.metadataCorrectionsPending) return;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    queueMicrotask(() => this.startNext());
  }

  private startNext(): void {
    if (this.stopped || this.active || this.metadataCorrectionsPending) return;
    if (this.laneState().pausedReason) return;
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE analysis_jobs SET status = 'queued', attempt = attempt + 1,
      next_retry_at = NULL, updated_at = ? WHERE status = 'retry_wait' AND next_retry_at <= ?`).run(now, now);
    const row = this.db.prepare("SELECT * FROM analysis_jobs WHERE status = 'queued' ORDER BY rowid LIMIT 1")
      .get() as JobRow | undefined;
    if (!row) {
      const next = this.db.prepare("SELECT MIN(next_retry_at) AS due FROM analysis_jobs WHERE status = 'retry_wait'")
        .get() as { due: string | null };
      if (next.due) this.retryTimer = setTimeout(() => { this.retryTimer = null; this.schedule(); },
        Math.max(1, new Date(next.due).getTime() - Date.now()));
      return;
    }
    const token = randomUUID();
    const deadline = new Date(Date.now() + 600_000).toISOString();
    const claim = this.db.prepare(`UPDATE analysis_jobs SET status = 'running', run_token = ?,
      started_at = ?, stage_deadline_at = ?, heartbeat_at = ?, updated_at = ?
      WHERE id = ? AND status = 'queued'`).run(token, now, deadline, now, now, row.id);
    if (claim.changes !== 1) { this.schedule(); return; }
    const controller = new AbortController();
    this.activeAbort = controller;
    this.activeId = row.id;
    const task = this.runExclusive(() => this.execute(row, controller.signal, token));
    this.active = task;
    void task.finally(() => { this.active = null; this.activeAbort = null; this.activeId = null; this.schedule(); });
  }

  private async execute(job: JobRow, signal: AbortSignal, token: string): Promise<void> {
    try {
      const item = this.db.prepare("SELECT status FROM import_items WHERE batch_id = ? AND capture_id = ?")
        .get(job.batch_id, job.capture_id) as { status: string } | undefined;
      if (!item) throw new AnalysisError("SOURCE_NOT_FOUND", 404);
      if (job.mode === "analysis_only") {
        await this.analysis.proposeCapture(job.batch_id, job.capture_id, "claude-current");
        this.db.prepare(`UPDATE analysis_jobs SET status = 'completed', error_code = NULL, run_token = NULL,
          child_pid = NULL, updated_at = ? WHERE id = ? AND run_token = ?`)
          .run(new Date().toISOString(), job.id, token);
      } else {
        if (!this.compiler || !this.vaults) throw new AnalysisError("AGENT_UNAVAILABLE", 503);
        const vault = this.vaults.get(job.vault_id!);
        if (!vault) throw new AnalysisError("VAULT_NOT_FOUND", 404);
        const result = await this.compiler.propose({ vaultId: job.vault_id!, snapshot: job.snapshot!,
          fingerprint: job.fingerprint! }, (stage) => {
          const at = new Date().toISOString();
          this.db.prepare(`UPDATE analysis_jobs SET stage = ?, stage_deadline_at = ?, heartbeat_at = ?, updated_at = ?
            WHERE id = ? AND run_token = ?`).run(stage, new Date(Date.now() + 600_000).toISOString(), at,
            at, job.id, token);
        }, signal, (pid) => {
          this.db.prepare("UPDATE analysis_jobs SET child_pid = ?, heartbeat_at = ? WHERE id = ? AND run_token = ?")
            .run(pid, new Date().toISOString(), job.id, token);
        });
        if (signal.aborted) throw new Error("AGENT_CANCELLED");
        const pending = { pending: true, recommendation: result.recommendation, authorship: result.authorship,
          author: result.author, card: result.card };
        this.db.prepare(`UPDATE analysis_jobs SET stage = 'writing', result_json = ?, child_pid = NULL,
          stage_deadline_at = ?, updated_at = ? WHERE id = ? AND run_token = ?`)
          .run(JSON.stringify(pending), new Date(Date.now() + 600_000).toISOString(),
            new Date().toISOString(), job.id, token);
        const applied = await applyMaintenanceChanges(vault, job.fingerprint!, job.snapshot!,
          result.changes, this.vaults.maintainerRoot, result);
        try { this.knowledge?.refresh(job.vault_id!); }
        catch { applied.warnings.push("KNOWLEDGE_INDEX_REFRESH_FAILED"); }
        const status = result.recommendation === "compile_now" ? "completed" :
          result.recommendation === "ask_user" ? "needs_attention" : "skipped";
        const card = { vaultId: job.vault_id, snapshot: job.snapshot, fingerprint: job.fingerprint, status: "confirmed",
          authorship: result.authorship, author: result.author, ...result.card, recommendation: result.recommendation };
        this.db.prepare(`INSERT INTO source_analyses (vault_id, fingerprint, snapshot, status, card_json, updated_at)
          VALUES (?, ?, ?, 'confirmed', ?, ?) ON CONFLICT(vault_id, fingerprint) DO UPDATE SET
          snapshot=excluded.snapshot, status=excluded.status, card_json=excluded.card_json, updated_at=excluded.updated_at`)
          .run(job.vault_id, job.fingerprint, job.snapshot, JSON.stringify(card), new Date().toISOString());
        this.db.prepare(`UPDATE analysis_jobs SET status = ?, stage = 'complete', error_code = NULL,
          result_json = ?, run_token = NULL, child_pid = NULL, stage_deadline_at = NULL, updated_at = ?
          WHERE id = ? AND run_token = ?`).run(status, JSON.stringify({ recommendation: result.recommendation,
            files: applied.files, warnings: applied.warnings }), new Date().toISOString(), job.id, token);
      }
    } catch (error) {
      const code = errorCode(error);
      const current = this.db.prepare("SELECT stage FROM analysis_jobs WHERE id = ?").get(job.id) as { stage: string } | undefined;
      const uncertain = code === "PARTIAL_WRITE" || (job.mode === "maintain" && current?.stage === "writing");
      const unavailable = code === "AGENT_UNAVAILABLE" || code === "AGENT_AUTH_REQUIRED" || code === "AGENT_EXIT_UNCONFIRMED";
      const cancelledForStop = this.stopped && code === "AGENT_CANCELLED" && current?.stage !== "writing";
      const cancelledByUser = this.cancelRequested.delete(job.id) && code === "AGENT_CANCELLED" &&
        current?.stage !== "writing";
      const retryable = !uncertain && !unavailable && job.mode === "maintain" && job.attempt <= 2 &&
        ["AGENT_TIMEOUT", "AGENT_RUN_FAILED", "AGENT_RESPONSE_INVALID", "MAINTENANCE_RESPONSE_INVALID",
          "MAINTENANCE_PLAN_INVALID", "MAINTENANCE_DRAFT_INVALID"].includes(code);
      const status = cancelledByUser ? "cancelled" : cancelledForStop ? "queued" :
        uncertain ? "needs_attention" : unavailable ? "blocked" : retryable ? "retry_wait" : "needs_attention";
      const nextRetry = retryable ? new Date(Date.now() + (job.attempt === 1 ? 60_000 : 600_000)).toISOString() : null;
      this.db.prepare(`UPDATE analysis_jobs SET status = ?, stage = CASE WHEN ? THEN 'cancelled' ELSE stage END,
        error_code = ?, next_retry_at = ?, run_token = NULL,
        child_pid = CASE WHEN ? = 'AGENT_EXIT_UNCONFIRMED' THEN child_pid ELSE NULL END,
        stage_deadline_at = NULL, updated_at = ? WHERE id = ? AND run_token = ?`)
        .run(status, cancelledByUser ? 1 : 0, cancelledByUser ? null : code, nextRetry, code,
          new Date().toISOString(), job.id, token);
      if (unavailable) this.db.prepare("UPDATE analysis_lane_state SET paused_reason = ?, updated_at = ? WHERE id = 1")
        .run(code, new Date().toISOString());
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.activeAbort?.abort();
    await this.active;
  }
}
