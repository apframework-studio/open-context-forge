import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

const MAX_ICON_BYTES = 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function validIcon(bytes: Buffer): boolean {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString("ascii", 12, 16) !== "IHDR") return false;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return width === height && width >= 32 && width <= 512;
}

export function registerBrandingRoutes(app: FastifyInstance, dataDir: string): void {
  const iconDir = join(dataDir, "branding");
  const iconPath = join(iconDir, "icon.png");

  async function status() {
    try {
      const icon = await stat(iconPath);
      return { customized: true, revision: `${icon.mtimeMs}-${icon.size}` };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { customized: false, revision: null };
    }
  }

  app.get("/api/v1/branding", status);
  app.get("/api/v1/branding/icon", async (_request, reply) => {
    try {
      const bytes = await readFile(iconPath);
      return reply.header("content-type", "image/png").header("cache-control", "no-store").send(bytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return reply.code(404).send({ error: "ICON_NOT_FOUND" });
    }
  });
  app.put("/api/v1/branding/icon", async (request, reply) => {
    let file;
    let bytes: Buffer;
    try {
      file = await request.file({ limits: { files: 1, parts: 1, fileSize: MAX_ICON_BYTES } });
      if (!file || file.fieldname !== "file") return reply.code(400).send({ error: "FILE_REQUIRED" });
      bytes = await file.toBuffer();
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "FST_REQ_FILE_TOO_LARGE") {
        return reply.code(413).send({ error: "ICON_TOO_LARGE" });
      }
      throw error;
    }
    if (file.mimetype !== "image/png" || !validIcon(bytes)) return reply.code(422).send({ error: "ICON_INVALID" });

    await mkdir(iconDir, { recursive: true });
    const temporaryPath = join(iconDir, `.${randomUUID()}.png`);
    try {
      await writeFile(temporaryPath, bytes, { flag: "wx" });
      await rename(temporaryPath, iconPath);
    } finally { await rm(temporaryPath, { force: true }); }
    return status();
  });
  app.delete("/api/v1/branding/icon", async () => {
    await rm(iconPath, { force: true });
    return status();
  });
}
