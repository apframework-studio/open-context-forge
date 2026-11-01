import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { ArticleStore } from "../articles/store.js";
import { runTool } from "../process/run.js";
import { PublicationStore, type Publication } from "./publisher.js";

export class BlogDeployError extends Error {
  constructor(readonly code: "BLOG_NOT_CONFIGURED" | "CONFIRMATION_MISMATCH" | "PUBLICATION_STALE" |
    "BLOG_PREPARE_FAILED" | "BLOG_BUILD_FAILED" | "BLOG_DIFF_UNEXPECTED" |
    "BLOG_COMMIT_FAILED" | "BLOG_PUSH_FAILED" | "VERIFY_FAILED" | "INVALID_PUBLIC_URL", readonly statusCode: number) {
    super(code);
  }
}

export interface BlogDeployOptions {
  blogRoot?: string;
  publisherRoot?: string;
  publicOrigin?: string;
  verifyFetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

const defaultPublisherRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../../open-context-forge-article-publisher");

function pathSet(output: string): Set<string> {
  return new Set(output.split("\0").filter(Boolean));
}

function statusPaths(output: string): Set<string> {
  const entries = output.split("\0").filter(Boolean);
  if (entries.some((entry) => !entry.startsWith("?? "))) throw new BlogDeployError("BLOG_DIFF_UNEXPECTED", 409);
  return new Set(entries.map((entry) => entry.slice(3)));
}

function samePaths(actual: Set<string>, expected: Set<string>): boolean {
  return actual.size === expected.size && [...actual].every((path) => expected.has(path));
}

function plain(value: string): string {
  return value.replace(/<[^>]*>/g, "").replace(/[#*_`\[\]()]/g, "").replace(/\s+/g, "");
}

export class BlogDeploy {
  private readonly blogRoot?: string;
  private readonly publisherRoot: string;
  private readonly publicOrigin: string;
  private readonly verifyFetch: NonNullable<BlogDeployOptions["verifyFetch"]>;

  constructor(private readonly db: Database.Database, private readonly dataDir: string,
    private readonly publications: PublicationStore, private readonly articles: ArticleStore, options: BlogDeployOptions) {
    this.blogRoot = options.blogRoot ? realpathSync(options.blogRoot) : undefined;
    this.publisherRoot = realpathSync(options.publisherRoot ?? defaultPublisherRoot);
    this.publicOrigin = options.publicOrigin ?? "https://apframework.com";
    this.verifyFetch = options.verifyFetch ?? fetch;
  }

  private async git(cwd: string, args: string[], timeoutMs = 60_000): Promise<string> {
    return (await runTool("git", args, { cwd, timeoutMs })).stdout.trim();
  }

  private update(id: string, status: string, fields: { errorCode?: string | null; commitSha?: string; worktreePath?: string; publicUrl?: string } = {}): void {
    this.db.prepare(`
      UPDATE publications SET status = ?, error_code = ?,
        commit_sha = COALESCE(?, commit_sha), worktree_path = COALESCE(?, worktree_path),
        public_url = COALESCE(?, public_url) WHERE id = ?
    `).run(status, fields.errorCode ?? null, fields.commitSha ?? null, fields.worktreePath ?? null, fields.publicUrl ?? null, id);
  }

  async publish(id: string, confirmedRevision: unknown, confirmedArticlePath: unknown): Promise<Publication> {
    const publication = await this.publications.getById(id);
    return this.articles.withActivity(publication.articleId, () => this.publishPackage(publication, confirmedRevision, confirmedArticlePath));
  }

  private async publishPackage(publication: Publication, confirmedRevision: unknown, confirmedArticlePath: unknown): Promise<Publication> {
    const id = publication.id;
    if (publication.revision !== confirmedRevision || publication.articlePath !== confirmedArticlePath) {
      throw new BlogDeployError("CONFIRMATION_MISMATCH", 409);
    }
    if (publication.status === "stale") throw new BlogDeployError("PUBLICATION_STALE", 409);
    if (publication.status === "deployment-pending" || publication.status === "live") return publication;
    if (!this.blogRoot) throw new BlogDeployError("BLOG_NOT_CONFIGURED", 503);

    if (publication.status === "written-to-repository") {
      const row = this.db.prepare("SELECT worktree_path FROM publications WHERE id = ?").get(id) as { worktree_path: string };
      try {
        await this.git(row.worktree_path, ["push", "origin", "HEAD:main"], 120_000);
      } catch {
        throw new BlogDeployError("BLOG_PUSH_FAILED", 502);
      }
      this.update(id, "deployment-pending");
      return this.publications.getById(id);
    }

    const worktree = join(this.dataDir, "blog-worktrees", `${id}-${randomUUID()}`);
    try {
      await mkdir(join(this.dataDir, "blog-worktrees"), { recursive: true });
      await this.git(this.blogRoot, ["fetch", "origin", "main"], 120_000);
      await this.git(this.blogRoot, ["worktree", "add", "--detach", worktree, "origin/main"], 120_000);
      const project = join(this.dataDir, "writing-projects", publication.articleId);
      const reportRaw = await runTool(process.execPath, [join(this.publisherRoot, "scripts", "publish.mjs"),
        "--project", project, "--channel", "apframework", "--blog-root", worktree,
        "--slug", publication.slug, "--json"], { cwd: this.publisherRoot, timeoutMs: 60_000 });
      const report = JSON.parse(reportRaw.stdout) as { article?: string; assets?: string[]; sourceSha256?: string };
      const expected = new Set([publication.articlePath, ...publication.assets]);
      if (report.sourceSha256 !== publication.sourceSha256 ||
        relative(worktree, report.article ?? "") !== publication.articlePath ||
        !Array.isArray(report.assets) || !samePaths(new Set(report.assets.map((asset) => relative(worktree, asset))), new Set(publication.assets))) {
        throw new BlogDeployError("BLOG_DIFF_UNEXPECTED", 409);
      }
      this.update(id, "prepared", { worktreePath: worktree });
      await runTool(process.execPath, [".yarn/releases/yarn-3.6.1.cjs", "install", "--immutable"], { cwd: worktree, timeoutMs: 300_000 });
      await runTool(process.execPath, [".yarn/releases/yarn-3.6.1.cjs", "build"], { cwd: worktree, timeoutMs: 300_000 });
      const changed = statusPaths((await runTool("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: worktree, timeoutMs: 60_000 })).stdout);
      if (!samePaths(changed, expected)) throw new BlogDeployError("BLOG_DIFF_UNEXPECTED", 409);
      await this.git(worktree, ["add", "--", ...expected]);
      const staged = pathSet((await runTool("git", ["diff", "--cached", "--name-only", "-z"], { cwd: worktree, timeoutMs: 60_000 })).stdout);
      if (!samePaths(staged, expected)) throw new BlogDeployError("BLOG_DIFF_UNEXPECTED", 409);
      await this.git(worktree, ["commit", "-m", `Publish ${publication.slug}`]);
      const commitSha = await this.git(worktree, ["rev-parse", "HEAD"]);
      this.update(id, "written-to-repository", { commitSha, worktreePath: worktree });
    } catch (error) {
      const code = error instanceof BlogDeployError ? error.code : "BLOG_BUILD_FAILED";
      this.update(id, "prepared", { errorCode: code, worktreePath: worktree });
      if (error instanceof BlogDeployError) throw error;
      throw new BlogDeployError(code, 502);
    }
    try {
      await this.git(worktree, ["push", "origin", "HEAD:main"], 120_000);
    } catch {
      this.update(id, "written-to-repository", { errorCode: "BLOG_PUSH_FAILED" });
      throw new BlogDeployError("BLOG_PUSH_FAILED", 502);
    }
    this.update(id, "deployment-pending");
    return this.publications.getById(id);
  }

  async verify(id: string, publicUrl: unknown, confirmedLayout: unknown): Promise<Publication> {
    const publication = await this.publications.getById(id);
    return this.articles.withActivity(publication.articleId, () => this.verifyPublication(publication, publicUrl, confirmedLayout));
  }

  private async verifyPublication(publication: Publication, publicUrl: unknown, confirmedLayout: unknown): Promise<Publication> {
    const id = publication.id;
    if (publication.status !== "deployment-pending" && publication.status !== "live") {
      throw new BlogDeployError("VERIFY_FAILED", 409);
    }
    const article = await this.articles.get(publication.articleId);
    let url: URL;
    try { url = new URL(String(publicUrl)); }
    catch { throw new BlogDeployError("INVALID_PUBLIC_URL", 422); }
    const expectedPath = `/blog/essay/${article.date}-${publication.slug}`;
    if (url.origin !== this.publicOrigin || url.pathname !== expectedPath || url.search || url.hash || url.username || url.password || confirmedLayout !== true) {
      throw new BlogDeployError("INVALID_PUBLIC_URL", 422);
    }
    let response: Response;
    try {
      response = await this.verifyFetch(url.toString(), { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    } catch { throw new BlogDeployError("VERIFY_FAILED", 502); }
    if (response.status !== 200) throw new BlogDeployError("VERIFY_FAILED", 409);
    const html = plain(await response.text());
    const representative = article.markdown.split(/\r?\n/).map((line) => line.trim())
      .find((line) => line && !line.startsWith("#") && !line.startsWith("!["));
    if (!html.includes(plain(article.title)) || !representative || !html.includes(plain(representative).slice(0, 24))) {
      throw new BlogDeployError("VERIFY_FAILED", 409);
    }
    this.update(id, "live", { publicUrl: url.toString() });
    return this.publications.getById(id);
  }
}
