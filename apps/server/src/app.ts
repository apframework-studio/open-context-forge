import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { registerImportRoutes } from "./import/routes.js";
import { openDatabase } from "./state/db.js";
import { VaultRegistry } from "./vaults/registry.js";
import { registerVaultRoutes } from "./vaults/routes.js";
import { ArticleStore } from "./articles/store.js";
import { registerArticleRoutes } from "./articles/routes.js";
import { PublicationStore } from "./publishing/publisher.js";
import { registerPublicationRoutes } from "./publishing/routes.js";
import { BlogDeploy } from "./publishing/blog-deploy.js";
import { AgentService, type AgentOptions } from "./agents/service.js";
import { registerAgentRoutes } from "./agents/routes.js";
import { AnalysisService } from "./analysis/service.js";
import { registerAnalysisRoutes } from "./analysis/routes.js";
import { AnalysisJobs } from "./analysis/jobs.js";
import { MaintenanceCompiler } from "./analysis/maintenance.js";
import { KnowledgeIndex } from "./vaults/knowledge-index.js";
import { registerKnowledgeRoutes } from "./vaults/knowledge-routes.js";
import { registerBrandingRoutes } from "./branding/routes.js";
import { WritingContextStore } from "./articles/writing-context.js";
import { registerWritingContextRoutes } from "./articles/writing-context-routes.js";
import { FilingJobs } from "./import/filing-jobs.js";
import { fileCapture } from "./import/filing.js";
import { registerFilingRoutes } from "./import/filing-routes.js";
import { backfillSourceKeys, reconcileFiling } from "./import/filing-recovery.js";
import { AttentionService } from "./attention/service.js";
import { registerAttentionRoutes } from "./attention/routes.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface AppOptions {
  dataDir: string;
  allowedOrigins?: string[];
  maintainerRoot?: string;
  publisherRoot?: string;
  blogRoot?: string;
  writerRoot?: string;
  readerRoot?: string;
  publicOrigin?: string;
  verifyFetch?: (url: string, init?: RequestInit) => Promise<Response>;
  agentOptions?: AgentOptions;
}

export function createApp(options: AppOptions) {
  const allowedOrigins = new Set([
    "http://127.0.0.1:5173", "http://localhost:5173",
    "http://127.0.0.1:3081", "http://localhost:3081",
    ...(options.allowedOrigins ?? []),
  ]);
  const app = Fastify();
  const db = openDatabase(options.dataDir);
  const vaults = new VaultRegistry(db, options.dataDir, options.maintainerRoot);
  const articles = new ArticleStore(db, options.dataDir, vaults, options.writerRoot);
  const knowledge = new KnowledgeIndex(db, vaults);
  const writing = new WritingContextStore(db, options.dataDir, vaults, articles, knowledge);
  const publications = new PublicationStore(db, options.dataDir, articles, options.publisherRoot);
  const deploy = new BlogDeploy(db, options.dataDir, publications, articles, options);
  const agents = new AgentService(db, options.dataDir, articles, vaults, options.agentOptions, writing);
  const analysis = new AnalysisService(db, options.dataDir, vaults, options.agentOptions, options.readerRoot);
  const maintenance = new MaintenanceCompiler(vaults, options.dataDir, options.agentOptions);
  const analysisJobs = new AnalysisJobs(db, analysis, maintenance, vaults, knowledge);
  const filingJobs = new FilingJobs(db, (job) => fileCapture(db, vaults, job.batchId, job.captureId,
    job.vaultId, { maintenanceJobs: analysisJobs }),
    (job) => reconcileFiling(db, vaults, analysisJobs, job),
    () => vaults.list().vaults.every((vault) => !existsSync(join(vault.path, ".ocf", "ingest.lock"))));
  const attention = new AttentionService(db, vaults);
  app.addHook("preClose", async () => { await agents.stop(); });
  app.addHook("onClose", async () => { await agents.stop(); await filingJobs.stop(); await analysisJobs.stop(); knowledge.close(); db.close(); });
  app.addHook("onReady", async () => { await vaults.ensureDefault(); await articles.cleanupDeletedArticles();
    await backfillSourceKeys(db, vaults); await analysisJobs.resume(); await filingJobs.resume(); });

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
  registerImportRoutes(app, db, vaults, filingJobs, analysisJobs);
  registerFilingRoutes(app, vaults, filingJobs);
  registerVaultRoutes(app, db, vaults, analysisJobs);
  registerArticleRoutes(app, articles, (id) => agents.isBusy(id));
  registerWritingContextRoutes(app, writing);
  registerPublicationRoutes(app, publications, deploy);
  registerAgentRoutes(app, agents);
  registerAnalysisRoutes(app, analysis, analysisJobs);
  registerAttentionRoutes(app, attention);
  registerKnowledgeRoutes(app, knowledge, vaults);
  registerBrandingRoutes(app, options.dataDir);
  return app;
}
