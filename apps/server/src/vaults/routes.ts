import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import type { CaptureCandidate } from "@ocf/contracts";
import { importSnapshot } from "./maintainer.js";
import { VaultError, VaultRegistry } from "./registry.js";

function errorReply(error: unknown) {
  if (error instanceof VaultError) return { status: error.status, body: { error: error.code, ...(error.plannedChanges ? { plannedChanges: error.plannedChanges } : {}) } };
  return undefined;
}

export function registerVaultRoutes(app: FastifyInstance, db: Database.Database, registry: VaultRegistry): void {
  app.get("/api/v1/vaults", async () => registry.list());

  app.post<{ Body: { id?: unknown; path?: unknown; adopt?: unknown } }>("/api/v1/vaults", async (request, reply) => {
    try {
      const body = request.body ?? {};
      const vault = await registry.addExternal(body.id, body.path, body.adopt);
      return reply.code(201).send(vault);
    } catch (error) {
      const result = errorReply(error);
      if (result) return reply.code(result.status).send(result.body);
      throw error;
    }
  });

  app.put<{ Body: { vaultId?: unknown } }>("/api/v1/vaults/default", async (request, reply) => {
    try {
      return registry.setDefault(request.body?.vaultId);
    } catch (error) {
      const result = errorReply(error);
      if (result) return reply.code(result.status).send(result.body);
      throw error;
    }
  });

  app.post<{ Params: { batchId: string; captureId: string }; Body: { vaultId?: unknown } }>(
    "/api/v1/imports/:batchId/items/:captureId/commit", async (request, reply) => {
      const { batchId, captureId } = request.params;
      const vaultId = request.body?.vaultId;
      if (typeof vaultId !== "string") return reply.code(422).send({ error: "VAULT_REQUIRED" });
      const vault = registry.get(vaultId);
      if (!vault) return reply.code(404).send({ error: "VAULT_NOT_FOUND" });
      const row = db.prepare(`
        SELECT payload_json, status, vault_id, snapshot, fingerprint FROM import_items
        WHERE batch_id = ? AND capture_id = ?
      `).get(batchId, captureId) as {
        payload_json: string; status: string; vault_id: string | null;
        snapshot: string | null; fingerprint: string | null;
      } | undefined;
      if (!row) return reply.code(404).send({ error: "SOURCE_NOT_FOUND" });
      if (row.status === "incomplete") return reply.code(409).send({ error: "INCOMPLETE_SOURCE" });
      if (row.status === "imported") {
        if (row.vault_id !== vaultId) return reply.code(409).send({ error: "ALREADY_IMPORTED" });
        return { vaultId, snapshot: row.snapshot, fingerprint: row.fingerprint, duplicate: true };
      }

      try {
        const candidate = JSON.parse(row.payload_json) as CaptureCandidate;
        const result = await importSnapshot(candidate, vault.path, registry.maintainerRoot);
        db.prepare(`
          UPDATE import_items SET status = 'imported', error_code = NULL, vault_id = ?, snapshot = ?, fingerprint = ?
          WHERE batch_id = ? AND capture_id = ?
        `).run(vaultId, result.snapshot, result.fingerprint, batchId, captureId);
        return { vaultId, ...result };
      } catch {
        db.prepare("UPDATE import_items SET status = 'failed', error_code = 'VAULT_IMPORT_FAILED' WHERE batch_id = ? AND capture_id = ?")
          .run(batchId, captureId);
        return reply.code(502).send({ error: "VAULT_IMPORT_FAILED" });
      }
    },
  );
}
