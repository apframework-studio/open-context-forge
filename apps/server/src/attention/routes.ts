import type { FastifyInstance } from "fastify";
import type { AttentionService } from "./service.js";

const validDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

export function registerAttentionRoutes(app: FastifyInstance, attention: AttentionService): void {
  app.get<{ Params: { id: string } }>("/api/v1/attention/:id", async (request, reply) => {
    const detail = await attention.detail(request.params.id);
    if (!detail) return reply.code(404).send({ error: "ATTENTION_NOT_FOUND" });
    return detail;
  });
  app.get<{ Querystring: { localDate?: unknown } }>("/api/v1/attention", async (request, reply) => {
    if (!validDate(request.query.localDate)) return reply.code(422).send({ error: "INVALID_LOCAL_DATE" });
    return attention.list(request.query.localDate);
  });
  app.post<{ Body: { localDate?: unknown } }>("/api/v1/attention/reminder-seen", async (request, reply) => {
    if (!validDate(request.body?.localDate)) return reply.code(422).send({ error: "INVALID_LOCAL_DATE" });
    attention.markReminderSeen(request.body.localDate);
    return { ok: true };
  });
}
