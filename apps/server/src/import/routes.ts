import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { getBatch, insertBatch } from "../state/db.js";
import { ImportError, parseClipperZip } from "./clipper-zip.js";

export function registerImportRoutes(app: FastifyInstance, db: Database.Database): void {
  app.post("/api/v1/imports/preflight", async (request, reply) => {
    try {
      const file = await request.file();
      if (!file || file.fieldname !== "file") {
        return reply.code(400).send({ error: "FILE_REQUIRED" });
      }
      const bytes = await file.toBuffer();
      const candidates = parseClipperZip(bytes);
      const batch = { batchId: randomUUID(), createdAt: new Date().toISOString(), candidates };
      insertBatch(db, batch);
      return reply.code(201).send(batch);
    } catch (error) {
      if (error instanceof ImportError) {
        const status = error.code === "ARCHIVE_TOO_LARGE" || error.code === "MANIFEST_TOO_LARGE" ? 413 : 422;
        return reply.code(status).send({ error: error.code });
      }
      if (typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 413) {
        return reply.code(413).send({ error: "ARCHIVE_TOO_LARGE" });
      }
      throw error;
    }
  });

  app.get<{ Params: { batchId: string } }>("/api/v1/imports/:batchId", async (request, reply) => {
    const batch = getBatch(db, request.params.batchId);
    if (!batch) return reply.code(404).send({ error: "BATCH_NOT_FOUND" });
    return batch;
  });
}
