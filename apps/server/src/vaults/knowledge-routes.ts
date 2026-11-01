import type { FastifyInstance } from "fastify";
import { closeSync, createReadStream } from "node:fs";
import { basename } from "node:path";
import { KnowledgeError, KnowledgeIndex } from "./knowledge-index.js";
import { VaultError, VaultRegistry } from "./registry.js";

function fail(error: unknown, reply: { code: (status: number) => { send: (body: unknown) => unknown } }) {
  if (error instanceof KnowledgeError || error instanceof VaultError) return reply.code(error.status).send({ error: error.code });
  throw error;
}

export function registerKnowledgeRoutes(app: FastifyInstance, index: KnowledgeIndex, registry: VaultRegistry) {
  app.get<{ Querystring: { vaultId?: string; limit?: string } }>("/api/v1/knowledge/overview", (request, reply) => {
    const limit = Number(request.query.limit ?? 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) return reply.code(422).send({ error: "INVALID_KNOWLEDGE_QUERY" });
    try { return index.overview(request.query.vaultId, limit); } catch (error) { return fail(error, reply); }
  });
  app.get<{ Querystring: { vaultId?: string } }>("/api/v1/knowledge/folders", (request, reply) => {
    try { return { items: index.folders(request.query.vaultId) }; } catch (error) { return fail(error, reply); }
  });
  app.get<{ Querystring: { vaultId?: string; vaultIds?: string; q?: string; kind?: string; folder?: string; analysisStatus?: string; modifiedSince?: string; sort?: string; page?: string; pageSize?: string } }>(
    "/api/v1/knowledge/items", (request, reply) => {
      const { vaultId, q, kind, folder, analysisStatus, modifiedSince, sort } = request.query;
      const vaultIds = request.query.vaultIds?.split(",");
      const page = Number(request.query.page ?? 1);
      const pageSize = Number(request.query.pageSize ?? 30);
      if ((vaultId && vaultIds) || (vaultIds && (vaultIds.length > 20 || vaultIds.some(id => !id) || new Set(vaultIds).size !== vaultIds.length)) || !Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100 ||
        (kind && kind !== "source" && kind !== "note") || (sort && !["recent", "modified", "title"].includes(sort)) ||
        (q?.length ?? 0) > 200 || (folder?.length ?? 0) > 400 ||
        (modifiedSince && (!/^\d{4}-\d{2}-\d{2}T/.test(modifiedSince) || Number.isNaN(Date.parse(modifiedSince))))) {
        return reply.code(422).send({ error: "INVALID_KNOWLEDGE_QUERY" });
      }
      try { return index.list({ vaultId, vaultIds, q, kind: kind as "source" | "note" | undefined, folder, analysisStatus, modifiedSince, sort, page, pageSize }); }
      catch (error) { return fail(error, reply); }
    });
  app.get<{ Params: { vaultId: string }; Querystring: { path?: string } }>("/api/v1/knowledge/items/:vaultId", (request, reply) => {
    if (!request.query.path) return reply.code(422).send({ error: "INVALID_KNOWLEDGE_PATH" });
    try { return index.detail(request.params.vaultId, request.query.path); } catch (error) { return fail(error, reply); }
  });
  app.get<{ Params: { vaultId: string }; Querystring: { path?: string } }>("/api/v1/knowledge/files/:vaultId", (request, reply) => {
    if (!request.query.path) return reply.code(422).send({ error: "INVALID_KNOWLEDGE_PATH" });
    let fd: number | undefined;
    try {
      const file = index.file(request.params.vaultId, request.query.path);
      fd = file.fd;
      const name = encodeURIComponent(basename(file.path)).replace(/'/g, "%27");
      reply.header("Content-Type", file.format === "pdf" ? "application/pdf" : "application/octet-stream")
        .header("Content-Disposition", `${file.format === "pdf" ? "inline" : "attachment"}; filename*=UTF-8''${name}`)
        .header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff").header("Accept-Ranges", "bytes");
      let start = 0, end = file.size - 1;
      if (request.headers.range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
        if (match && (match[1] || match[2])) {
          start = match[1] ? Number(match[1]) : Math.max(0, file.size - Number(match[2]));
          end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
        }
        if (!match || !(match[1] || match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= file.size) {
          closeSync(fd); fd = undefined;
          return reply.code(416).header("Content-Range", `bytes */${file.size}`).send();
        }
        reply.code(206).header("Content-Range", `bytes ${start}-${end}/${file.size}`);
      }
      reply.header("Content-Length", Math.max(0, end - start + 1));
      const stream = createReadStream(file.path, { fd, autoClose: true, ...(file.size ? { start, end } : {}) });
      fd = undefined; // The stream now owns the descriptor, including error/disconnect cleanup.
      return reply.send(stream);
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      return fail(error, reply);
    }
  });
  app.get<{ Params: { vaultId: string }; Querystring: { q?: string; kind?: string; focus?: string; limit?: string } }>(
    "/api/v1/knowledge/graph/:vaultId", (request, reply) => {
      const limit = Number(request.query.limit ?? 300);
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
