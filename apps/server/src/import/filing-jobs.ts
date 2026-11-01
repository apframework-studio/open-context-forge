import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export interface FilingJob {
  id: string;
  batchId: string;
  captureId: string;
  vaultId: string;
  status: "queued" | "running" | "retry_wait" | "completed" | "needs_attention" | "cancelled";
  stage: string;
  attempt: number;
  errorCode: string | null;
  nextRetryAt: string | null;
  startedAt: string | null;
  deadlineAt: string | null;
  result: FilingResult | null;
}

export type FilingResult = { vaultId: string; snapshot: string; fingerprint: string; duplicate: boolean; analysisSyncError: boolean };

type Row = {
  id: string; batch_id: string; capture_id: string; vault_id: string; status: FilingJob["status"];
  stage: string; attempt: number; error_code: string | null; next_retry_at: string | null;
  started_at: string | null; deadline_at: string | null; result_json: string | null;
};

function fromRow(row: Row): FilingJob {
  return { id: row.id, batchId: row.batch_id, captureId: row.capture_id, vaultId: row.vault_id,
    status: row.status, stage: row.stage, attempt: row.attempt, errorCode: row.error_code,
    nextRetryAt: row.next_retry_at, startedAt: row.started_at, deadlineAt: row.deadline_at,
    result: row.result_json ? JSON.parse(row.result_json) as FilingResult : null };
}

