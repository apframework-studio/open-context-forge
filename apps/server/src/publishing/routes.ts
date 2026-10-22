import type { FastifyInstance } from "fastify";
import { ArticleError } from "../articles/store.js";
import { PublicationError, PublicationStore } from "./publisher.js";

function respond(error: unknown) {
  if (error instanceof PublicationError || error instanceof ArticleError) {
    return { status: error.statusCode, body: { error: error.code } };
  }
  return undefined;
}

export function registerPublicationRoutes(app: FastifyInstance, store: PublicationStore): void {
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
}
