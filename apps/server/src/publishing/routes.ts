import type { FastifyInstance } from "fastify";
import { extname } from "node:path";
import { ArticleError } from "../articles/store.js";
import { PublicationError, PublicationStore } from "./publisher.js";
import { BlogDeploy, BlogDeployError } from "./blog-deploy.js";

function respond(error: unknown) {
  if (error instanceof PublicationError || error instanceof ArticleError || error instanceof BlogDeployError) {
    return { status: error.statusCode, body: { error: error.code } };
  }
  return undefined;
}

export function registerPublicationRoutes(app: FastifyInstance, store: PublicationStore, deploy: BlogDeploy): void {
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/v1/publications/:id/asset", async (request, reply) => {
    try {
      const path = request.query.path;
      const bytes = await store.readAsset(request.params.id, path);
      const mime: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".avif": "image/avif" };
      return reply.header("Content-Security-Policy", "default-src 'none'; sandbox")
        .type(mime[extname(path ?? "").toLowerCase()] ?? "application/octet-stream").send(bytes);
    } catch (error) {
      const result = respond(error);
      if (result) return reply.code(result.status).send(result.body);
      throw error;
    }
  });

  app.post<{ Params: { id: string }; Body: { slug?: unknown } }>("/api/v1/articles/:id/publications/prepare", async (request, reply) => {
    try {
      const { publication, created } = await store.prepare(request.params.id, request.body?.slug);
      return reply.code(created ? 201 : 200).send(publication);
    } catch (error) {
      const result = respond(error);
      if (result) return reply.code(result.status).send(result.body);
      throw error;
    }
  });

  app.get<{ Params: { id: string; publicationId: string } }>("/api/v1/articles/:id/publications/:publicationId", async (request, reply) => {
    try { return await store.get(request.params.id, request.params.publicationId); }
    catch (error) {
      const result = respond(error);
      if (result) return reply.code(result.status).send(result.body);
      throw error;
    }
  });

  app.post<{ Params: { id: string }; Body: { confirmedRevision?: unknown; confirmedArticlePath?: unknown } }>("/api/v1/publications/:id/publish", async (request, reply) => {
    try { return await deploy.publish(request.params.id, request.body?.confirmedRevision, request.body?.confirmedArticlePath); }
    catch (error) {
      const result = respond(error);
      if (result) return reply.code(result.status).send(result.body);
      throw error;
    }
  });

  app.post<{ Params: { id: string }; Body: { publicUrl?: unknown; confirmedLayout?: unknown } }>("/api/v1/publications/:id/verify", async (request, reply) => {
    try { return await deploy.verify(request.params.id, request.body?.publicUrl, request.body?.confirmedLayout); }
    catch (error) {
      const result = respond(error);
      if (result) return reply.code(result.status).send(result.body);
      throw error;
    }
  });
}
