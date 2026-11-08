import type { FastifyInstance } from "fastify";
import { ArticleError } from "../articles/store.js";
import { PublishCenterError, PublishCenterStore } from "./center.js";
import { ImageGenerationError, ImageGenerationService } from "./image-generation.js";
import { buildChannelHandoff } from "./handoff.js";

function respond(error: unknown) {
  if (error instanceof PublishCenterError || error instanceof ArticleError || error instanceof ImageGenerationError) {
    return { status: error.statusCode, body: { error: error.code } };
  }
  return undefined;
}

export function registerPublishCenterRoutes(app: FastifyInstance, center: PublishCenterStore, images: ImageGenerationService): void {
  app.get("/api/v1/publish-center", async () => center.list());
  app.get("/api/v1/image-generation/settings", async () => images.status());
  app.put<{ Body: unknown }>("/api/v1/image-generation/settings", async (request, reply) => {
    try { return await images.configure(request.body); }
    catch (error) { const result = respond(error); if (result) return reply.code(result.status).send(result.body); throw error; }
  });
  app.delete<{ Querystring: { provider?: string } }>("/api/v1/image-generation/settings", async (request, reply) => {
    try { return await images.clear(request.query.provider); }
    catch (error) { const result = respond(error); if (result) return reply.code(result.status).send(result.body); throw error; }
  });
  app.post<{ Body: unknown }>("/api/v1/image-generation/models", async (request, reply) => {
    try { return await images.addModel(request.body); }
    catch (error) { const result = respond(error); if (result) return reply.code(result.status).send(result.body); throw error; }
  });
  app.delete<{ Querystring: { provider?: string; model?: string } }>("/api/v1/image-generation/models", async (request, reply) => {
    try { return await images.removeModel(request.query.provider, request.query.model); }
    catch (error) { const result = respond(error); if (result) return reply.code(result.status).send(result.body); throw error; }
  });
  app.get<{ Params: { id: string } }>("/api/v1/articles/:id/publish-assets", async (request, reply) => {
    try { return await center.listAssets(request.params.id); }
    catch (error) { const result = respond(error); if (result) return reply.code(result.status).send(result.body); throw error; }
  });
  app.post<{ Params: { id: string }; Querystring: { group?: string } }>("/api/v1/articles/:id/publish-assets", async (request, reply) => {
    try {
      const file = await request.file();
      if (!file) throw new PublishCenterError("INVALID_ASSET", 422);
      const asset = await center.uploadAsset(request.params.id, request.query.group, file.filename, file.mimetype, await file.toBuffer());
      return reply.code(201).send(asset);
    } catch (error) {
      if (error instanceof Error && error.name === "RequestFileTooLargeError") return reply.code(413).send({ error: "INVALID_ASSET" });
      const result = respond(error); if (result) return reply.code(result.status).send(result.body); throw error;
    }
  });
  app.post<{ Params: { id: string }; Body: unknown }>("/api/v1/articles/:id/publish-assets/generate", async (request, reply) => {
    try { return reply.code(201).send(await images.generate(request.params.id, request.body)); }
    catch (error) { const result = respond(error); if (result) return reply.code(result.status).send(result.body); throw error; }
  });
  app.get<{ Params: { id: string; assetId: string } }>("/api/v1/articles/:id/publish-assets/:assetId/file", async (request, reply) => {
    try {
      const file = await center.readAsset(request.params.id, request.params.assetId);
      return reply.header("Content-Security-Policy", "default-src 'none'; sandbox").type(file.mime).send(file.bytes);
    } catch (error) { const result = respond(error); if (result) return reply.code(result.status).send(result.body); throw error; }
  });
  app.delete<{ Params: { id: string; assetId: string } }>("/api/v1/articles/:id/publish-assets/:assetId", async (request, reply) => {
    try { return await center.deleteAsset(request.params.id, request.params.assetId); }
    catch (error) { const result = respond(error); if (result) return reply.code(result.status).send(result.body); throw error; }
  });
  app.get<{ Params: { id: string; channel: string } }>("/api/v1/articles/:id/channel-drafts/:channel", async (request, reply) => {
    try { return await center.getDraft(request.params.id, request.params.channel); }
    catch (error) { const result = respond(error); if (result) return reply.code(result.status).send(result.body); throw error; }
  });
  app.get<{ Params: { id: string; channel: string } }>("/api/v1/articles/:id/channel-drafts/:channel/handoff", async (request, reply) => {
    try {
      const archive = await buildChannelHandoff(center, request.params.id, request.params.channel);
      const name = `${request.params.channel}-${request.params.id}.zip`;
      return reply.header("Content-Disposition", `attachment; filename="${name}"`).type("application/zip").send(archive);
    } catch (error) { const result = respond(error); if (result) return reply.code(result.status).send(result.body); throw error; }
  });
  app.put<{ Params: { id: string; channel: string }; Body: unknown }>("/api/v1/articles/:id/channel-drafts/:channel", async (request, reply) => {
    try { return await center.saveDraft(request.params.id, request.params.channel, request.body); }
    catch (error) { const result = respond(error); if (result) return reply.code(result.status).send(result.body); throw error; }
  });
  app.post<{ Params: { id: string; channel: string }; Body: unknown }>("/api/v1/articles/:id/channel-drafts/:channel/sync", async (request, reply) => {
    try { return await center.syncDraft(request.params.id, request.params.channel, request.body); }
    catch (error) { const result = respond(error); if (result) return reply.code(result.status).send(result.body); throw error; }
  });
  app.post<{ Params: { id: string; channel: string }; Body: unknown }>("/api/v1/articles/:id/channel-drafts/:channel/published", async (request, reply) => {
    try { return reply.code(201).send(await center.markPublished(request.params.id, request.params.channel, request.body)); }
    catch (error) { const result = respond(error); if (result) return reply.code(result.status).send(result.body); throw error; }
  });
}
