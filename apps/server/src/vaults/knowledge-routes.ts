import type { FastifyInstance } from "fastify";
import { KnowledgeError, KnowledgeIndex } from "./knowledge-index.js";
import { VaultError, VaultRegistry } from "./registry.js";

function fail(error: unknown, reply: { code: (status: number) => { send: (body: unknown) => unknown } }) {
  if (error instanceof KnowledgeError || error instanceof VaultError) return reply.code(error.status).send({ error: error.code });
  throw error;
}

export function registerKnowledgeRoutes(app: FastifyInstance, index: KnowledgeIndex, registry: VaultRegistry) {
  app.get<{ Querystring: { vaultId?: string } }>("/api/v1/knowledge/overview", (request, reply) => {
    try { return index.overview(request.query.vaultId); } catch (error) { return fail(error, reply); }
  });
  app.get<{ Querystring: { vaultId?: string } }>("/api/v1/knowledge/folders", (request, reply) => {
    try { return { items: index.folders(request.query.vaultId) }; } catch (error) { return fail(error, reply); }
  });
  app.get<{ Querystring: { vaultId?: string; q?: string; kind?: string; folder?: string; analysisStatus?: string; modifiedSince?: string; sort?: string; page?: string; pageSize?: string } }>(
    "/api/v1/knowledge/items", (request, reply) => {
      const { vaultId, q, kind, folder, analysisStatus, modifiedSince, sort } = request.query;
      const page = Number(request.query.page ?? 1);
      const pageSize = Number(request.query.pageSize ?? 30);
      if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100 ||
        (kind && kind !== "source" && kind !== "note") || (sort && !["recent", "modified", "title"].includes(sort)) ||
        (q?.length ?? 0) > 200 || (folder?.length ?? 0) > 400 ||
        (modifiedSince && (!/^\d{4}-\d{2}-\d{2}T/.test(modifiedSince) || Number.isNaN(Date.parse(modifiedSince))))) {
        return reply.code(422).send({ error: "INVALID_KNOWLEDGE_QUERY" });
      }
      try { return index.list({ vaultId, q, kind: kind as "source" | "note" | undefined, folder, analysisStatus, modifiedSince, sort, page, pageSize }); }
      catch (error) { return fail(error, reply); }
    });
  app.get<{ Params: { vaultId: string }; Querystring: { path?: string } }>("/api/v1/knowledge/items/:vaultId", (request, reply) => {
    if (!request.query.path) return reply.code(422).send({ error: "INVALID_KNOWLEDGE_PATH" });
    try { return index.detail(request.params.vaultId, request.query.path); } catch (error) { return fail(error, reply); }
  });
  app.get<{ Params: { vaultId: string }; Querystring: { q?: string; kind?: string; focus?: string; limit?: string } }>(
    "/api/v1/knowledge/graph/:vaultId", (request, reply) => {
      const limit = Number(request.query.limit ?? 120);
      if (!Number.isInteger(limit) || limit < 1 || limit > 300 || (request.query.kind && !["source", "note"].includes(request.query.kind)) ||
        (request.query.q?.length ?? 0) > 200) return reply.code(422).send({ error: "INVALID_KNOWLEDGE_QUERY" });
      try { return index.graph(request.params.vaultId, { q: request.query.q, kind: request.query.kind as "source" | "note" | undefined,
        focus: request.query.focus, limit }); } catch (error) { return fail(error, reply); }
    });
  app.post<{ Params: { vaultId: string } }>("/api/v1/knowledge/:vaultId/rescan", (request, reply) => {
    try { return index.refresh(request.params.vaultId); } catch (error) { return fail(error, reply); }
  });
  app.delete<{ Params: { vaultId: string } }>("/api/v1/vaults/:vaultId", (request, reply) => {
    try {
      const result = registry.disconnect(request.params.vaultId);
      index.forget(request.params.vaultId);
      return result;
    } catch (error) { return fail(error, reply); }
  });
}
