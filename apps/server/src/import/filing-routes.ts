import type { FastifyInstance } from "fastify";
import type { VaultRegistry } from "../vaults/registry.js";
import type { FilingJobs } from "./filing-jobs.js";

function status(error: unknown): { code: string; status: number } {
  const code = error instanceof Error ? error.message : "VAULT_IMPORT_FAILED";
  return { code, status: code === "SOURCE_NOT_FOUND" || code === "FILING_JOB_NOT_FOUND" ? 404 :
    code === "INCOMPLETE_SOURCE" || code === "FILING_NOT_CANCELLABLE" || code === "FILING_NOT_RETRYABLE" ||
    code === "FILING_INSPECTION_REQUIRED" ? 409 : 502 };
}

export function registerFilingRoutes(app: FastifyInstance, vaults: VaultRegistry, jobs: FilingJobs): void {
  app.get("/api/v1/imports/filing-lane", async () => jobs.laneState());
  app.post("/api/v1/imports/filing-lane/resume", async (_request, reply) => {
    try { return jobs.resumeLane(); }
    catch (error) { const result = status(error); return reply.code(result.status).send({ error: result.code }); }
  });
  app.get<{ Querystring: { vaultId?: string } }>("/api/v1/imports/filing-jobs", async (request) => ({ jobs: jobs.list(request.query.vaultId) }));

  app.post<{ Params: { batchId: string; captureId: string }; Body: { vaultId?: unknown } }>(
    "/api/v1/imports/:batchId/items/:captureId/commit", async (request, reply) => {
      const vaultId = request.body?.vaultId;
      if (typeof vaultId !== "string") return reply.code(422).send({ error: "VAULT_REQUIRED" });
      if (!vaults.get(vaultId)) return reply.code(404).send({ error: "VAULT_NOT_FOUND" });
      try { return reply.code(202).send({ job: jobs.enqueue(request.params.batchId, request.params.captureId, vaultId) }); }
      catch (error) { const result = status(error); return reply.code(result.status).send({ error: result.code }); }
    });

  app.post<{ Params: { id: string } }>("/api/v1/imports/filing-jobs/:id/retry", async (request, reply) => {
    try { return reply.code(202).send({ job: jobs.retry(request.params.id) }); }
    catch (error) { const result = status(error); return reply.code(result.status).send({ error: result.code }); }
  });
  app.post<{ Params: { id: string } }>("/api/v1/imports/filing-jobs/:id/inspect", async (request, reply) => {
    try { return { job: await jobs.inspect(request.params.id) }; }
    catch (error) { const result = status(error); return reply.code(result.status).send({ error: result.code }); }
  });
  app.post<{ Params: { id: string } }>("/api/v1/imports/filing-jobs/:id/cancel", async (request, reply) => {
    try { return { job: jobs.cancel(request.params.id) }; }
    catch (error) { const result = status(error); return reply.code(result.status).send({ error: result.code }); }
  });
}
