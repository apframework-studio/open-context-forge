import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { registerImportRoutes } from "./import/routes.js";
import { openDatabase } from "./state/db.js";
import { VaultRegistry } from "./vaults/registry.js";
import { registerVaultRoutes } from "./vaults/routes.js";

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

export function createApp(options: AppOptions) {
  const app = Fastify();
  const db = openDatabase(options.dataDir);
  const vaults = new VaultRegistry(db, options.dataDir, options.maintainerRoot);
  app.addHook("onClose", async () => db.close());
  app.addHook("onReady", async () => vaults.ensureDefault());

  app.register(multipart, {
    limits: { files: 1, parts: 1, fileSize: 20 * 1024 * 1024 },
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/v1/") || ["GET", "HEAD"].includes(request.method)) return;
    const origin = request.headers.origin;
    if (request.headers["x-ocf-client"] !== "1" || (origin && !allowedOrigins.has(origin))) {
      return reply.code(403).send({ error: "FORBIDDEN" });
    }
  });

  app.get("/api/v1/health", async () => ({ status: "ok" }));
  registerImportRoutes(app, db);
  registerVaultRoutes(app, db, vaults);
  return app;
}