export class FilingJobs {
  private active: Promise<void> | null = null;
  private started = false;
  private stopped = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly db: Database.Database, private readonly importer: (job: FilingJob) => Promise<FilingResult>,
    private readonly reconciler?: (job: FilingJob) => Promise<FilingResult | "retryable" | "needs_attention">,
    private readonly canResume: () => boolean = () => true) {
    db.exec(`CREATE TABLE IF NOT EXISTS filing_jobs (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      capture_id TEXT NOT NULL,
      vault_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued','running','retry_wait','completed','needs_attention','cancelled')),
      stage TEXT NOT NULL DEFAULT 'queued',
      attempt INTEGER NOT NULL DEFAULT 0,
      run_token TEXT,
      started_at TEXT,
      deadline_at TEXT,
      next_retry_at TEXT,
      error_code TEXT,
      result_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(batch_id,capture_id,vault_id),
      FOREIGN KEY(batch_id,capture_id) REFERENCES import_items(batch_id,capture_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_filing_ready ON filing_jobs(status,next_retry_at,created_at);`);
    db.exec(`CREATE TABLE IF NOT EXISTS filing_lane_state (
      id INTEGER PRIMARY KEY CHECK (id = 1), paused_reason TEXT, updated_at TEXT NOT NULL
    );`);
    db.prepare("INSERT OR IGNORE INTO filing_lane_state (id,paused_reason,updated_at) VALUES (1,NULL,?)")
      .run(new Date().toISOString());
  }

  enqueue(batchId: string, captureId: string, vaultId: string): FilingJob {
    const source = this.db.prepare("SELECT status, disposition FROM import_items WHERE batch_id = ? AND capture_id = ?")
      .get(batchId, captureId) as { status: string; disposition: string } | undefined;
    if (!source || source.disposition === "trashed") throw new Error("SOURCE_NOT_FOUND");
    if (source.status === "incomplete") throw new Error("INCOMPLETE_SOURCE");
    const existing = this.db.prepare("SELECT * FROM filing_jobs WHERE batch_id = ? AND capture_id = ? AND vault_id = ?")
      .get(batchId, captureId, vaultId) as Row | undefined;
    if (existing) {
      if (existing.status === "cancelled") {
        this.db.prepare(`UPDATE filing_jobs SET status = 'queued', stage = 'queued', error_code = NULL,
          next_retry_at = NULL, updated_at = ? WHERE id = ? AND status = 'cancelled'`)
          .run(new Date().toISOString(), existing.id);
        this.wake();
        return this.get(existing.id)!;
      }
      return fromRow(existing);
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO filing_jobs
      (id,batch_id,capture_id,vault_id,status,stage,created_at,updated_at)
      VALUES (?,?,?,?,'queued','queued',?,?)`).run(id, batchId, captureId, vaultId, now, now);
    this.wake();
    return this.get(id)!;
  }

  get(id: string): FilingJob | null {
    const row = this.db.prepare("SELECT * FROM filing_jobs WHERE id = ?").get(id) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  list(vaultId?: string): FilingJob[] {
    const rows = this.db.prepare(`SELECT * FROM filing_jobs ${vaultId ? "WHERE vault_id = ?" : ""} ORDER BY rowid`)
      .all(...(vaultId ? [vaultId] : [])) as Row[];
    return rows.map(fromRow);
  }

  cancel(id: string): FilingJob {
    const changed = this.db.prepare(`UPDATE filing_jobs SET status = 'cancelled', stage = 'cancelled', updated_at = ?
      WHERE id = ? AND status IN ('queued','retry_wait')`).run(new Date().toISOString(), id);
    if (!changed.changes) throw new Error(this.get(id) ? "FILING_NOT_CANCELLABLE" : "FILING_JOB_NOT_FOUND");
    return this.get(id)!;
  }

  cancelPendingForItem(batchId: string, captureId: string): void {
    this.db.prepare(`UPDATE filing_jobs SET status = 'cancelled', stage = 'cancelled',
      next_retry_at = NULL, updated_at = ? WHERE batch_id = ? AND capture_id = ?
      AND status IN ('queued','retry_wait')`).run(new Date().toISOString(), batchId, captureId);
  }

  retry(id: string): FilingJob {
    if (this.get(id)?.stage === "reconcile") throw new Error("FILING_INSPECTION_REQUIRED");
    const changed = this.db.prepare(`UPDATE filing_jobs SET status = 'queued', stage = 'queued', error_code = NULL,
      next_retry_at = NULL, updated_at = ? WHERE id = ? AND status = 'needs_attention'`)
      .run(new Date().toISOString(), id);
    if (!changed.changes) throw new Error(this.get(id) ? "FILING_NOT_RETRYABLE" : "FILING_JOB_NOT_FOUND");
    this.wake();
    return this.get(id)!;
  }

  async inspect(id: string): Promise<FilingJob> {
    const job = this.get(id);
    if (!job) throw new Error("FILING_JOB_NOT_FOUND");
    if (job.status !== "needs_attention" || !this.reconciler) throw new Error("FILING_NOT_INSPECTABLE");
    let outcome: FilingResult | "retryable" | "needs_attention" = "needs_attention";
    try { outcome = await this.reconciler(job); } catch { outcome = "needs_attention"; }
    if (outcome === "retryable") this.db.prepare(`UPDATE filing_jobs SET status = 'queued', stage = 'queued',
      error_code = NULL, updated_at = ? WHERE id = ? AND status = 'needs_attention'`).run(new Date().toISOString(), id);
    else if (typeof outcome === "object") this.db.prepare(`UPDATE filing_jobs SET status = 'completed', stage = 'complete',
      error_code = NULL, result_json = ?, updated_at = ? WHERE id = ? AND status = 'needs_attention'`)
      .run(JSON.stringify(outcome), new Date().toISOString(), id);
    this.wake();
    return this.get(id)!;
  }

  laneState(): { pausedReason: string | null } {
    const row = this.db.prepare("SELECT paused_reason FROM filing_lane_state WHERE id = 1").get() as { paused_reason: string | null };
    return { pausedReason: row.paused_reason };
  }

  resumeLane(): { pausedReason: null } {
    if (!this.canResume()) throw new Error("FILING_INSPECTION_REQUIRED");
    this.db.prepare("UPDATE filing_lane_state SET paused_reason = NULL, updated_at = ? WHERE id = 1")
      .run(new Date().toISOString());
    this.wake();
    return { pausedReason: null };
  }

  async resume(): Promise<void> {
    const running = this.db.prepare("SELECT * FROM filing_jobs WHERE status = 'running' ORDER BY rowid").all() as Row[];
    for (const row of running) {
      let outcome: FilingResult | "retryable" | "needs_attention" = "needs_attention";
      try { if (this.reconciler) outcome = await this.reconciler(fromRow(row)); }
      catch { outcome = "needs_attention"; }
      const status = outcome === "retryable" ? "queued" : outcome === "needs_attention" ? "needs_attention" : "completed";
      this.db.prepare(`UPDATE filing_jobs SET status = ?, stage = ?, error_code = ?, result_json = ?,
        run_token = NULL, updated_at = ? WHERE id = ? AND status = 'running'`).run(status,
        status === "completed" ? "complete" : status === "queued" ? "queued" : "reconcile",
        status === "needs_attention" ? "RAW_WRITE_UNCERTAIN" : null,
        typeof outcome === "object" ? JSON.stringify(outcome) : null, new Date().toISOString(), row.id);
    }
    const legacy = this.db.prepare(`SELECT i.batch_id, i.capture_id, b.auto_vault_id FROM import_items i
      JOIN import_batches b ON b.id = i.batch_id WHERE b.auto_vault_id IS NOT NULL
      AND i.status = 'ready' AND i.disposition = 'active' AND i.auto_file_suppressed = 0
      AND NOT EXISTS (SELECT 1 FROM filing_jobs f WHERE f.batch_id = i.batch_id
        AND f.capture_id = i.capture_id AND f.vault_id = b.auto_vault_id)
      ORDER BY b.rowid, i.rowid`).all() as { batch_id: string; capture_id: string; auto_vault_id: string }[];
    for (const item of legacy) this.enqueue(item.batch_id, item.capture_id, item.auto_vault_id);
    this.started = true;
    this.wake();
  }

  wake(): void {
    if (this.stopped || !this.started || this.active || this.laneState().pausedReason) return;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    queueMicrotask(() => this.startNext());
  }

  private startNext(): void {
    if (this.stopped || !this.started || this.active || this.laneState().pausedReason) return;
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE filing_jobs SET status = 'queued', stage = 'queued', next_retry_at = NULL,
      updated_at = ? WHERE status = 'retry_wait' AND next_retry_at <= ?`).run(now, now);
    const row = this.db.prepare("SELECT * FROM filing_jobs WHERE status = 'queued' ORDER BY rowid LIMIT 1").get() as Row | undefined;
    if (!row) {
      const next = this.db.prepare("SELECT MIN(next_retry_at) AS due FROM filing_jobs WHERE status = 'retry_wait'")
        .get() as { due: string | null };
      if (next.due) this.retryTimer = setTimeout(() => { this.retryTimer = null; this.wake(); },
        Math.max(1, new Date(next.due).getTime() - Date.now()));
      return;
    }
    const token = randomUUID();
    const deadline = new Date(Date.now() + 60_000).toISOString();
    const claim = this.db.prepare(`UPDATE filing_jobs SET status = 'running', stage = 'writing', attempt = attempt + 1,
      run_token = ?, started_at = ?, deadline_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'`)
      .run(token, now, deadline, now, row.id);
    if (!claim.changes) { this.wake(); return; }
    const task = this.execute(fromRow({ ...row, status: "running", stage: "writing", attempt: row.attempt + 1,
      started_at: now, deadline_at: deadline }), token);
    this.active = task;
    void task.finally(() => { this.active = null; this.wake(); });
  }

  private async execute(job: FilingJob, token: string): Promise<void> {
    try {
      const result = await this.importer(job);
      this.db.prepare(`UPDATE filing_jobs SET status = 'completed', stage = 'complete', error_code = NULL,
        result_json = ?, run_token = NULL, updated_at = ? WHERE id = ? AND run_token = ?`)
        .run(JSON.stringify(result), new Date().toISOString(), job.id, token);
    } catch (error) {
      const code = error instanceof Error && /^[A-Z][A-Z_]+$/.test(error.message) ? error.message : "VAULT_IMPORT_FAILED";
      let outcome: FilingResult | "retryable" | "needs_attention" = "needs_attention";
      if (code !== "PROCESS_EXIT_UNCONFIRMED" && this.reconciler) {
        try { outcome = await this.reconciler(job); } catch { outcome = "needs_attention"; }
      }
      if (typeof outcome === "object") {
        this.db.prepare(`UPDATE filing_jobs SET status = 'completed', stage = 'complete', error_code = NULL,
          result_json = ?, run_token = NULL, updated_at = ? WHERE id = ? AND run_token = ?`)
          .run(JSON.stringify(outcome), new Date().toISOString(), job.id, token);
        return;
      }
      const retryable = outcome === "retryable" && job.attempt <= 2 &&
        ["VAULT_IMPORT_FAILED", "PROCESS_TIMEOUT", "SOURCE_BUSY"].includes(code);
      const nextRetry = retryable ? new Date(Date.now() + (job.attempt === 1 ? 60_000 : 600_000)).toISOString() : null;
      this.db.prepare(`UPDATE filing_jobs SET status = ?, stage = ?, error_code = ?, run_token = NULL,
        next_retry_at = ?, updated_at = ? WHERE id = ? AND run_token = ?`)
        .run(retryable ? "retry_wait" : "needs_attention", retryable ? "retry_wait" : "reconcile",
          code, nextRetry, new Date().toISOString(), job.id, token);
      if (code === "PROCESS_EXIT_UNCONFIRMED") this.db.prepare(`UPDATE filing_lane_state
        SET paused_reason = ?, updated_at = ? WHERE id = 1`).run(code, new Date().toISOString());
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    await this.active;
  }
}
