import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { runTool } from "../process/run.js";
import type { VaultRegistry } from "../vaults/registry.js";

export interface SourceRef { vaultId: string; snapshot: string }
export interface ArticleInput { title: string; summary: string; date: string; sourceRef: SourceRef | null }
export type ArticleCreateInput = Partial<ArticleInput>;
export interface ArticleDraftInput { markdown?: unknown; title?: unknown; summary?: unknown; date?: unknown; sourceRef?: unknown }
export interface ArticleState extends ArticleInput {
  id: string;
  revision: number;
  status: "draft" | "final";
  markdown: string;
}
export interface ArticleListItem extends ArticleInput {
  id: string;
  revision: number;
  status: ArticleState["status"];
  stage: "new" | "writing" | "complete" | "pending_publish" | "published";
  updatedAt: string;
  publicationId: string | null;
  trashedAt: string | null;
}

export class ArticleError extends Error {
  constructor(readonly code: "INVALID_ARTICLE" | "SOURCE_NOT_FOUND" | "ARTICLE_NOT_FOUND" | "ARTICLE_TRASHED" | "ARTICLE_TRASH_CHANGED" | "ARTICLE_BUSY" | "REVISION_CONFLICT" | "ARTICLE_CHECK_FAILED" | "ARTICLE_METADATA_REQUIRED", readonly statusCode: number) {
    super(code);
  }
}

const defaultWriterRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../open-context-forge-tech-article-writer");

function yaml(value: string): string {
  return `'${value.replace(/[\r\n]+/g, " ").replaceAll("'", "''")}'`;
}

function renderArticle(input: ArticleInput, markdown: string, status: "draft" | "final"): string {
  return [
    "---",
    `title: ${yaml(input.title)}`,
    `summary: ${yaml(input.summary)}`,
    `date: ${yaml(input.date)}`,
    `status: ${status === "final" ? "reviewed" : "draft"}`,
    `draft: ${status === "final" ? "false" : "true"}`,
    "---",
    "",
    markdown.trimEnd(),
    "",
  ].join("\n");
}

function bodyOf(article: string): string {
  const match = article.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  return match ? article.slice(match[0].length).trim() : article.trim();
}

function draftText(value: unknown, maxLength: number): string {
  if (typeof value !== "string" || value.length > maxLength) throw new ArticleError("INVALID_ARTICLE", 422);
  return value.trim();
}

function draftDate(value: unknown): string {
  if (typeof value !== "string" || (value !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(value))) {
    throw new ArticleError("INVALID_ARTICLE", 422);
  }
  return value;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, content, { flag: "wx" });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

export class ArticleStore {
  private readonly root: string;
  private readonly writerRoot: string;
  private readonly activities = new Map<string, number>();
  private cleaning: Promise<void> | undefined;

  constructor(private readonly db: Database.Database, private readonly dataDir: string, private readonly vaults: VaultRegistry, writerRoot?: string) {
    this.root = join(dataDir, "writing-projects");
    this.writerRoot = realpathSync(writerRoot ?? defaultWriterRoot);
    db.exec(`
      CREATE TABLE IF NOT EXISTS articles (
        id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS article_deletions (
        id TEXT PRIMARY KEY, publication_ids TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS retained_publication_worktrees (
        publication_id TEXT PRIMARY KEY, article_id TEXT NOT NULL, worktree_path TEXT NOT NULL,
        commit_sha TEXT, status TEXT NOT NULL, public_url TEXT, archived_at TEXT NOT NULL
      );
    `);
    const columns = db.pragma("table_info(articles)") as { name: string }[];
    if (!columns.some((column) => column.name === "trashed_at")) db.exec("ALTER TABLE articles ADD COLUMN trashed_at TEXT");
  }

  public writerSkillPath(): string { return join(this.writerRoot, "SKILL.md"); }

