import type { FastifyInstance } from "fastify";
import { AnalysisError, AnalysisService } from "./service.js";
import { AnalysisJobs } from "./jobs.js";

function handle(error: unknown) {
  if (error instanceof AnalysisError) return { status: error.statusCode, body: { error: error.code } };
  return undefined;
}

export function registerAnalysisRoutes(app: FastifyInstance, service: AnalysisService, jobs: AnalysisJobs): void {
  app.get("/api/v1/maintenance/lane", async () => jobs.laneState());
  app.post("/api/v1/maintenance/lane/resume", async (_request, reply) => {
    try { return jobs.resumeLane(); }
    catch (error) { const result = handle(error); if (result) return reply.code(result.status).send(result.body); throw error; }
  });
  app.get<{ Querystring: { vaultId?: string } }>("/api/v1/maintenance/jobs", async (request) => ({ jobs: jobs.listMaintenance(request.query.vaultId) }));
  app.post<{ Body: { vaultId?: unknown; fingerprint?: unknown } }>("/api/v1/maintenance/jobs", async (request, reply) => {
    try {
      if (typeof request.body?.vaultId !== "string" || typeof request.body?.fingerprint !== "string") {
        throw new AnalysisError("INVALID_MAINTENANCE_JOB", 422);
      }
      return reply.code(202).send({ job: jobs.enqueueMaintenance(request.body.vaultId, request.body.fingerprint) });
    } catch (error) { const result = handle(error); if (result) return reply.code(result.status).send(result.body); throw error; }
  });
  app.post<{ Params: { id: string } }>("/api/v1/maintenance/jobs/:id/retry", async (request, reply) => {
    try { return reply.code(202).send({ job: jobs.retryMaintenance(request.params.id) }); }
    catch (error) { const result = handle(error); if (result) return reply.code(result.status).send(result.body); throw error; }
  });
  app.post<{ Params: { id: string } }>("/api/v1/maintenance/jobs/:id/cancel", async (request, reply) => {
    try { return { job: jobs.cancelMaintenance(request.params.id) }; }
    catch (error) { const result = handle(error); if (result) return reply.code(result.status).send(result.body); throw error; }
  });
  app.post<{ Params: { id: string }; Body: { confirmed?: unknown } }>(
    "/api/v1/maintenance/jobs/:id/metadata-sync/resolve", async (request, reply) => {
      try { return { job: await jobs.runMetadataCorrection(() =>
        jobs.resolveMetadataSync(request.params.id, request.body?.confirmed)) }; }
      catch (error) { const result = handle(error); if (result) return reply.code(result.status).send(result.body); throw error; }
    });
  app.post<{ Params: { id: string }; Body: { decision?: unknown } }>(
    "/api/v1/maintenance/jobs/:id/resolve", async (request, reply) => {
      try { return { job: jobs.resolveAskUser(request.params.id, request.body?.decision) }; }
      catch (error) { const result = handle(error); if (result) return reply.code(result.status).send(result.body); throw error; }
    });
  app.post<{ Params: { id: string } }>("/api/v1/maintenance/jobs/:id/inspect", async (request, reply) => {
    try { return { job: await jobs.inspectMaintenance(request.params.id) }; }
    catch (error) { const result = handle(error); if (result) return reply.code(result.status).send(result.body); throw error; }
  });
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
      try { return reply.code(201).send(await jobs.runExclusive(() => service.proposeCapture(request.params.batchId, request.params.captureId, request.body?.profileId))); }
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
    try { return reply.code(201).send(await jobs.runExclusive(() => service.propose(request.body?.vaultId, request.body?.snapshot, request.body?.profileId))); }
    catch (error) { const result = handle(error); if (result) return reply.code(result.status).send(result.body); throw error; }
  });
  app.post<{ Body: { vaultId?: unknown; snapshot?: unknown; expectedFingerprint?: unknown } }>("/api/v1/sources/analysis/confirm", async (request, reply) => {
    try { return await service.confirm(request.body?.vaultId, request.body?.snapshot, request.body?.expectedFingerprint); }
    catch (error) { const result = handle(error); if (result) return reply.code(result.status).send(result.body); throw error; }
  });
}
