import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, mkdirSync, openSync, closeSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type Database from "better-sqlite3";
import type { WritingContext, WritingMaterial, WritingMaterialDetail, WritingMaterialRef, WritingOutline, WritingSelection, WritingTurnContext, WriterSkillStatus } from "@ocf/contracts";
import { ArticleStore } from "./store.js";
import { KnowledgeError, KnowledgeIndex } from "../vaults/knowledge-index.js";
import type { VaultRegistry } from "../vaults/registry.js";
import { documentFormat, documentText } from "../vaults/document-format.js";

const maxFileBytes = 2 * 1024 * 1024;
const maxTurnBytes = 12 * 1024 * 1024;
export class WritingContextError extends Error {
  constructor(readonly code: "INVALID_WRITING_CONTEXT" | "INVALID_WRITING_SELECTION" | "WRITING_MATERIAL_NOT_FOUND" | "WRITING_TURN_NOT_FOUND" | "REVISION_CONFLICT" | "WRITING_CONTEXT_TOO_LARGE" | "INVALID_WRITING_OUTLINE", readonly statusCode: number) { super(code); }
}
export interface WritingContextInput {
  expectedRevision: number; vaultIds: string[]; materials: WritingMaterialRef[]; skillEnabled?: boolean; refresh?: boolean;
}
type ContextRow = { context_json: string; next_id: number };
type MaterialRow = { material_json: string; snapshot_file: string };
function invalid(): never { throw new WritingContextError("INVALID_WRITING_CONTEXT", 422); }
function validRelative(path: unknown): path is string {
  return typeof path === "string" && !!path && path.length <= 1000 && !isAbsolute(path) && !path.includes("\\") && !path.includes("\0") && !path.split("/").some(part => part === ".." || part === "." || part === "");
}
function safeFile(root: string, path: string): string {
  if (!validRelative(path)) invalid();
  let cursor = root;
  for (const part of path.split("/")) { cursor = join(cursor, part); if (lstatSync(cursor).isSymbolicLink()) invalid(); }
  const real = realpathSync(cursor), rel = relative(realpathSync(root), real);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel) || !statSync(real).isFile()) invalid();
  return real;
}
function readSafe(root: string, path: string): string {
  const file = safeFile(root, path);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return readFileSync(fd, "utf8"); } finally { closeSync(fd); }
}
function safeUrl(url: string | null): string | null {
  try { if (url && ["https:", "http:"].includes(new URL(url).protocol)) return url; } catch { /* Untrusted metadata. */ }
  return null;
}
function materialMetadata(detail: WritingMaterialDetail): WritingMaterial {
  const { markdown: _markdown, outlinks: _outlinks, issues: _issues, ...metadata } = detail;
  return metadata;
}

