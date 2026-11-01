import type { FastifyInstance } from "fastify";
import { ArticleError } from "./store.js";
import { WritingContextError, WritingContextStore, type WritingContextInput } from "./writing-context.js";

type Params = { id: string };
export function registerWritingContextRoutes(app: FastifyInstance, store: WritingContextStore): void {
  const handle = async (reply: { code(status: number): { send(body: unknown): unknown } }, work: () => Promise<unknown>) => {
    try { return await work(); }
    catch (error) {
      if (error instanceof WritingContextError || error instanceof ArticleError) return reply.code(error.statusCode).send({ error: error.code });
      throw error;
    }
  };
  app.get<{ Params: Params }>("/api/v1/articles/:id/context", (request, reply) => handle(reply, () => store.get(request.params.id)));
  app.put<{ Params: Params; Body: WritingContextInput }>("/api/v1/articles/:id/context", (request, reply) => handle(reply, () => store.save(request.params.id, request.body)));
  app.get<{ Params: Params & { materialId: string }; Querystring: { turnId?: string } }>("/api/v1/articles/:id/materials/:materialId", (request, reply) =>
    handle(reply, () => store.material(request.params.id, request.params.materialId, request.query.turnId)));
  app.get<{ Params: Params }>("/api/v1/articles/:id/outline", (request, reply) => handle(reply, () => store.outline(request.params.id)));
  app.put<{ Params: Params; Body: { markdown: string; expectedRevision: number } }>("/api/v1/articles/:id/outline", { bodyLimit: 1024 * 1024 }, (request, reply) =>
    handle(reply, () => store.saveOutline(request.params.id, request.body?.markdown, request.body?.expectedRevision)));
  app.post<{ Params: Params; Body: { expectedRevision: number } }>("/api/v1/articles/:id/outline/approve", (request, reply) =>
    handle(reply, () => store.approveOutline(request.params.id, request.body?.expectedRevision)));
  app.get("/api/v1/writing/skill", () => store.skillStatus());
}
