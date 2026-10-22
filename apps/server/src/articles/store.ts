import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { runTool } from "../process/run.js";
import type { VaultRegistry } from "../vaults/registry.js";

export interface SourceRef { vaultId: string; snapshot: string }
export interface ArticleInput { title: string; summary: string; date: string; sourceRef: SourceRef }
export interface ArticleState extends ArticleInput {
  id: string;
  revision: number;
  status: "draft" | "final";
  markdown: string;
}

export class ArticleError extends Error {
  constructor(readonly code: "INVALID_ARTICLE" | "SOURCE_NOT_FOUND" | "ARTICLE_NOT_FOUND" | "REVISION_CONFLICT" | "ARTICLE_CHECK_FAILED", readonly statusCode: number) {
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

  constructor(private readonly db: Database.Database, dataDir: string, private readonly vaults: VaultRegistry, writerRoot?: string) {
    this.root = join(dataDir, "writing-projects");
    this.writerRoot = realpathSync(writerRoot ?? defaultWriterRoot);
    db.exec(`
      CREATE TABLE IF NOT EXISTS articles (
        id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL
      );
    `);
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

  async create(input: ArticleInput): Promise<ArticleState> {
    if (typeof input?.title !== "string" || !input.title.trim() || typeof input.summary !== "string" || !input.summary.trim() ||
      typeof input.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new ArticleError("INVALID_ARTICLE", 422);
    this.validateSource(input.sourceRef);
    const id = randomUUID();
    const project = this.project(id);
    const markdown = `# ${input.title.trim()}\n\n`;
    const state: ArticleState = { id, revision: 0, status: "draft", markdown: markdown.trim(),
      title: input.title.trim(), summary: input.summary.trim(), date: input.date, sourceRef: input.sourceRef };
    const article = renderArticle(state, markdown, "draft");
    try {
      await mkdir(join(project, "versions"), { recursive: true });
      await writeFile(join(project, "project.json"), `${JSON.stringify({ title: state.title, summary: state.summary, date: state.date, sourceRef: state.sourceRef }, null, 2)}\n`, { flag: "wx" });
      await writeFile(join(project, "versions", "0.md"), article, { flag: "wx" });
      await atomicWrite(join(project, "article.md"), article);
      this.db.prepare("INSERT INTO articles (id, revision, status) VALUES (?, 0, 'draft')").run(id);
      return state;
    } catch (error) {
      await rm(project, { recursive: true, force: true });
      throw error;
    }
  }

  async get(id: string): Promise<ArticleState> {
    const row = this.db.prepare("SELECT revision, status FROM articles WHERE id = ?").get(id) as { revision: number; status: "draft" | "final" } | undefined;
    if (!row) throw new ArticleError("ARTICLE_NOT_FOUND", 404);
    const project = this.project(id);
    const input = JSON.parse(await readFile(join(project, "project.json"), "utf8")) as ArticleInput;
    const markdown = bodyOf(await readFile(join(project, "article.md"), "utf8"));
    return { id, revision: row.revision, status: row.status, markdown, ...input };
  }

  private async writeRevision(state: ArticleState, markdown: string, status: "draft" | "final"): Promise<ArticleState> {
    const project = this.project(state.id);
    const revision = state.revision + 1;
    const article = renderArticle(state, markdown, status);
    const versionFile = join(project, "versions", `${revision}.md`);
    await writeFile(versionFile, article, { flag: "wx" });
    try {
      await atomicWrite(join(project, "article.md"), article);
      this.db.prepare("UPDATE articles SET revision = ?, status = ? WHERE id = ?")
        .run(revision, status, state.id);
    } catch (error) {
      await rm(versionFile, { force: true });
      throw error;
    }
    return { ...state, revision, status, markdown: markdown.trim() };
  }

  async saveDraft(id: string, markdown: unknown, expectedRevision: unknown): Promise<ArticleState> {
    const state = await this.get(id);
    if (state.revision !== expectedRevision) throw new ArticleError("REVISION_CONFLICT", 409);
    if (typeof markdown !== "string" || !markdown.trim()) throw new ArticleError("INVALID_ARTICLE", 422);
    return this.writeRevision(state, markdown, "draft");
  }

  async finalize(id: string, expectedRevision: unknown): Promise<ArticleState> {
    const state = await this.get(id);
    if (state.revision !== expectedRevision) throw new ArticleError("REVISION_CONFLICT", 409);
    if (state.status === "final") return state;
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
    return this.writeRevision(state, state.markdown, "final");
  }
}