export class WritingContextStore {
  constructor(private readonly db: Database.Database, private readonly dataDir: string, private readonly vaults: VaultRegistry,
    private readonly articles: ArticleStore, private readonly knowledge: KnowledgeIndex) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS writing_contexts (article_id TEXT PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE, context_json TEXT NOT NULL, next_id INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS writing_materials (article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE, id TEXT NOT NULL, material_json TEXT NOT NULL, snapshot_file TEXT NOT NULL, PRIMARY KEY(article_id,id));
      CREATE TABLE IF NOT EXISTS writing_turns (article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE, id TEXT NOT NULL, turn_json TEXT NOT NULL, snapshots_json TEXT NOT NULL, PRIMARY KEY(article_id,id));
      CREATE TABLE IF NOT EXISTS writing_outlines (article_id TEXT PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE, outline_json TEXT NOT NULL);
    `);
  }
  private root(articleId: string): string {
    if (!/^[0-9a-f-]{36}$/.test(articleId)) invalid();
    const root = join(this.dataDir, "writing-projects", articleId, "context");
    let cursor = realpathSync(this.dataDir);
    for (const part of ["writing-projects", articleId]) {
      cursor = join(cursor, part); if (lstatSync(cursor).isSymbolicLink() || !statSync(cursor).isDirectory()) invalid();
    }
    try { mkdirSync(root); } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    }
    if (lstatSync(root).isSymbolicLink() || !statSync(root).isDirectory()) invalid();
    return root;
  }
  private snapshot(articleId: string, detail: WritingMaterialDetail): string {
    const file = `${randomUUID()}.json`;
    writeFileSync(join(this.root(articleId), file), JSON.stringify(detail), { flag: "wx", mode: 0o600 });
    return file;
  }
  private readSnapshot(articleId: string, file: string): WritingMaterialDetail {
    if (!/^[0-9a-f-]{36}\.json$/.test(file)) invalid();
    return JSON.parse(readSafe(this.root(articleId), file)) as WritingMaterialDetail;
  }
  private row(articleId: string): ContextRow | undefined {
    return this.db.prepare("SELECT context_json,next_id FROM writing_contexts WHERE article_id = ?").get(articleId) as ContextRow | undefined;
  }
  private current(articleId: string): WritingContext { return JSON.parse(this.row(articleId)!.context_json) as WritingContext; }
  private source(ref: WritingMaterialRef, id: string, legacy = false): WritingMaterialDetail {
    if (!ref || typeof ref.vaultId !== "string" || !validRelative(ref.path) || !documentFormat(ref.path) || documentFormat(ref.path) === "pdf") invalid();
    const vault = this.vaults.get(ref.vaultId); if (!vault) invalid();
    let file: string;
    try { file = safeFile(vault.path, ref.path); } catch { return invalid(); }
    if (statSync(file).size > maxFileBytes) throw new WritingContextError("WRITING_CONTEXT_TOO_LARGE", 422);
    const markdown = documentText(ref.path, readSafe(vault.path, ref.path));
    if (Buffer.byteLength(markdown) > maxFileBytes) throw new WritingContextError("WRITING_CONTEXT_TOO_LARGE", 422);
    let title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || basename(ref.path, ".md");
    let kind: WritingMaterial["kind"] = "source", originalUrl: string | null = null;
    let outlinks: WritingMaterialDetail["outlinks"] = [], issues: WritingMaterialDetail["issues"] = [];
    try {
      this.knowledge.refresh(ref.vaultId);
      const item = this.knowledge.detail(ref.vaultId, ref.path);
      // Read through the index only after validating its file boundary; snapshot the same verified content.
      if (item.markdown !== markdown) throw new WritingContextError("REVISION_CONFLICT", 409);
      title = item.title; kind = legacy ? "source" : item.kind; originalUrl = safeUrl(item.originalUrl);
      outlinks = item.outlinks.filter(link => { try { safeFile(vault.path, link.to); return true; } catch { return false; } })
        .map(({ from, to, type, target, line }) => ({ from, to, type, target, line }));
      issues = item.issues;
    } catch (error) {
      if (!legacy || !ref.path.startsWith("raw/sources/") || !(error instanceof KnowledgeError) || error.code !== "KNOWLEDGE_ITEM_NOT_FOUND") {
        if (error instanceof WritingContextError) throw error;
        return invalid();
      }
    }
    return { ...ref, id, title, kind, sha256: createHash("sha256").update(markdown).digest("hex"), originalUrl,
      addedAt: new Date().toISOString(), markdown, outlinks, issues };
  }
  private insertContext(articleId: string, details: WritingMaterialDetail[]): WritingContext {
    const materials = details.map(materialMetadata);
    const context: WritingContext = { revision: 0, vaultIds: [...new Set(materials.map(({ vaultId }) => vaultId))],
      materials, skillEnabled: true };
    this.db.prepare("INSERT INTO writing_contexts VALUES (?,?,?)").run(articleId, JSON.stringify(context), materials.length + 1);
    const insert = this.db.prepare("INSERT INTO writing_materials VALUES (?,?,?,?)");
    details.forEach((detail, index) => {
      insert.run(articleId, detail.id, JSON.stringify(materials[index]), this.snapshot(articleId, detail));
    });
    return context;
  }
  prepareInitialContext(input: unknown): (articleId: string) => void {
    if (!Array.isArray(input) || input.length < 1 || input.length > 30) invalid();
    const keys = new Set<string>();
    const vaultIds = new Set<string>();
    const refs: WritingMaterialRef[] = input.map((ref) => {
      if (!ref || typeof ref.vaultId !== "string" || !validRelative(ref.path)) invalid();
      const key = JSON.stringify([ref.vaultId, ref.path]);
      if (keys.has(key)) invalid();
      keys.add(key); vaultIds.add(ref.vaultId);
      return { vaultId: ref.vaultId, path: ref.path };
    });
    if (vaultIds.size > 20) invalid();
    return (articleId) => {
      const details = refs.map((ref, index) => this.source(ref, `S${index + 1}`));
      this.insertContext(articleId, details);
    };
  }
  async get(articleId: string): Promise<WritingContext> {
    return this.articles.withActivity(articleId, async () => {
      const article = await this.articles.get(articleId);
      if (this.row(articleId)) return this.current(articleId);
      const detail = article.sourceRef ? this.source({ vaultId: article.sourceRef.vaultId, path: article.sourceRef.snapshot }, "S1", true) : null;
      return this.db.transaction(() => {
        if (this.row(articleId)) return this.current(articleId);
        return this.insertContext(articleId, detail ? [detail] : []);
      })();
    });
  }
  async save(articleId: string, input: WritingContextInput): Promise<WritingContext> {
    return this.articles.withActivity(articleId, async () => {
      await this.get(articleId);
      if (!input || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 0 || !Array.isArray(input.vaultIds) || input.vaultIds.length > 20 ||
        input.vaultIds.some(id => typeof id !== "string" || !this.vaults.get(id)) || new Set(input.vaultIds).size !== input.vaultIds.length ||
        !Array.isArray(input.materials) || input.materials.length > 30 || (input.skillEnabled !== undefined && typeof input.skillEnabled !== "boolean") ||
        (input.refresh !== undefined && typeof input.refresh !== "boolean")) invalid();
      const keys = new Set<string>();
      for (const ref of input.materials) {
        if (!ref || !input.vaultIds.includes(ref.vaultId) || !validRelative(ref.path)) invalid();
        const key = `${ref.vaultId}:${ref.path}`; if (keys.has(key)) invalid(); keys.add(key);
      }
      const files: string[] = [];
      try { return this.db.transaction(() => {
        const row = this.row(articleId)!, current = JSON.parse(row.context_json) as WritingContext;
        if (current.revision !== input.expectedRevision) throw new WritingContextError("REVISION_CONFLICT", 409);
        let next = row.next_id;
        const materials = input.materials.map(ref => {
          const existing = current.materials.find(m => m.vaultId === ref.vaultId && m.path === ref.path);
          if (existing && !input.refresh) return existing;
          const detail = this.source(ref, existing?.id ?? `S${next++}`);
          if (existing) detail.addedAt = existing.addedAt;
          const file = this.snapshot(articleId, detail); files.push(file);
          const metadata = materialMetadata(detail);
          this.db.prepare(`INSERT INTO writing_materials VALUES (?,?,?,?) ON CONFLICT(article_id,id) DO UPDATE SET material_json=excluded.material_json,snapshot_file=excluded.snapshot_file`)
            .run(articleId, detail.id, JSON.stringify(metadata), file);
          return metadata;
        });
        const context: WritingContext = { revision: current.revision + 1, vaultIds: [...input.vaultIds], materials, skillEnabled: input.skillEnabled ?? current.skillEnabled };
        this.db.prepare("UPDATE writing_contexts SET context_json=?,next_id=? WHERE article_id=?").run(JSON.stringify(context), next, articleId);
        if (JSON.stringify([current.vaultIds,current.materials,current.skillEnabled]) !== JSON.stringify([context.vaultIds,context.materials,context.skillEnabled])) this.revokeApproval(articleId);
        return context;
      })(); } catch (error) { for (const file of files) rmSync(join(this.root(articleId), file), { force: true }); throw error; }
    });
  }
  async material(articleId: string, materialId: string, turnId?: string): Promise<WritingMaterialDetail> {
    return this.articles.withActivity(articleId, async () => {
      await this.get(articleId);
      if (!/^S[1-9]\d*$/.test(materialId)) throw new WritingContextError("WRITING_MATERIAL_NOT_FOUND", 404);
      let file: string | undefined;
      if (turnId !== undefined) {
        const row = this.turnRow(articleId, turnId);
        file = (JSON.parse(row.snapshots_json) as Record<string, string>)[materialId];
      } else file = (this.db.prepare("SELECT snapshot_file FROM writing_materials WHERE article_id=? AND id=?").get(articleId, materialId) as MaterialRow | undefined)?.snapshot_file;
      if (!file) throw new WritingContextError("WRITING_MATERIAL_NOT_FOUND", 404);
      return this.readSnapshot(articleId, file);
    });
  }
  private turnRow(articleId: string, turnId: string): { turn_json: string; snapshots_json: string } {
    const row = this.db.prepare("SELECT turn_json,snapshots_json FROM writing_turns WHERE article_id=? AND id=?").get(articleId, turnId) as { turn_json: string; snapshots_json: string } | undefined;
    if (!row) throw new WritingContextError("WRITING_TURN_NOT_FOUND", 404); return row;
  }
  async turn(articleId: string, turnId: string): Promise<WritingTurnContext> {
    await this.articles.get(articleId); return JSON.parse(this.turnRow(articleId, turnId).turn_json) as WritingTurnContext;
  }
  async createTurn(articleId: string, selections: WritingSelection[]): Promise<WritingTurnContext> {
    return this.articles.withActivity(articleId, async () => {
      await this.get(articleId);
      return this.db.transaction(() => {
        const context = this.current(articleId);
        if (!Array.isArray(selections) || selections.length > 30 || new Set(selections.map(s => s?.materialId)).size !== selections.length) throw new WritingContextError("INVALID_WRITING_SELECTION", 422);
        let bytes = 0; const snapshots: Record<string, string> = {};
        const sources = selections.map(selection => {
          const source = context.materials.find(m => m.id === selection?.materialId);
          if (!source) throw new WritingContextError("INVALID_WRITING_SELECTION", 422);
          const row = this.db.prepare("SELECT snapshot_file FROM writing_materials WHERE article_id=? AND id=?").get(articleId, source.id) as MaterialRow;
          const detail = this.readSnapshot(articleId, row.snapshot_file);
          const lineCount = detail.markdown.split(/\r?\n/).length;
          const { startLine, endLine } = selection;
          if ((startLine !== undefined && (!Number.isInteger(startLine) || startLine < 1 || startLine > lineCount)) ||
            (endLine !== undefined && (!Number.isInteger(endLine) || endLine < 1 || endLine > lineCount)) ||
            (startLine !== undefined && endLine !== undefined && startLine > endLine)) throw new WritingContextError("INVALID_WRITING_SELECTION", 422);
          bytes += Buffer.byteLength(detail.markdown); snapshots[source.id] = row.snapshot_file;
          return { ...source, ...(startLine === undefined ? {} : { startLine }), ...(endLine === undefined ? {} : { endLine }) };
        });
        if (bytes > maxTurnBytes) throw new WritingContextError("WRITING_CONTEXT_TOO_LARGE", 422);
        const outline = this.readOutline(articleId);
        const turn: WritingTurnContext = { id: randomUUID(), createdAt: new Date().toISOString(), sources,
          vaultIds: [...context.vaultIds], skillRequested: context.skillEnabled, outlineRevision: outline.approved ? outline.revision : null };
        this.db.prepare("INSERT INTO writing_turns VALUES (?,?,?,?)").run(articleId, turn.id, JSON.stringify(turn), JSON.stringify(snapshots));
        return turn;
      })();
    });
  }
  private readOutline(articleId: string): WritingOutline {
    const row = this.db.prepare("SELECT outline_json FROM writing_outlines WHERE article_id=?").get(articleId) as { outline_json: string } | undefined;
    return row ? JSON.parse(row.outline_json) as WritingOutline : { revision: 0, markdown: "", approved: false, updatedAt: null };
  }
  private writeOutline(articleId: string, outline: WritingOutline): WritingOutline {
    this.db.prepare("INSERT INTO writing_outlines VALUES (?,?) ON CONFLICT(article_id) DO UPDATE SET outline_json=excluded.outline_json").run(articleId, JSON.stringify(outline)); return outline;
  }
  private revokeApproval(articleId: string): void {
    const outline = this.readOutline(articleId);
    // Advance even unapproved outlines so tabs holding a pre-context view cannot approve it.
    this.writeOutline(articleId, { ...outline, revision: outline.revision + 1, approved: false, updatedAt: new Date().toISOString() });
  }
  async outline(articleId: string): Promise<WritingOutline> { await this.articles.get(articleId); return this.readOutline(articleId); }
  async saveOutline(articleId: string, markdown: string, expectedRevision: number): Promise<WritingOutline> {
    return this.articles.withActivity(articleId, async () => {
      if (typeof markdown !== "string" || markdown.length > 100_000 || !Number.isInteger(expectedRevision) || expectedRevision < 0) throw new WritingContextError("INVALID_WRITING_OUTLINE", 422);
      return this.db.transaction(() => {
        const current = this.readOutline(articleId); if (current.revision !== expectedRevision) throw new WritingContextError("REVISION_CONFLICT", 409);
        return this.writeOutline(articleId, { revision: current.revision + 1, markdown, approved: false, updatedAt: new Date().toISOString() });
      })();
    });
  }
  async approveOutline(articleId: string, expectedRevision: number): Promise<WritingOutline> {
    return this.articles.withActivity(articleId, async () => this.db.transaction(() => {
      const current = this.readOutline(articleId);
      if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new WritingContextError("INVALID_WRITING_OUTLINE", 422);
      if (current.revision !== expectedRevision) throw new WritingContextError("REVISION_CONFLICT", 409);
      if (!current.markdown.trim()) throw new WritingContextError("INVALID_WRITING_OUTLINE", 422);
      return this.writeOutline(articleId, { ...current, approved: true });
    })());
  }
  skillStatus(): WriterSkillStatus {
    const path = this.articles.writerSkillPath();
    try {
      if (lstatSync(path).isSymbolicLink() || !statSync(path).isFile() || statSync(path).size > maxFileBytes) throw new Error("unavailable");
      const text = readFileSync(path, "utf8");
      if (!text.trim()) throw new Error("empty");
      return { available: true, name: "tech-article-writer", path };
    } catch { return { available: false, name: "tech-article-writer", path: null, reason: "SKILL_NOT_AVAILABLE" }; }
  }
}
