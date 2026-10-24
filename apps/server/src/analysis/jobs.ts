import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { AnalysisError, type AnalysisService } from "./service.js";

export interface AnalysisJob {
  id: string;
  batchId: string;
  captureId: string;
  status: "queued" | "running" | "completed" | "failed";
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

type JobRow = {
  id: string; batch_id: string; capture_id: string; status: AnalysisJob["status"];
  error_code: string | null; created_at: string; updated_at: string;
};

function jobOf(row: JobRow): AnalysisJob {
  return { id: row.id, batchId: row.batch_id, captureId: row.capture_id,
    status: row.status, errorCode: row.error_code, createdAt: row.created_at, updatedAt: row.updated_at };
}

function errorCode(error: unknown): string {
  return error instanceof AnalysisError ? error.code :
    error instanceof Error && /^AGENT_[A-Z_]+$/.test(error.message) ? error.message : "UNEXPECTED_ERROR";
}

export class AnalysisJobs {
  private active: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly db: Database.Database, private readonly analysis: AnalysisService) {
    db.exec(`CREATE TABLE IF NOT EXISTS analysis_jobs (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      capture_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
      error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (batch_id, capture_id) REFERENCES import_items(batch_id, capture_id)
    );
    CREATE INDEX IF NOT EXISTS idx_analysis_jobs_item ON analysis_jobs(batch_id, capture_id, created_at);`);
  }

  list(): AnalysisJob[] {
    const rows = this.db.prepare(`SELECT * FROM analysis_jobs
      ORDER BY CASE WHEN status IN ('queued', 'running') THEN 0 ELSE 1 END, rowid DESC LIMIT 200`)
      .all() as JobRow[];
    return rows.map(jobOf);
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
        WHERE batch_id = ? AND capture_id = ? AND status IN ('queued', 'running') ORDER BY rowid DESC LIMIT 1`)
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

  resume(): void {
    this.db.prepare("UPDATE analysis_jobs SET status = 'queued', updated_at = ? WHERE status = 'running'")
      .run(new Date().toISOString());
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped || this.active) return;
    queueMicrotask(() => this.startNext());
  }

  private startNext(): void {
    if (this.stopped || this.active) return;
    const row = this.db.prepare("SELECT * FROM analysis_jobs WHERE status = 'queued' ORDER BY rowid LIMIT 1")
      .get() as JobRow | undefined;
    if (!row) return;
    this.db.prepare("UPDATE analysis_jobs SET status = 'running', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), row.id);
    const task = this.execute(row);
    this.active = task;
    void task.finally(() => { this.active = null; this.schedule(); });
  }

  private async execute(job: JobRow): Promise<void> {
    try {
      const item = this.db.prepare("SELECT status FROM import_items WHERE batch_id = ? AND capture_id = ?")
        .get(job.batch_id, job.capture_id) as { status: string } | undefined;
      if (!item) throw new AnalysisError("SOURCE_NOT_FOUND", 404);
      await this.analysis.proposeCapture(job.batch_id, job.capture_id, "claude-current");
      this.db.prepare("UPDATE analysis_jobs SET status = 'completed', error_code = NULL, updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), job.id);
    } catch (error) {
      const code = errorCode(error);
      this.db.prepare("UPDATE analysis_jobs SET status = 'failed', error_code = ?, updated_at = ? WHERE id = ?")
        .run(code, new Date().toISOString(), job.id);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.active;
  }
}