  async withActivity<T>(id: string, work: () => Promise<T>): Promise<T> {
    const row = this.db.prepare("SELECT trashed_at FROM articles WHERE id = ?").get(id) as { trashed_at: string | null } | undefined;
    if (!row) throw new ArticleError("ARTICLE_NOT_FOUND", 404);
    if (row.trashed_at) throw new ArticleError("ARTICLE_TRASHED", 409);
    this.activities.set(id, (this.activities.get(id) ?? 0) + 1);
    try { return await work(); }
    finally {
      const remaining = (this.activities.get(id) ?? 1) - 1;
      if (remaining) this.activities.set(id, remaining); else this.activities.delete(id);
    }
  }

  async cleanupDeletedArticles(): Promise<number> {
    // The durable queue makes an interrupted or failed filesystem cleanup retryable.
    const task = (this.cleaning ?? Promise.resolve()).then(async () => {
      const rows = this.db.prepare("SELECT id, publication_ids FROM article_deletions").all() as { id: string; publication_ids: string }[];
      for (const row of rows) {
        try {
          const publicationIds: unknown = JSON.parse(row.publication_ids);
          if (!Array.isArray(publicationIds) || publicationIds.some((id) => typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id))) throw new Error("INVALID_DELETION_PATH");
          const paths = [this.project(row.id), join(this.dataDir, "agent-workspaces", row.id),
            ...publicationIds.map((id) => join(this.dataDir, "publications", id))];
          await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
          this.db.prepare("DELETE FROM article_deletions WHERE id = ?").run(row.id);
        } catch (error) {
          console.error("[article-trash] cleanup_pending", { articleId: row.id, code: error instanceof Error && "code" in error ? error.code : "CLEANUP_FAILED" });
        }
      }
    });
    this.cleaning = task;
    try { await task; } finally { if (this.cleaning === task) this.cleaning = undefined; }
    return (this.db.prepare("SELECT COUNT(*) AS count FROM article_deletions").get() as { count: number }).count;
  }

  async emptyTrash(confirmed: unknown, items: unknown, isBusy: (id: string) => boolean = () => false): Promise<{ changed: number; cleanupPending: number; retainedWorkspaces: number }> {
    if (confirmed !== true || !Array.isArray(items) || items.length > 10_000 || items.some((item) => !item ||
      typeof item.id !== "string" || !/^[0-9a-f-]{36}$/.test(item.id) || !Number.isInteger(item.expectedRevision) || item.expectedRevision < 0 ||
      typeof item.expectedTrashedAt !== "string" || !item.expectedTrashedAt) || new Set(items.map((item) => item.id)).size !== items.length) {
      throw new ArticleError("INVALID_ARTICLE", 422);
    }
    const result = this.db.transaction(() => {
      const find = this.db.prepare("SELECT revision, trashed_at FROM articles WHERE id = ?");
      for (const item of items) {
        const row = find.get(item.id) as { revision: number; trashed_at: string | null } | undefined;
        if (!row || !row.trashed_at || row.revision !== item.expectedRevision || row.trashed_at !== item.expectedTrashedAt) throw new ArticleError("ARTICLE_TRASH_CHANGED", 409);
        if (this.activities.has(item.id) || isBusy(item.id)) throw new ArticleError("ARTICLE_BUSY", 409);
      }
      let retainedWorkspaces = 0;
      for (const item of items) {
        const publications = this.db.prepare("SELECT id FROM publications WHERE article_id = ?").all(item.id) as { id: string }[];
        this.db.prepare("INSERT INTO article_deletions (id, publication_ids) VALUES (?, ?)").run(item.id, JSON.stringify(publications.map((item) => item.id)));
        // A Git checkout may contain unpushed work; retain it and its ownership independently of the deleted article.
        retainedWorkspaces += this.db.prepare(`INSERT INTO retained_publication_worktrees
          (publication_id, article_id, worktree_path, commit_sha, status, public_url, archived_at)
          SELECT id, article_id, worktree_path, commit_sha, status, public_url, ? FROM publications
          WHERE article_id = ? AND worktree_path IS NOT NULL`).run(new Date().toISOString(), item.id).changes;
        this.db.prepare("DELETE FROM agent_run_events WHERE run_id IN (SELECT id FROM agent_runs WHERE article_id = ?)").run(item.id);
        this.db.prepare("DELETE FROM agent_runs WHERE article_id = ?").run(item.id);
        this.db.prepare("DELETE FROM agent_messages WHERE conversation_id IN (SELECT id FROM agent_conversations WHERE article_id = ?)").run(item.id);
        this.db.prepare("DELETE FROM agent_conversations WHERE article_id = ?").run(item.id);
        this.db.prepare("DELETE FROM publications WHERE article_id = ?").run(item.id);
        this.db.prepare("DELETE FROM articles WHERE id = ?").run(item.id);
      }
      return { changed: items.length, retainedWorkspaces };
    })();
    return { ...result, cleanupPending: await this.cleanupDeletedArticles() };
  }

  private project(id: string): string {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new ArticleError("ARTICLE_NOT_FOUND", 404);
    return join(this.root, id);
  }

  private validateSource(sourceRef: SourceRef): void {
    if (!sourceRef || typeof sourceRef.vaultId !== "string" || typeof sourceRef.snapshot !== "string" ||
      isAbsolute(sourceRef.snapshot) || sourceRef.snapshot.startsWith("..")) throw new ArticleError("SOURCE_NOT_FOUND", 422);
    const vault = this.vaults.get(sourceRef.vaultId);
    if (!vault) throw new ArticleError("SOURCE_NOT_FOUND", 422);
    const target = resolve(vault.path, sourceRef.snapshot);
    const rel = relative(vault.path, target);
    if (!rel || rel.startsWith("..") || rel.includes(`${sep}..${sep}`) || !existsSync(target) ||
      !realpathSync(target).startsWith(`${vault.path}${sep}`)) throw new ArticleError("SOURCE_NOT_FOUND", 422);
  }

  async create(input: ArticleCreateInput = {}, initialize?: (id: string) => void): Promise<ArticleState> {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new ArticleError("INVALID_ARTICLE", 422);
    const title = draftText(input.title ?? "", 300);
    const summary = draftText(input.summary ?? "", 2_000);
    const date = draftDate(input.date ?? "");
    const sourceRef = input.sourceRef ?? null;
    if (sourceRef) this.validateSource(sourceRef);
    const id = randomUUID();
    const project = this.project(id);
    const markdown = title ? `# ${title}` : "";
    const state: ArticleState = { id, revision: 0, status: "draft", markdown: markdown.trim(),
      title, summary, date, sourceRef };
    const article = renderArticle(state, markdown, "draft");
    try {
      await mkdir(join(project, "versions"), { recursive: true });
      await writeFile(join(project, "project.json"), `${JSON.stringify({ title: state.title, summary: state.summary, date: state.date, sourceRef: state.sourceRef }, null, 2)}\n`, { flag: "wx" });
      await writeFile(join(project, "versions", "0.md"), article, { flag: "wx" });
      await atomicWrite(join(project, "article.md"), article);
      this.db.transaction(() => {
        this.db.prepare("INSERT INTO articles (id, revision, status) VALUES (?, 0, 'draft')").run(id);
        initialize?.(id);
      })();
      return state;
    } catch (error) {
      await rm(project, { recursive: true, force: true });
      throw error;
    }
  }

  async get(id: string, includeTrashed = false): Promise<ArticleState> {
    const row = this.db.prepare("SELECT revision, status, trashed_at FROM articles WHERE id = ?").get(id) as { revision: number; status: "draft" | "final"; trashed_at: string | null } | undefined;
    if (!row) throw new ArticleError("ARTICLE_NOT_FOUND", 404);
    if (row.trashed_at && !includeTrashed) throw new ArticleError("ARTICLE_TRASHED", 409);
    const project = this.project(id);
    const input = JSON.parse(await readFile(join(project, "project.json"), "utf8")) as ArticleInput;
    const markdown = bodyOf(await readFile(join(project, "article.md"), "utf8"));
    return { id, revision: row.revision, status: row.status, markdown, ...input,
      title: input.title ?? "", summary: input.summary ?? "", date: input.date ?? "", sourceRef: input.sourceRef ?? null };
  }

  async list(includeTrashed = false): Promise<ArticleListItem[]> {
    const rows = this.db.prepare(`SELECT id, revision, status, trashed_at FROM articles ${includeTrashed ? "" : "WHERE trashed_at IS NULL"} ORDER BY rowid DESC`)
      .all() as { id: string; revision: number; status: ArticleState["status"]; trashed_at: string | null }[];
    const publicationRows = this.db.prepare("SELECT id, article_id, revision, status FROM publications ORDER BY rowid DESC")
      .all() as { id: string; article_id: string; revision: number; status: string }[];
    const items = await Promise.all(rows.map(async (row) => {
      const article = await this.get(row.id, true);
      const updatedAt = (await stat(join(this.project(row.id), "article.md"))).mtime.toISOString();
      const current = publicationRows.filter((publication) => publication.article_id === row.id && publication.revision === row.revision);
      const publication = current.find((item) => item.status === "live") ??
        current.find((item) => ["prepared", "written-to-repository", "deployment-pending"].includes(item.status)) ?? null;
      const stage: ArticleListItem["stage"] = row.status === "draft" ?
        (!article.markdown.trim() ? "new" : "writing") : publication?.status === "live" ? "published" :
          publication ? "pending_publish" : "complete";
      return { id: row.id, title: article.title, summary: article.summary, date: article.date,
        sourceRef: article.sourceRef, revision: row.revision, status: row.status,
        stage, updatedAt, publicationId: publication?.id ?? null, trashedAt: row.trashed_at };
    }));
    return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  manage(action: unknown, items: unknown): { changed: number } {
    if ((action !== "trash" && action !== "restore") || !Array.isArray(items) || !items.length || items.length > 1_000 ||
      items.some((item) => !item || typeof item.id !== "string" || !Number.isInteger(item.expectedRevision) || item.expectedRevision < 0) ||
      new Set(items.map((item) => item.id)).size !== items.length) throw new ArticleError("INVALID_ARTICLE", 422);
    return this.db.transaction(() => {
      const find = this.db.prepare("SELECT revision, trashed_at FROM articles WHERE id = ?");
      const selected = items.map((item) => {
        this.project(item.id);
        const row = find.get(item.id) as { revision: number; trashed_at: string | null } | undefined;
        if (!row) throw new ArticleError("ARTICLE_NOT_FOUND", 404);
        if (row.revision !== item.expectedRevision) throw new ArticleError("REVISION_CONFLICT", 409);
        return { id: item.id, trashed: !!row.trashed_at };
      });
      const update = this.db.prepare("UPDATE articles SET trashed_at = ? WHERE id = ?");
      const timestamp = new Date().toISOString();
      let changed = 0;
      for (const item of selected) {
        if (item.trashed === (action === "trash")) continue;
        update.run(action === "trash" ? timestamp : null, item.id); changed++;
      }
      return { changed };
    })();
  }

  async readAsset(id: string, path: unknown): Promise<Buffer> {
    await this.get(id);
    if (typeof path !== "string" || !path.startsWith("assets/") || path.includes("..") ||
      !/\.(?:png|jpe?g|gif|webp|svg|avif)$/i.test(path)) throw new ArticleError("ARTICLE_NOT_FOUND", 404);
    const project = this.project(id);
    const target = resolve(project, path);
    const rel = relative(project, target);
    if (!rel.startsWith(`assets${sep}`) || !existsSync(target) ||
      !realpathSync(target).startsWith(`${realpathSync(project)}${sep}`)) throw new ArticleError("ARTICLE_NOT_FOUND", 404);
    return readFile(target);
  }

  private async writeRevision(state: ArticleState, markdown: string, status: "draft" | "final"): Promise<ArticleState> {
    const project = this.project(state.id);
    const revision = state.revision + 1;
    const article = renderArticle(state, markdown, status);
    const versionFile = join(project, "versions", `${revision}.md`);
    const projectFile = join(project, "project.json");
    const previousProject = await readFile(projectFile, "utf8");
    const previousArticle = await readFile(join(project, "article.md"), "utf8");
    await writeFile(versionFile, article, { flag: "wx" });
    try {
      await atomicWrite(projectFile, `${JSON.stringify({ title: state.title, summary: state.summary,
        date: state.date, sourceRef: state.sourceRef }, null, 2)}\n`);
      await atomicWrite(join(project, "article.md"), article);
      this.db.prepare("UPDATE articles SET revision = ?, status = ? WHERE id = ?")
        .run(revision, status, state.id);
    } catch (error) {
      await atomicWrite(projectFile, previousProject);
      await atomicWrite(join(project, "article.md"), previousArticle);
      await rm(versionFile, { force: true });
      throw error;
    }
    return { ...state, revision, status, markdown: markdown.trim() };
  }

  async saveDraft(id: string, patch: ArticleDraftInput, expectedRevision: unknown): Promise<ArticleState> {
    return this.withActivity(id, () => this.saveDraftContent(id, patch, expectedRevision));
  }

  private async saveDraftContent(id: string, patch: ArticleDraftInput, expectedRevision: unknown): Promise<ArticleState> {
    const state = await this.get(id);
    if (state.revision !== expectedRevision) throw new ArticleError("REVISION_CONFLICT", 409);
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new ArticleError("INVALID_ARTICLE", 422);
    const markdown = patch.markdown === undefined ? state.markdown : patch.markdown;
    if (typeof markdown !== "string" || markdown.length > 500_000) throw new ArticleError("INVALID_ARTICLE", 422);
    const title = patch.title === undefined ? state.title : draftText(patch.title, 300);
    const summary = patch.summary === undefined ? state.summary : draftText(patch.summary, 2_000);
    const date = patch.date === undefined ? state.date : draftDate(patch.date);
    const sourceRef = patch.sourceRef === undefined ? state.sourceRef : patch.sourceRef;
    if (sourceRef !== null) this.validateSource(sourceRef as SourceRef);
    if (markdown.trim() === state.markdown && title === state.title && summary === state.summary &&
      date === state.date && JSON.stringify(sourceRef) === JSON.stringify(state.sourceRef)) return state;
    return this.writeRevision({ ...state, title, summary, date, sourceRef: sourceRef as SourceRef | null }, markdown, "draft");
  }

  async finalize(id: string, expectedRevision: unknown): Promise<ArticleState> {
    return this.withActivity(id, () => this.finalizeContent(id, expectedRevision));
  }

  private async finalizeContent(id: string, expectedRevision: unknown): Promise<ArticleState> {
    const state = await this.get(id);
    if (state.revision !== expectedRevision) throw new ArticleError("REVISION_CONFLICT", 409);
    if (state.status === "final") return state;
    if (!state.title.trim()) throw new ArticleError("ARTICLE_METADATA_REQUIRED", 422);
    if (!state.markdown.replace(/^#{1,6}\s+.*$/gm, "").trim()) {
      throw new ArticleError("ARTICLE_CHECK_FAILED", 422);
    }
    try {
      await runTool(process.execPath, [join(this.writerRoot, "scripts", "check-article.js"),
        "--file", join(this.project(id), "article.md"), "--json"],
      { cwd: this.writerRoot, timeoutMs: 60_000 });
    } catch {
      throw new ArticleError("ARTICLE_CHECK_FAILED", 422);
    }
    const today = new Date();
    const date = state.date || `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    return this.writeRevision({ ...state, date }, state.markdown, "final");
  }
}
