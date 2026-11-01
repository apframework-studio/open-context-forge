import { WritingContextError } from "../articles/writing-context.js";
import type { FastifyInstance } from "fastify";
import { ArticleError } from "../articles/store.js";
import { AgentError, AgentService } from "./service.js";
import { isActive, RunError } from "./runs.js";

function handle(error: unknown) {
  if (error instanceof WritingContextError || error instanceof AgentError || error instanceof ArticleError || error instanceof RunError) return { status: error.statusCode, body: { error: error.code } };
  return undefined;
}

export function registerAgentRoutes(app: FastifyInstance, agents: AgentService): void {
  app.post<{ Params: { id: string }; Body: { profileId?: unknown; content?: unknown; selections?: unknown } }>("/api/v1/articles/:id/agent/runs", async (request, reply) => {
    try { return reply.code(202).send(await agents.start(request.params.id, request.body?.profileId, request.body?.content, request.body?.selections)); }
    catch (error) { const result = handle(error); if (result) return reply.code(result.status).send(result.body); throw error; }
  });
  app.post<{ Params: { id: string; runId: string } }>("/api/v1/articles/:id/agent/runs/:runId/cancel", async (request, reply) => {
    try { await agents.requireArticle(request.params.id); return agents.runs.cancel(request.params.id, request.params.runId); }
    catch (error) { const result = handle(error); if (result) return reply.code(result.status).send(result.body); throw error; }
  });
  app.post<{ Params: { id: string; runId: string }; Body: { requestId?: unknown; optionId?: unknown } }>("/api/v1/articles/:id/agent/runs/:runId/permission", async (request, reply) => {
    try { await agents.requireArticle(request.params.id); return agents.runs.answer(request.params.id, request.params.runId, request.body?.requestId, request.body?.optionId); }
    catch (error) { const result = handle(error); if (result) return reply.code(result.status).send(result.body); throw error; }
  });
  app.get<{ Params: { id: string; runId: string } }>("/api/v1/articles/:id/agent/runs/:runId/events", async (request, reply) => {
    try {
      await agents.requireArticle(request.params.id);
      agents.runs.get(request.params.id, request.params.runId);
    } catch (error) { const result = handle(error); if (result) return reply.code(result.status).send(result.body); throw error; }
    reply.hijack();
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
    let seq = -1, heartbeat = 0;
    const push = () => {
      if (reply.raw.destroyed || reply.raw.writableNeedDrain) return;
      try {
        const run = agents.runs.get(request.params.id, request.params.runId);
        if (run.seq !== seq) { seq = run.seq; reply.raw.write(`id: ${seq}\nevent: snapshot\ndata: ${JSON.stringify(run)}\n\n`); }
        if (!isActive(run)) { clearInterval(timer); reply.raw.end(); }
        else if (++heartbeat % 100 === 0) reply.raw.write(": heartbeat\n\n");
      } catch (error) {
        clearInterval(timer);
        if (error instanceof RunError && error.code === "AGENT_RUN_NOT_FOUND") {
          reply.raw.write('event: removed\ndata: {"error":"ARTICLE_NOT_FOUND"}\n\n');
        } else app.log.error(error, "Agent event stream closed after a read failure");
        reply.raw.end();
      }
    };
    // Coalesce native token events into a snapshot at most every 100ms. Storage keeps the original deltas.
    const timer = setInterval(push, 100);
    reply.raw.once("close", () => clearInterval(timer));
    push();
  });
  app.get<{Params:{id:string}}>("/api/v1/articles/:id/writing-proposals", async (request,reply) => {
    try {return await agents.proposals(request.params.id);}
    catch(error) {const result = handle(error); if(result) return reply.code(result.status).send(result.body); throw error;}
  });
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
