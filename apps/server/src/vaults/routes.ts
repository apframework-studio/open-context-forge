import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileCapture, FilingError } from "../import/filing.js";
import { VaultError, VaultRegistry } from "./registry.js";

function errorReply(error: unknown) {
  if (error instanceof VaultError) return { status: error.status, body: { error: error.code, ...(error.plannedChanges ? { plannedChanges: error.plannedChanges } : {}) } };
  return undefined;
}

export function registerVaultRoutes(app: FastifyInstance, db: Database.Database, registry: VaultRegistry): void {
  app.get("/api/v1/vaults", async () => registry.list());

  async function sourceIndex(vaultId: string) {
    const vault = registry.get(vaultId);
    if (!vault) throw new VaultError("VAULT_NOT_FOUND", 404);
    const manifest = JSON.parse(await readFile(join(vault.path, ".ocf", "ingest-manifest.json"), "utf8")) as {
      sources?: Record<string, { snapshot: string; imported_at?: string; authorship?: string; author?: string | null;
        origins?: { url?: string | null }[] }>;
    };
    return { vault, sources: manifest.sources ?? {} };
  }

  app.get<{ Params: { vaultId: string }; Querystring: { page?: string; pageSize?: string; q?: string } }>(
    "/api/v1/vaults/:vaultId/sources", async (request, reply) => {
      const page = Number(request.query.page ?? 1);
      const pageSize = Number(request.query.pageSize ?? 20);
      if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
        return reply.code(422).send({ error: "INVALID_LIST_QUERY" });
      }
      try {
        const { sources } = await sourceIndex(request.params.vaultId);
        const details = Object.entries(sources).map(([fingerprint, source]) => {
          const row = db.prepare(`SELECT i.payload_json FROM import_items i JOIN import_item_vaults m
            ON m.batch_id = i.batch_id AND m.capture_id = i.capture_id
            WHERE m.vault_id = ? AND m.fingerprint = ? LIMIT 1`)
            .get(request.params.vaultId, fingerprint) as { payload_json: string } | undefined;
          const candidate = row ? JSON.parse(row.payload_json) as { title?: string; originalUrl?: string } : null;
          const analysis = db.prepare("SELECT status FROM source_analyses WHERE vault_id = ? AND fingerprint = ?")
            .get(request.params.vaultId, fingerprint) as { status: string } | undefined;
          return { fingerprint, snapshot: source.snapshot, title: candidate?.title ?? source.snapshot.split("/").pop() ?? fingerprint,
            originalUrl: candidate?.originalUrl ?? source.origins?.[0]?.url ?? null,
            importedAt: source.imported_at ?? null, authorship: source.authorship ?? "unknown", author: source.author ?? null,
            analysisStatus: analysis?.status ?? null };
        }).filter((source) => !request.query.q?.trim() || `${source.title} ${source.originalUrl ?? ""}`.toLowerCase()
          .includes(request.query.q.trim().toLowerCase()))
          .sort((a, b) => (b.importedAt ?? "").localeCompare(a.importedAt ?? ""));
        return { total: details.length, page, pageSize, items: details.slice((page - 1) * pageSize, page * pageSize) };
      } catch (error) {
        const known = errorReply(error);
        if (known) return reply.code(known.status).send(known.body);
        throw error;
      }
    });

  app.get<{ Params: { vaultId: string; fingerprint: string } }>(
    "/api/v1/vaults/:vaultId/sources/:fingerprint", async (request, reply) => {
      try {
        const { vault, sources } = await sourceIndex(request.params.vaultId);
        const source = sources[request.params.fingerprint];
        if (!source || !/^[a-f0-9]{64}$/.test(request.params.fingerprint) || typeof source.snapshot !== "string" ||
          isAbsolute(source.snapshot) || source.snapshot.startsWith("..")) {
          return reply.code(404).send({ error: "SOURCE_NOT_FOUND" });
        }
        const target = resolve(vault.path, source.snapshot);
        const rel = relative(vault.path, target);
        if (!rel || rel.startsWith("..") || isAbsolute(rel)) return reply.code(404).send({ error: "SOURCE_NOT_FOUND" });
        const real = await realpath(target);
        if (!real.startsWith(`${vault.path}${sep}`)) return reply.code(404).send({ error: "SOURCE_NOT_FOUND" });
        const bytes = await readFile(real);
        if (createHash("sha256").update(bytes).digest("hex") !== request.params.fingerprint) {
          return reply.code(409).send({ error: "SOURCE_CHANGED" });
        }
        return { vaultId: request.params.vaultId, fingerprint: request.params.fingerprint,
          snapshot: source.snapshot, markdown: bytes.toString("utf8") };
      } catch (error) {
        const known = errorReply(error);
        if (known) return reply.code(known.status).send(known.body);
        throw error;
      }
    });

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
      try {
        return await fileCapture(db, registry, batchId, captureId, vaultId);
      } catch (error) {
        if (error instanceof FilingError) return reply.code(error.status).send({ error: error.code });
        throw error;
      }
    },
  );
}
