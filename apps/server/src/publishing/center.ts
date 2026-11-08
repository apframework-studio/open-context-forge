import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type Database from "better-sqlite3";
import type { ArticleStore } from "../articles/store.js";

export type ChannelId = "weibo" | "jike";
export type DraftStatus = "draft" | "ready";
export interface ChannelDraft {
  articleId: string;
  channelId: ChannelId;
  revision: number;
  sourceRevision: number;
  status: DraftStatus;
  content: Record<string, string>;
  assetIds: string[];
  updatedAt: string;
  stale: boolean;
  lastPublication: ChannelPublication | null;
}

export interface ChannelPublication {
  id: string;
  articleId: string;
  channelId: ChannelId;
  sourceRevision: number;
  publishedAt: string;
  url: string | null;
  current: boolean;
}

export interface PublishAsset {
  id: string;
  articleId: string;
  group: "vertical" | "article";
  name: string;
  mime: "image/png" | "image/jpeg" | "image/webp";
  origin: "upload" | "generated";
  generation?: { provider: string; prompt: string; model: string; aspectRatio: string; sourceRevision: number };
  createdAt: string;
  usedBy: ChannelId[];
}

interface DraftRow {
  article_id: string;
  channel_id: ChannelId;
  draft_revision: number;
  source_revision: number;
  status: DraftStatus;
  content_json: string;
  updated_at: string;
}

interface AssetRow {
  id: string;
  article_id: string;
  group_id: PublishAsset["group"];
  name: string;
  mime: PublishAsset["mime"];
  extension: string;
  created_at: string;
}

interface PublicationRow {
  id: string;
  article_id: string;
  channel_id: ChannelId;
  source_revision: number;
  fingerprint: string;
  published_at: string;
  url: string | null;
}

interface GenerationMeta {
  provider: string;
  group: PublishAsset["group"];
  prompt: string;
  model: string;
  aspectRatio: string;
  sourceRevision: number;
}

const channels = [
  { id: "weibo" as const, label: "微博" },
  { id: "jike" as const, label: "即刻" },
];

export class PublishCenterError extends Error {
  constructor(readonly code: "INVALID_CHANNEL" | "INVALID_DRAFT" | "ARTICLE_NOT_FINAL" | "DRAFT_NOT_FOUND" | "INVALID_ASSET" | "ASSET_NOT_FOUND" |
    "INVALID_PUBLICATION" | "DRAFT_NOT_READY" | "CHANNEL_REVISION_CONFLICT" | "HANDOFF_TOO_LARGE", readonly statusCode: number) {
    super(code);
  }
}

function channelId(value: string): ChannelId {
  if (value === "weibo" || value === "jike") return value;
  throw new PublishCenterError("INVALID_CHANNEL", 404);
}

function cleanContent(channel: ChannelId, value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PublishCenterError("INVALID_DRAFT", 422);
  const fields = channel === "weibo" ? ["text", "topics"] : ["text", "question"];
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !fields.includes(key))) throw new PublishCenterError("INVALID_DRAFT", 422);
  const content: Record<string, string> = {};
  for (const key of fields) {
    const field = input[key] ?? "";
    if (typeof field !== "string" || field.length > 5_000) throw new PublishCenterError("INVALID_DRAFT", 422);
    content[key] = field.trim();
  }
  return content;
}

