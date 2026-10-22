import Fastify from "fastify";

export interface AppOptions {
  dataDir: string;
  maintainerRoot?: string;
  publisherRoot?: string;
  blogRoot?: string;
}

const allowedOrigins = new Set([
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  "http://127.0.0.1:3081",
  "http://localhost:3081",
]);

export function createApp(_options: AppOptions) {
  const app = Fastify();

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/v1/") || ["GET", "HEAD"].includes(request.method)) return;
    const origin = request.headers.origin;
    if (request.headers["x-ocf-client"] !== "1" || (origin && !allowedOrigins.has(origin))) {
      return reply.code(403).send({ error: "FORBIDDEN" });
    }
  });

  app.get("/api/v1/health", async () => ({ status: "ok" }));
  return app;
}
