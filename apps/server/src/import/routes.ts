import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { getBatch, insertBatch } from "../state/db.js";
import type { VaultRegistry } from "../vaults/registry.js";
import { ImportError } from "./clipper-zip.js";
import { parseImportUpload } from "./local-files.js";
import type { FilingJobs } from "./filing-jobs.js";
import type { AnalysisJobs } from "../analysis/jobs.js";
import { ProvenanceError, correctFiledMetadata } from "./provenance.js";

type SourceIdentity = { batchId: string; captureId: string };

export function registerImportRoutes(app: FastifyInstance, db: Database.Database, vaults: VaultRegistry,
  jobs: FilingJobs, analysisJobs: AnalysisJobs): void {
  app.post("/api/v1/imports/preflight", async (request, reply) => {
    try {
      const file = await request.file();
      if (!file || file.fieldname !== "file") {
        return reply.code(400).send({ error: "FILE_REQUIRED" });
      }
      const bytes = await file.toBuffer();
      const { candidates, skippedFiles } = parseImportUpload(bytes, file.filename);
      const batch = { batchId: randomUUID(), createdAt: new Date().toISOString(), candidates };
      const policy = db.prepare("SELECT mode, vault_id, default_authorship FROM import_policy WHERE id = 1")
        .get() as { mode: string; vault_id: string | null; default_authorship: "self" | "third_party" | "unknown" };
      const override = request.headers["x-ocf-authorship"];
      if (override !== undefined && !["self", "third_party", "unknown"].includes(String(override))) {
        return reply.code(422).send({ error: "INVALID_AUTHORSHIP" });
      }
      insertBatch(db, { ...batch, autoVaultId: policy.mode === "auto-file" ? policy.vault_id : null,
        defaultAuthorship: override as "self" | "third_party" | "unknown" | undefined ?? policy.default_authorship });
      if (policy.mode === "auto-file" && policy.vault_id) {
        for (const candidate of candidates) if (candidate.status === "ready") jobs.enqueue(batch.batchId, candidate.id, policy.vault_id);
      }
      return reply.code(201).send({ ...getBatch(db, batch.batchId), skippedFiles });
    } catch (error) {
      if (error instanceof ImportError) {
        const status = ["ARCHIVE_TOO_LARGE", "MANIFEST_TOO_LARGE", "TEXT_TOO_LARGE", "TOO_MANY_FILES"].includes(error.code) ? 413 : 422;
        return reply.code(status).send({ error: error.code });
      }
      if (typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 413) {
        return reply.code(413).send({ error: "ARCHIVE_TOO_LARGE" });
      }
      throw error;
    }
  });

  app.get("/api/v1/imports/policy", async () => {
    const row = db.prepare("SELECT mode, vault_id, default_authorship FROM import_policy WHERE id = 1")
      .get() as { mode: string; vault_id: string | null; default_authorship: string };
    return { mode: row.mode, vaultId: row.vault_id, defaultAuthorship: row.default_authorship };
  });

  app.put<{ Body: { mode?: unknown; vaultId?: unknown; defaultAuthorship?: unknown } }>("/api/v1/imports/policy", async (request, reply) => {
    const { mode, vaultId, defaultAuthorship } = request.body ?? {};
    if (mode !== "manual" && mode !== "auto-file") return reply.code(422).send({ error: "INVALID_IMPORT_POLICY" });
    if (mode === "auto-file" && (typeof vaultId !== "string" || !vaults.get(vaultId))) {
      return reply.code(422).send({ error: "VAULT_REQUIRED" });
    }
    const current = db.prepare("SELECT default_authorship FROM import_policy WHERE id = 1").get() as { default_authorship: string };
    const authorship = defaultAuthorship ?? current.default_authorship;
    if (!["self", "third_party", "unknown"].includes(String(authorship))) return reply.code(422).send({ error: "INVALID_AUTHORSHIP" });
    db.prepare("UPDATE import_policy SET mode = ?, vault_id = ?, default_authorship = ? WHERE id = 1")
      .run(mode, mode === "auto-file" ? vaultId : null, authorship);
    return { mode, vaultId: mode === "auto-file" ? vaultId : null, defaultAuthorship: authorship };
  });

  app.patch<{ Params: { batchId: string; captureId: string }; Body: unknown }>(
    "/api/v1/imports/:batchId/items/:captureId/metadata", async (request, reply) => {
      try { return await analysisJobs.runMetadataCorrection(() =>
        correctFiledMetadata(db, vaults, request.params.batchId, request.params.captureId, request.body)); }
      catch (error) {
        if (error instanceof ProvenanceError) return reply.code(error.status).send({ error: error.code });
        throw error;
      }
    });

  app.get<{ Querystring: { view?: string; page?: string; pageSize?: string; q?: string; status?: string; vaultId?: string; analysis?: string } }>(
    "/api/v1/imports/items", async (request, reply) => {
      const { view = "pending", q = "", status, vaultId, analysis } = request.query;
      const page = Number(request.query.page ?? 1);
      const pageSize = Number(request.query.pageSize ?? 20);
      if (typeof view !== "string" || typeof q !== "string" || q.length > 500 ||
        (status !== undefined && (typeof status !== "string" || !["ready", "processing", "incomplete", "failed", "imported"].includes(status))) ||
        (vaultId !== undefined && typeof vaultId !== "string") ||
        (analysis !== undefined && (typeof analysis !== "string" || !["none", "analyzed", "proposed", "confirmed"].includes(analysis))) ||
        !["pending", "recent", "all", "trash"].includes(view) || !Number.isInteger(page) || page < 1 ||
        !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
        return reply.code(422).send({ error: "INVALID_LIST_QUERY" });
      }
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (view === "pending") conditions.push(`i.disposition = 'active' AND i.status != 'imported'
        AND NOT EXISTS (SELECT 1 FROM import_item_vaults linked
          WHERE linked.batch_id = i.batch_id AND linked.capture_id = i.capture_id)`);
      if (view === "recent") {
        conditions.push(`i.disposition != 'trashed' AND i.processed_at >= ? AND
          (i.status = 'imported' OR i.disposition = 'shelved' OR EXISTS
            (SELECT 1 FROM import_item_vaults linked WHERE linked.batch_id = i.batch_id AND linked.capture_id = i.capture_id))`);
        params.push(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
      }
      if (view === "all") conditions.push("i.disposition != 'trashed'");
      if (view === "trash") conditions.push("i.disposition = 'trashed'");
      if (q.trim()) {
        conditions.push("(json_extract(i.payload_json, '$.title') LIKE ? OR json_extract(i.payload_json, '$.originalUrl') LIKE ? OR json_extract(i.payload_json, '$.sourceFilename') LIKE ?)");
        params.push(`%${q.trim()}%`, `%${q.trim()}%`, `%${q.trim()}%`);
      }
      if (status) { conditions.push("i.status = ?"); params.push(status); }
      if (vaultId) { conditions.push(`EXISTS (SELECT 1 FROM import_item_vaults membership
        WHERE membership.batch_id = i.batch_id AND membership.capture_id = i.capture_id AND membership.vault_id = ?)`); params.push(vaultId); }
      if (analysis === "none") conditions.push("ca.status IS NULL AND sa.status IS NULL");
      else if (analysis === "analyzed") conditions.push("COALESCE(ca.status, sa.status) IS NOT NULL");
      else if (analysis === "proposed" || analysis === "confirmed") {
        conditions.push("COALESCE(ca.status, sa.status) = ?"); params.push(analysis);
      }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const from = `FROM import_items i JOIN import_batches b ON b.id = i.batch_id
        LEFT JOIN capture_analyses ca ON ca.batch_id = i.batch_id AND ca.capture_id = i.capture_id
        LEFT JOIN source_analyses sa ON sa.vault_id = i.vault_id AND sa.fingerprint = i.fingerprint ${where}`;
      const total = (db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...params) as { n: number }).n;
      const rows = db.prepare(`SELECT i.batch_id, i.capture_id, i.payload_json, i.status, i.error_code,
        i.authorship, i.authorship_overridden, i.author_overridden, i.metadata_version, i.author_evidence_json,
        i.disposition, i.processed_at, i.vault_id, i.snapshot, i.fingerprint, i.analysis_sync_error, b.created_at, b.auto_vault_id,
        COALESCE(ca.status, sa.status) AS analysis_status ${from}
        ORDER BY b.rowid DESC, i.rowid DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize) as {
          batch_id: string; capture_id: string; payload_json: string; status: string; error_code: string | null;
          disposition: string; processed_at: string | null; vault_id: string | null; snapshot: string | null;
          fingerprint: string | null; analysis_sync_error: number; created_at: string; auto_vault_id: string | null; analysis_status: string | null;
          authorship: string; authorship_overridden: number; author_overridden: number; metadata_version: number;
          author_evidence_json: string | null;
        }[];
      const memberships = (rows.length ? db.prepare(`SELECT batch_id, capture_id, vault_id, snapshot, fingerprint, analysis_sync_error
        FROM import_item_vaults WHERE (batch_id, capture_id) IN (${rows.map(() => "(?, ?)").join(", ")})
        ORDER BY created_at, rowid`).all(...rows.flatMap((row) => [row.batch_id, row.capture_id])) : []) as {
          batch_id: string; capture_id: string; vault_id: string; snapshot: string; fingerprint: string; analysis_sync_error: number }[];
      const byItem = new Map<string, typeof memberships>();
      for (const membership of memberships) {
        const key = `${membership.batch_id}\u0000${membership.capture_id}`;
        const current = byItem.get(key) ?? [];
        current.push(membership);
        byItem.set(key, current);
      }
      const recentCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const counts = {
        pending: (db.prepare(`SELECT COUNT(*) AS n FROM import_items i WHERE disposition = 'active' AND status != 'imported'
          AND NOT EXISTS (SELECT 1 FROM import_item_vaults m WHERE m.batch_id = i.batch_id AND m.capture_id = i.capture_id)`)
          .get() as { n: number }).n,
        recent: (db.prepare(`SELECT COUNT(*) AS n FROM import_items i WHERE disposition != 'trashed' AND processed_at >= ?
          AND (status = 'imported' OR disposition = 'shelved' OR EXISTS
            (SELECT 1 FROM import_item_vaults m WHERE m.batch_id = i.batch_id AND m.capture_id = i.capture_id))`)
          .get(recentCutoff) as { n: number }).n,
        all: (db.prepare("SELECT COUNT(*) AS n FROM import_items WHERE disposition != 'trashed'").get() as { n: number }).n,
        trash: (db.prepare("SELECT COUNT(*) AS n FROM import_items WHERE disposition = 'trashed'").get() as { n: number }).n,
        autoQueued: (db.prepare(`SELECT COUNT(*) AS n FROM filing_jobs f JOIN import_batches b ON b.id = f.batch_id
          WHERE b.auto_vault_id = f.vault_id AND f.status IN ('queued','running','retry_wait')`).get() as { n: number }).n,
      };
      return { total, page, pageSize, counts, items: rows.map((row) => ({
        ...JSON.parse(row.payload_json) as object,
        authorship: row.authorship, authorshipOverridden: !!row.authorship_overridden,
        authorOverridden: !!row.author_overridden, metadataVersion: row.metadata_version,
        authorEvidence: row.author_evidence_json ? JSON.parse(row.author_evidence_json) : null,
        batchId: row.batch_id, captureId: row.capture_id, createdAt: row.created_at,
        processedAt: row.processed_at, disposition: row.disposition, status: row.status,
        errorCode: row.error_code, vaultId: row.vault_id, snapshot: row.snapshot, fingerprint: row.fingerprint,
        vaults: (byItem.get(`${row.batch_id}\u0000${row.capture_id}`) ?? []).map((membership) => ({
          vaultId: membership.vault_id, snapshot: membership.snapshot, fingerprint: membership.fingerprint,
          analysisSyncError: !!membership.analysis_sync_error })),
        analysisStatus: row.analysis_status, analysisSyncError: !!row.analysis_sync_error, autoVaultId: row.auto_vault_id,
      })) };
    },
  );

  app.post<{ Body: { action?: unknown; items?: unknown; vaultId?: unknown } }>(
    "/api/v1/imports/items/actions", async (request, reply) => {
      const { action, items, vaultId } = request.body ?? {};
      if (!["shelve", "restore", "trash", "purge", "file"].includes(String(action)) || !Array.isArray(items) ||
        items.length < 1 || items.length > 100 || items.some((item) => !item || typeof item.batchId !== "string" || typeof item.captureId !== "string")) {
        return reply.code(422).send({ error: "INVALID_IMPORT_ACTION" });
      }
      if (action === "file" && typeof vaultId !== "string") return reply.code(422).send({ error: "VAULT_REQUIRED" });
      const results: ({ batchId: string; captureId: string; ok: true; vaultId?: string; jobId?: string } |
        { batchId: string; captureId: string; ok: false; error: string })[] = [];
      for (const item of items as SourceIdentity[]) {
        if (action === "file") {
          try {
            if (!vaults.get(vaultId as string)) throw new Error("VAULT_NOT_FOUND");
            const job = jobs.enqueue(item.batchId, item.captureId, vaultId as string);
            results.push({ ...item, ok: true, vaultId: job.vaultId, jobId: job.id });
          } catch (error) {
            results.push({ ...item, ok: false, error: error instanceof Error ? error.message : "VAULT_IMPORT_FAILED" });
          }
          continue;
        }
        const row = db.prepare("SELECT status, disposition FROM import_items WHERE batch_id = ? AND capture_id = ?")
          .get(item.batchId, item.captureId) as { status: string; disposition: string } | undefined;
        if (!row) { results.push({ ...item, ok: false, error: "SOURCE_NOT_FOUND" }); continue; }
        if (row.status === "processing") { results.push({ ...item, ok: false, error: "SOURCE_BUSY" }); continue; }
        if (action === "purge") {
          if (row.disposition !== "trashed") { results.push({ ...item, ok: false, error: "INVALID_IMPORT_ACTION" }); continue; }
          db.transaction(() => {
            db.prepare("DELETE FROM capture_analyses WHERE batch_id = ? AND capture_id = ?").run(item.batchId, item.captureId);
            db.prepare("DELETE FROM import_items WHERE batch_id = ? AND capture_id = ?").run(item.batchId, item.captureId);
          })();
          results.push({ ...item, ok: true }); continue;
        }
        if (action === "shelve" && (row.status === "imported" || row.disposition === "trashed")) {
          results.push({ ...item, ok: false, error: "INVALID_IMPORT_ACTION" }); continue;
        }
        if (action === "trash" && row.status === "imported") {
          results.push({ ...item, ok: false, error: "ALREADY_IMPORTED" }); continue;
        }
        const next = action === "restore" ? "active" : action === "shelve" ? "shelved" : "trashed";
        db.transaction(() => {
          db.prepare("UPDATE import_items SET disposition = ?, processed_at = ? WHERE batch_id = ? AND capture_id = ?")
            .run(next, new Date().toISOString(), item.batchId, item.captureId);
          if (action === "shelve" || action === "trash") jobs.cancelPendingForItem(item.batchId, item.captureId);
        })();
        results.push({ ...item, ok: true });
      }
      return reply.code(action === "file" ? 202 : 200).send({ results });
    },
  );

  app.put<{ Params: { batchId: string; captureId: string }; Body: { vaultIds?: unknown } }>(
    "/api/v1/imports/:batchId/items/:captureId/vaults", async (request, reply) => {
      const { batchId, captureId } = request.params;
      const vaultIds = request.body?.vaultIds;
      if (!Array.isArray(vaultIds) || vaultIds.length > 100 ||
        vaultIds.some((id) => typeof id !== "string") || new Set(vaultIds).size !== vaultIds.length) {
        return reply.code(422).send({ error: "INVALID_VAULT_SELECTION" });
      }
      if (vaultIds.some((id) => !vaults.get(id))) return reply.code(404).send({ error: "VAULT_NOT_FOUND" });
      const source = db.prepare("SELECT status, disposition FROM import_items WHERE batch_id = ? AND capture_id = ?")
        .get(batchId, captureId) as { status: string; disposition: string } | undefined;
      if (!source) return reply.code(404).send({ error: "SOURCE_NOT_FOUND" });
      if (source.disposition === "trashed") return reply.code(409).send({ error: "SOURCE_TRASHED" });
      const before = db.prepare(`SELECT vault_id FROM import_item_vaults WHERE batch_id = ? AND capture_id = ?`)
        .all(batchId, captureId) as { vault_id: string }[];
      const current = new Set(before.map((entry) => entry.vault_id));
      if ([...current].some((vaultId) => !vaultIds.includes(vaultId))) {
        return reply.code(409).send({ error: "VAULT_ASSOCIATION_IMMUTABLE" });
      }
      const errors: { vaultId: string; error: string }[] = [];
      const pendingJobs: ReturnType<FilingJobs["enqueue"]>[] = [];
      for (const vaultId of vaultIds as string[]) {
        if (current.has(vaultId)) continue;
        try { pendingJobs.push(jobs.enqueue(batchId, captureId, vaultId)); }
        catch (error) { errors.push({ vaultId, error: error instanceof Error ? error.message : "VAULT_IMPORT_FAILED" }); }
      }
      const memberships = db.prepare(`SELECT vault_id, snapshot, fingerprint, analysis_sync_error FROM import_item_vaults
        WHERE batch_id = ? AND capture_id = ? ORDER BY created_at, rowid`).all(batchId, captureId) as {
          vault_id: string; snapshot: string; fingerprint: string; analysis_sync_error: number }[];
      return reply.code(202).send({ vaults: memberships.map((membership) => ({ vaultId: membership.vault_id,
        snapshot: membership.snapshot, fingerprint: membership.fingerprint,
        analysisSyncError: !!membership.analysis_sync_error })), jobs: pendingJobs, errors });
    },
  );

  app.get<{ Params: { batchId: string } }>("/api/v1/imports/:batchId", async (request, reply) => {
    const batch = getBatch(db, request.params.batchId);
    if (!batch) return reply.code(404).send({ error: "BATCH_NOT_FOUND" });
    return batch;
  });
}
