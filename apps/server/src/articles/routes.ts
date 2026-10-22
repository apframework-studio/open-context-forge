import type { FastifyInstance } from "fastify";
import { extname } from "node:path";
import { ArticleError, ArticleStore, type ArticleInput } from "./store.js";

function handle(error: unknown) {
  if (error instanceof ArticleError) return { status: error.statusCode, body: { error: error.code } };
  return undefined;
}

export function registerArticleRoutes(app: FastifyInstance, store: ArticleStore): void {
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/v1/articles/:id/asset", async (request, reply) => {
    try {
      const bytes = await store.readAsset(request.params.id, request.query.path);
      const mime: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".avif": "image/avif" };
      return reply.header("Content-Security-Policy", "default-src 'none'; sandbox")
        .type(mime[extname(request.query.path ?? "").toLowerCase()] ?? "application/octet-stream").send(bytes);
    } catch (error) {
      const result = handle(error);
      if (result) return reply.code(result.status).send(result.body);
      throw error;
    }
  });

  app.post<{ Body: ArticleInput }>("/api/v1/articles", async (request, reply) => {
    try {
      return reply.code(201).send(await store.create(request.body));
    } catch (error) {
      const result = handle(error);
      if (result) return reply.code(result.status).send(result.body);
      throw error;
    }
  });

  app.get<{ Params: { id: string } }>("/api/v1/articles/:id", async (request, reply) => {
    try { return await store.get(request.params.id); }
    catch (error) {
      const result = handle(error);
      if (result) return reply.code(result.status).send(result.body);
      throw error;
    }
  });

  app.put<{ Params: { id: string }; Body: { markdown?: unknown; expectedRevision?: unknown } }>("/api/v1/articles/:id/draft", async (request, reply) => {
    try { return await store.saveDraft(request.params.id, request.body?.markdown, request.body?.expectedRevision); }
    catch (error) {
      const result = handle(error);
      if (result) return reply.code(result.status).send(result.body);
      throw error;
    }
  });

  app.post<{ Params: { id: string }; Body: { expectedRevision?: unknown } }>("/api/v1/articles/:id/finalize", async (request, reply) => {
    try { return await store.finalize(request.params.id, request.body?.expectedRevision); }
    catch (error) {
      const result = handle(error);
      if (result) return reply.code(result.status).send(result.body);
      throw error;
    }
  });
}
