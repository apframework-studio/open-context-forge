import type { FastifyInstance } from "fastify";
import { AnalysisError, AnalysisService } from "./service.js";
import { AnalysisJobs } from "./jobs.js";

function handle(error: unknown) {
  if (error instanceof AnalysisError) return { status: error.statusCode, body: { error: error.code } };
  return undefined;
}

export function registerAnalysisRoutes(app: FastifyInstance, service: AnalysisService, jobs: AnalysisJobs): void {
  app.get("/api/v1/analysis/jobs", async () => ({ jobs: jobs.list() }));
  app.post<{ Body: { items?: unknown } }>("/api/v1/analysis/jobs", async (request, reply) => {
    try { return reply.code(202).send({ jobs: jobs.enqueue(request.body?.items) }); }
    catch (error) { const result = handle(error); if (result) return reply.code(result.status).send(result.body); throw error; }
  });
  app.get<{ Params: { batchId: string; captureId: string } }>("/api/v1/imports/:batchId/items/:captureId/analysis", async (request, reply) => {
    try {
      const card = service.getCapture(request.params.batchId, request.params.captureId);
      if (!card) return reply.code(404).send({ error: "ANALYSIS_NOT_FOUND" });
      return card;
    } catch (error) { const result = handle(error); if (result) return reply.code(result.status).send(result.body); throw error; }
  });
  app.post<{ Params: { batchId: string; captureId: string }; Body: { profileId?: unknown } }>(
    "/api/v1/imports/:batchId/items/:captureId/analysis", async (request, reply) => {
      try { return reply.code(201).send(await service.proposeCapture(request.params.batchId, request.params.captureId, request.body?.profileId)); }
      catch (error) { const result = handle(error); if (result) return reply.code(result.status).send(result.body); throw error; }
    });
  app.post<{ Params: { batchId: string; captureId: string }; Body: { expectedFingerprint?: unknown } }>(
    "/api/v1/imports/:batchId/items/:captureId/analysis/confirm", async (request, reply) => {
      try { return await service.confirmCapture(request.params.batchId, request.params.captureId, request.body?.expectedFingerprint); }
      catch (error) { const result = handle(error); if (result) return reply.code(result.status).send(result.body); throw error; }
    });
  app.get<{ Querystring: { vaultId?: string; snapshot?: string } }>("/api/v1/sources/analysis", async (request, reply) => {
    try {
      const card = await service.get(request.query.vaultId, request.query.snapshot);
      if (!card) return reply.code(404).send({ error: "ANALYSIS_NOT_FOUND" });
      return card;
    } catch (error) { const result = handle(error); if (result) return reply.code(result.status).send(result.body); throw error; }
  });
  app.post<{ Body: { vaultId?: unknown; snapshot?: unknown; profileId?: unknown } }>("/api/v1/sources/analysis", async (request, reply) => {
    try { return reply.code(201).send(await service.propose(request.body?.vaultId, request.body?.snapshot, request.body?.profileId)); }
    catch (error) { const result = handle(error); if (result) return reply.code(result.status).send(result.body); throw error; }
  });
  app.post<{ Body: { vaultId?: unknown; snapshot?: unknown; expectedFingerprint?: unknown } }>("/api/v1/sources/analysis/confirm", async (request, reply) => {
    try { return await service.confirm(request.body?.vaultId, request.body?.snapshot, request.body?.expectedFingerprint); }
    catch (error) { const result = handle(error); if (result) return reply.code(result.status).send(result.body); throw error; }
  });
}
