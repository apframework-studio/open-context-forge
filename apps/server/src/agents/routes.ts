import type { FastifyInstance } from "fastify";
import { ArticleError } from "../articles/store.js";
import { AgentError, AgentService } from "./service.js";

function handle(error: unknown) {
  if (error instanceof AgentError || error instanceof ArticleError) return { status: error.statusCode, body: { error: error.code } };
  return undefined;
}

export function registerAgentRoutes(app: FastifyInstance, agents: AgentService): void {
  app.get("/api/v1/agents/profiles", async () => ({ profiles: agents.profiles() }));
  app.get<{ Params: { id: string }; Querystring: { profileId?: string } }>("/api/v1/articles/:id/agent", async (request, reply) => {
    try { return await agents.history(request.params.id, request.query.profileId); }
    catch (error) { const result = handle(error); if (result) return reply.code(result.status).send(result.body); throw error; }
  });
  app.post<{ Params: { id: string }; Body: { profileId?: unknown; content?: unknown } }>("/api/v1/articles/:id/agent/messages", async (request, reply) => {
    try { return reply.code(201).send(await agents.send(request.params.id, request.body?.profileId, request.body?.content)); }
    catch (error) { const result = handle(error); if (result) return reply.code(result.status).send(result.body); throw error; }
  });
}