function imageExtension(mime: string, bytes: Buffer): string {
  if (mime === "image/png" && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return ".png";
  if (mime === "image/jpeg" && bytes.length > 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return ".jpg";
  if (mime === "image/webp" && bytes.length > 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return ".webp";
  throw new PublishCenterError("INVALID_ASSET", 422);
}

export class PublishCenterStore {
  constructor(private readonly db: Database.Database, private readonly articles: ArticleStore, private readonly dataDir: string) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS publish_channel_drafts (
        article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
        channel_id TEXT NOT NULL,
        draft_revision INTEGER NOT NULL DEFAULT 1,
        source_revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        content_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (article_id, channel_id)
      );
      CREATE TABLE IF NOT EXISTS publish_media_assets (
        id TEXT PRIMARY KEY,
        article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL,
        name TEXT NOT NULL,
        mime TEXT NOT NULL,
        extension TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS publish_channel_images (
        article_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        asset_id TEXT NOT NULL REFERENCES publish_media_assets(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        PRIMARY KEY (article_id, channel_id, asset_id),
        FOREIGN KEY (article_id, channel_id) REFERENCES publish_channel_drafts(article_id, channel_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS publish_generated_images (
        asset_id TEXT PRIMARY KEY REFERENCES publish_media_assets(id) ON DELETE CASCADE,
        provider TEXT NOT NULL DEFAULT 'gemini',
        prompt TEXT NOT NULL,
        model TEXT NOT NULL,
        aspect_ratio TEXT NOT NULL,
        source_revision INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS publish_channel_publications (
        id TEXT PRIMARY KEY,
        article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
        channel_id TEXT NOT NULL,
        source_revision INTEGER NOT NULL,
        fingerprint TEXT NOT NULL,
        published_at TEXT NOT NULL,
        url TEXT
      );
      CREATE INDEX IF NOT EXISTS publish_channel_publications_recent ON publish_channel_publications(article_id, channel_id, published_at DESC);
    `);
    const columns = db.prepare("PRAGMA table_info(publish_channel_drafts)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "draft_revision")) {
      db.exec("ALTER TABLE publish_channel_drafts ADD COLUMN draft_revision INTEGER NOT NULL DEFAULT 1");
    }
    const generatedColumns = db.prepare("PRAGMA table_info(publish_generated_images)").all() as { name: string }[];
    if (!generatedColumns.some((column) => column.name === "provider")) {
      db.exec("ALTER TABLE publish_generated_images ADD COLUMN provider TEXT NOT NULL DEFAULT 'gemini'");
    }
  }

  private async finalArticle(articleId: string) {
    const article = await this.articles.get(articleId);
    if (article.status !== "final") throw new PublishCenterError("ARTICLE_NOT_FINAL", 409);
    return article;
  }

  private async draft(row: DraftRow): Promise<ChannelDraft> {
    const article = await this.articles.get(row.article_id);
    const imageRows = this.db.prepare("SELECT asset_id FROM publish_channel_images WHERE article_id = ? AND channel_id = ? ORDER BY position")
      .all(row.article_id, row.channel_id) as { asset_id: string }[];
    const lastPublication = this.lastPublication(row, article.revision, imageRows.map((item) => item.asset_id));
    return { articleId: row.article_id, channelId: row.channel_id, revision: row.draft_revision, sourceRevision: row.source_revision,
      status: row.status, content: JSON.parse(row.content_json) as Record<string, string>, assetIds: imageRows.map((item) => item.asset_id),
      updatedAt: row.updated_at, stale: row.source_revision !== article.revision, lastPublication };
  }

  private fingerprint(row: DraftRow, assetIds: string[]): string {
    return createHash("sha256").update(JSON.stringify([row.source_revision, row.content_json, assetIds])).digest("hex");
  }

  private lastPublication(row: DraftRow, articleRevision: number, assetIds?: string[]): ChannelPublication | null {
    const latest = this.db.prepare("SELECT * FROM publish_channel_publications WHERE article_id = ? AND channel_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(row.article_id, row.channel_id) as PublicationRow | undefined;
    if (!latest) return null;
    const images = assetIds ?? (this.db.prepare("SELECT asset_id FROM publish_channel_images WHERE article_id = ? AND channel_id = ? ORDER BY position")
      .all(row.article_id, row.channel_id) as { asset_id: string }[]).map((item) => item.asset_id);
    return { id: latest.id, articleId: latest.article_id, channelId: latest.channel_id, sourceRevision: latest.source_revision,
      publishedAt: latest.published_at, url: latest.url,
      current: row.status === "ready" && row.source_revision === articleRevision && latest.fingerprint === this.fingerprint(row, images) };
  }

  async list() {
    const articles = (await this.articles.list()).filter((article) => article.status === "final");
    const rows = this.db.prepare("SELECT * FROM publish_channel_drafts").all() as DraftRow[];
    return { channels, items: articles.map((article) => {
      const statuses = Object.fromEntries(channels.map(({ id }) => {
        const row = rows.find((item) => item.article_id === article.id && item.channel_id === id);
        const publication = row && this.lastPublication(row, article.revision);
        return [id, row ? { status: publication?.current ? "published" : row.status, stale: row.source_revision !== article.revision } : { status: "unplanned", stale: false }];
      }));
      return { id: article.id, title: article.title, summary: article.summary, revision: article.revision,
        updatedAt: article.updatedAt, channels: statuses };
    }) };
  }

  async getDraft(articleId: string, channel: string): Promise<ChannelDraft> {
    const id = channelId(channel);
    await this.finalArticle(articleId);
    const row = this.db.prepare("SELECT * FROM publish_channel_drafts WHERE article_id = ? AND channel_id = ?")
      .get(articleId, id) as DraftRow | undefined;
    if (!row) throw new PublishCenterError("DRAFT_NOT_FOUND", 404);
    return this.draft(row);
  }

  async saveDraft(articleId: string, channel: string, input: unknown): Promise<ChannelDraft> {
    const id = channelId(channel);
    const article = await this.finalArticle(articleId);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new PublishCenterError("INVALID_DRAFT", 422);
    const payload = input as Record<string, unknown>;
    if (!Number.isInteger(payload.expectedRevision) || (payload.expectedRevision as number) < 0) throw new PublishCenterError("INVALID_DRAFT", 422);
    const content = cleanContent(id, payload.content);
    if (payload.status !== "draft" && payload.status !== "ready") throw new PublishCenterError("INVALID_DRAFT", 422);
    if (payload.status === "ready" && !content.text) throw new PublishCenterError("INVALID_DRAFT", 422);
    if (!Array.isArray(payload.assetIds) || payload.assetIds.length > 20 ||
      payload.assetIds.some((item) => typeof item !== "string") || new Set(payload.assetIds).size !== payload.assetIds.length) {
      throw new PublishCenterError("INVALID_ASSET", 422);
    }
    const assetIds = payload.assetIds as string[];
    if (assetIds.length) {
      const available = this.db.prepare("SELECT id FROM publish_media_assets WHERE article_id = ?")
        .all(articleId) as { id: string }[];
      const own = new Set(available.map((item) => item.id));
      if (assetIds.some((assetId) => !own.has(assetId))) throw new PublishCenterError("INVALID_ASSET", 422);
    }
    this.db.transaction(() => {
      const existing = this.db.prepare("SELECT draft_revision, source_revision FROM publish_channel_drafts WHERE article_id = ? AND channel_id = ?")
        .get(articleId, id) as { draft_revision: number; source_revision: number } | undefined;
      if ((existing?.draft_revision ?? 0) !== payload.expectedRevision) throw new PublishCenterError("CHANNEL_REVISION_CONFLICT", 409);
      if (existing) this.db.prepare(`UPDATE publish_channel_drafts SET draft_revision = draft_revision + 1, status = ?, content_json = ?, updated_at = ?
        WHERE article_id = ? AND channel_id = ?`).run(payload.status, JSON.stringify(content), new Date().toISOString(), articleId, id);
      else this.db.prepare(`INSERT INTO publish_channel_drafts (article_id, channel_id, draft_revision, source_revision, status, content_json, updated_at)
        VALUES (?, ?, 1, ?, ?, ?, ?)`).run(articleId, id, article.revision, payload.status, JSON.stringify(content), new Date().toISOString());
      this.db.prepare("DELETE FROM publish_channel_images WHERE article_id = ? AND channel_id = ?").run(articleId, id);
      const insert = this.db.prepare("INSERT INTO publish_channel_images (article_id, channel_id, asset_id, position) VALUES (?, ?, ?, ?)");
      assetIds.forEach((assetId, index) => insert.run(articleId, id, assetId, index));
    })();
    return this.getDraft(articleId, id);
  }

  async syncDraft(articleId: string, channel: string, input: unknown): Promise<ChannelDraft> {
    const current = await this.getDraft(articleId, channel);
    const article = await this.finalArticle(articleId);
    const expectedRevision = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>).expectedRevision : null;
    if (!Number.isInteger(expectedRevision) || expectedRevision !== current.revision) throw new PublishCenterError("CHANNEL_REVISION_CONFLICT", 409);
    this.db.prepare("UPDATE publish_channel_drafts SET source_revision = ?, draft_revision = draft_revision + 1, updated_at = ? WHERE article_id = ? AND channel_id = ? AND draft_revision = ?")
      .run(article.revision, new Date().toISOString(), articleId, current.channelId, expectedRevision);
    return this.getDraft(articleId, current.channelId);
  }

  async markPublished(articleId: string, channel: string, input: unknown): Promise<ChannelPublication> {
    const draft = await this.getDraft(articleId, channel);
    if (draft.status !== "ready" || draft.stale) throw new PublishCenterError("DRAFT_NOT_READY", 409);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new PublishCenterError("INVALID_PUBLICATION", 422);
    if ((input as Record<string, unknown>).expectedRevision !== draft.revision) throw new PublishCenterError("CHANNEL_REVISION_CONFLICT", 409);
    const value = (input as Record<string, unknown>).url;
    if (value !== undefined && value !== null && (typeof value !== "string" || value.length > 2_000 ||
      (value !== "" && (!/^https:\/\//i.test(value) || !URL.canParse(value))))) throw new PublishCenterError("INVALID_PUBLICATION", 422);
    const timeValue = (input as Record<string, unknown>).publishedAt;
    if (timeValue !== undefined && timeValue !== null && (typeof timeValue !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(timeValue) ||
      !Number.isFinite(Date.parse(timeValue)) || Date.parse(timeValue) > Date.now() + 5 * 60_000)) throw new PublishCenterError("INVALID_PUBLICATION", 422);
    const row = this.db.prepare("SELECT * FROM publish_channel_drafts WHERE article_id = ? AND channel_id = ?")
      .get(articleId, draft.channelId) as DraftRow;
    if (row.draft_revision !== draft.revision) throw new PublishCenterError("CHANNEL_REVISION_CONFLICT", 409);
    const existing = this.lastPublication(row, draft.sourceRevision, draft.assetIds);
    if (existing?.current) return existing;
    const id = randomUUID(), publishedAt = typeof timeValue === "string" ? timeValue : new Date().toISOString(), url = typeof value === "string" && value ? value : null;
    this.db.prepare(`INSERT INTO publish_channel_publications (id, article_id, channel_id, source_revision, fingerprint, published_at, url)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, articleId, draft.channelId, row.source_revision, this.fingerprint(row, draft.assetIds), publishedAt, url);
    return { id, articleId, channelId: draft.channelId, sourceRevision: row.source_revision, publishedAt, url, current: true };
  }

  private assetPath(row: AssetRow): string {
    return join(this.dataDir, "writing-projects", row.article_id, "publish-assets", `${row.id}${row.extension}`);
  }

  private assetRow(articleId: string, assetId: string): AssetRow {
    const row = this.db.prepare("SELECT * FROM publish_media_assets WHERE id = ? AND article_id = ?")
      .get(assetId, articleId) as AssetRow | undefined;
    if (!row) throw new PublishCenterError("ASSET_NOT_FOUND", 404);
    return row;
  }

  private asset(row: AssetRow): PublishAsset {
    const refs = this.db.prepare("SELECT channel_id FROM publish_channel_images WHERE asset_id = ? ORDER BY channel_id DESC")
      .all(row.id) as { channel_id: ChannelId }[];
    const generation = this.db.prepare("SELECT provider, prompt, model, aspect_ratio, source_revision FROM publish_generated_images WHERE asset_id = ?")
      .get(row.id) as { provider: string; prompt: string; model: string; aspect_ratio: string; source_revision: number } | undefined;
    return { id: row.id, articleId: row.article_id, group: row.group_id, name: row.name,
      mime: row.mime, origin: generation ? "generated" : "upload", createdAt: row.created_at, usedBy: refs.map((ref) => ref.channel_id),
      ...(generation ? { generation: { provider: generation.provider, prompt: generation.prompt, model: generation.model, aspectRatio: generation.aspect_ratio,
        sourceRevision: generation.source_revision } } : {}) };
  }

  async listAssets(articleId: string): Promise<{ items: PublishAsset[] }> {
    await this.articles.get(articleId);
    const rows = this.db.prepare("SELECT * FROM publish_media_assets WHERE article_id = ? ORDER BY created_at, id")
      .all(articleId) as AssetRow[];
    return { items: rows.map((row) => this.asset(row)) };
  }

  private async saveAsset(articleId: string, group: unknown, name: unknown, mime: string, bytes: Buffer, generation?: GenerationMeta): Promise<PublishAsset> {
    await this.finalArticle(articleId);
    if (group !== "vertical" && group !== "article") throw new PublishCenterError("INVALID_ASSET", 422);
    if (typeof name !== "string" || !name || name.length > 200 || basename(name) !== name || bytes.length > 20 * 1024 * 1024) {
      throw new PublishCenterError("INVALID_ASSET", 422);
    }
    const extension = imageExtension(mime, bytes);
    const id = randomUUID();
    const row: AssetRow = { id, article_id: articleId, group_id: group, name,
      mime: mime as PublishAsset["mime"], extension, created_at: new Date().toISOString() };
    const path = this.assetPath(row);
    await mkdir(join(this.dataDir, "writing-projects", articleId, "publish-assets"), { recursive: true });
    try {
      await writeFile(path, bytes, { flag: "wx" });
      this.db.transaction(() => {
        this.db.prepare(`INSERT INTO publish_media_assets (id, article_id, group_id, name, mime, extension, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(id, articleId, group, name, mime, extension, row.created_at);
        if (generation) this.db.prepare(`INSERT INTO publish_generated_images (asset_id, provider, prompt, model, aspect_ratio, source_revision) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(id, generation.provider, generation.prompt, generation.model, generation.aspectRatio, generation.sourceRevision);
      })();
      return this.asset(row);
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    }
  }

  async uploadAsset(articleId: string, group: unknown, name: unknown, mime: string, bytes: Buffer): Promise<PublishAsset> {
    return this.saveAsset(articleId, group, name, mime, bytes);
  }

  async createGeneratedAsset(articleId: string, generation: GenerationMeta, mime: string, bytes: Buffer): Promise<PublishAsset> {
    const extension = mime === "image/jpeg" ? ".jpg" : mime === "image/webp" ? ".webp" : ".png";
    return this.saveAsset(articleId, generation.group, `生成图片-${new Date().toISOString().slice(0, 19).replaceAll(":", "-")}${extension}`, mime, bytes, generation);
  }

  async readAsset(articleId: string, assetId: string): Promise<{ bytes: Buffer; mime: string }> {
    await this.articles.get(articleId);
    const row = this.assetRow(articleId, assetId);
    return { bytes: await readFile(this.assetPath(row)), mime: row.mime };
  }

  async deleteAsset(articleId: string, assetId: string): Promise<{ affectedChannels: ChannelId[] }> {
    await this.finalArticle(articleId);
    const row = this.assetRow(articleId, assetId);
    const affectedChannels = this.asset(row).usedBy;
    this.db.transaction(() => {
      const demote = this.db.prepare("UPDATE publish_channel_drafts SET status = 'draft', draft_revision = draft_revision + 1, updated_at = ? WHERE article_id = ? AND channel_id = ?");
      for (const channel of affectedChannels) demote.run(new Date().toISOString(), articleId, channel);
      this.db.prepare("DELETE FROM publish_media_assets WHERE id = ? AND article_id = ?").run(assetId, articleId);
    })();
    await rm(this.assetPath(row), { force: true });
    return { affectedChannels };
  }
}
