import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { ArticleStore } from "../articles/store.js";
import { runTool } from "../process/run.js";

export interface Publication {
  id: string;
  articleId: string;
  revision: number;
  slug: string;
  status: "prepared" | "stale";
  sourceSha256: string;
  articlePath: string;
  assets: string[];
  mdx: string;
}

export class PublicationError extends Error {
  constructor(readonly code: "INVALID_SLUG" | "ARTICLE_NOT_FINAL" | "PUBLICATION_NOT_FOUND" | "PUBLISHER_FAILED" | "INVALID_PACKAGE", readonly statusCode: number) {
    super(code);
  }
}

const defaultPublisherRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../open-context-forge-article-publisher");

interface PublicationRow {
  id: string;
  article_id: string;
  revision: number;
  slug: string;
  status: "prepared";
  source_sha256: string;
  article_path: string;
  assets_json: string;
}

function packageFile(root: string, path: string): string {
  if (!path || isAbsolute(path) || path.startsWith("..")) throw new PublicationError("INVALID_PACKAGE", 502);
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || rel.includes(`${sep}..${sep}`)) throw new PublicationError("INVALID_PACKAGE", 502);
  const real = realpathSync(target);
  if (!real.startsWith(`${root}${sep}`)) throw new PublicationError("INVALID_PACKAGE", 502);
  return real;
}

export class PublicationStore {
  private readonly root: string;
  private readonly dataDir: string;
  private readonly publisherRoot: string;

  constructor(private readonly db: Database.Database, dataDir: string, private readonly articles: ArticleStore, publisherRoot?: string) {
    this.dataDir = dataDir;
    this.root = join(dataDir, "publications");
    this.publisherRoot = realpathSync(publisherRoot ?? defaultPublisherRoot);
    db.exec(`
      CREATE TABLE IF NOT EXISTS publications (
        id TEXT PRIMARY KEY,
        article_id TEXT NOT NULL REFERENCES articles(id),
        revision INTEGER NOT NULL,
        slug TEXT NOT NULL,
        status TEXT NOT NULL,
        source_sha256 TEXT NOT NULL,
        article_path TEXT NOT NULL,
        assets_json TEXT NOT NULL,
        UNIQUE(article_id, revision, slug)
      );
    `);
  }

  private async fromRow(row: PublicationRow): Promise<Publication> {
    const current = await this.articles.get(row.article_id);
    const root = realpathSync(join(this.root, row.id));
    const mdx = await readFile(packageFile(root, row.article_path), "utf8");
    return {
      id: row.id, articleId: row.article_id, revision: row.revision, slug: row.slug,
      status: current.revision === row.revision && current.status === "final" ? row.status : "stale",
      sourceSha256: row.source_sha256, articlePath: row.article_path,
      assets: JSON.parse(row.assets_json) as string[], mdx,
    };
  }

  async get(articleId: string, publicationId: string): Promise<Publication> {
    const row = this.db.prepare("SELECT * FROM publications WHERE id = ? AND article_id = ?")
      .get(publicationId, articleId) as PublicationRow | undefined;
    if (!row) throw new PublicationError("PUBLICATION_NOT_FOUND", 404);
    return this.fromRow(row);
  }

  async prepare(articleId: string, slug: unknown): Promise<{ publication: Publication; created: boolean }> {
    if (typeof slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      throw new PublicationError("INVALID_SLUG", 422);
    }
    const article = await this.articles.get(articleId);
    if (article.status !== "final") throw new PublicationError("ARTICLE_NOT_FINAL", 409);
    const existing = this.db.prepare("SELECT * FROM publications WHERE article_id = ? AND revision = ? AND slug = ?")
      .get(articleId, article.revision, slug) as PublicationRow | undefined;
    if (existing) return { publication: await this.fromRow(existing), created: false };

    const id = randomUUID();
    const project = join(this.dataDir, "writing-projects", articleId);
    const output = join(this.root, id);
    const sourceSha256 = createHash("sha256").update(readFileSync(join(project, "article.md"))).digest("hex");
    try {
      await mkdir(output, { recursive: true });
      await runTool(process.execPath, [join(this.publisherRoot, "scripts", "publish.mjs"),
        "--project", project, "--channel", "apframework", "--output", output,
        "--slug", slug, "--json"], { cwd: this.publisherRoot, timeoutMs: 60_000 });
      const manifest: unknown = JSON.parse(await readFile(join(output, "publication.json"), "utf8"));
      if (typeof manifest !== "object" || manifest === null ||
        !("channel" in manifest) || manifest.channel !== "apframework" ||
        !("level" in manifest) || manifest.level !== "prepared" ||
        !("sourceSha256" in manifest) || manifest.sourceSha256 !== sourceSha256 ||
        !("article" in manifest) || typeof manifest.article !== "string" ||
        !("assets" in manifest) || !Array.isArray(manifest.assets) ||
        !manifest.assets.every((item) => typeof item === "string")) {
        throw new PublicationError("INVALID_PACKAGE", 502);
      }
      const realRoot = realpathSync(output);
      packageFile(realRoot, manifest.article);
      for (const asset of manifest.assets) packageFile(realRoot, asset);
      this.db.prepare(`
        INSERT INTO publications (id, article_id, revision, slug, status, source_sha256, article_path, assets_json)
        VALUES (?, ?, ?, ?, 'prepared', ?, ?, ?)
      `).run(id, articleId, article.revision, slug, sourceSha256, manifest.article, JSON.stringify(manifest.assets));
      return { publication: await this.get(articleId, id), created: true };
    } catch (error) {
      await rm(output, { recursive: true, force: true });
      if (error instanceof PublicationError) throw error;
      throw new PublicationError("PUBLISHER_FAILED", 502);
    }
  }
}
