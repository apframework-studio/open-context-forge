import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { createApp } from "../app.js";

const maintainerRoot = resolve(process.cwd(), "../../../open-context-forge-vault-maintainer");
const writerRoot = resolve(process.cwd(), "../../../open-context-forge-tech-article-writer");
const publisherRoot = resolve(process.cwd(), "../../../open-context-forge-article-publisher");

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function setup(failBuild = false, publicHtml = "<html><title>我的文章</title><main>这段内容有来源。</main></html>") {
  const root = mkdtempSync(join(tmpdir(), "ocf-deploy-"));
  const remote = join(root, "remote.git");
  mkdirSync(remote);
  git(root, "init", "--bare", "-b", "main", remote);
  const blogRoot = join(root, "blog");
  git(root, "clone", remote, blogRoot);
  git(blogRoot, "config", "user.name", "OCF Test");
  git(blogRoot, "config", "user.email", "ocf@example.test");
  mkdirSync(join(blogRoot, ".yarn", "releases"), { recursive: true });
  writeFileSync(join(blogRoot, ".yarn", "releases", "yarn-3.6.1.cjs"),
    "const fs=require('node:fs'); if(process.argv[2]==='build' && fs.existsSync('.fail-build')) process.exit(2);\n");
  writeFileSync(join(blogRoot, "README.md"), "# Blog fixture\n");
  if (failBuild) writeFileSync(join(blogRoot, ".fail-build"), "1");
  git(blogRoot, "add", ".");
  git(blogRoot, "commit", "-m", "fixture");
  git(blogRoot, "push", "origin", "main");
  const beforeHead = git(remote, "rev-parse", "refs/heads/main");

  const dataDir = join(root, "app");
  const app = createApp({
    dataDir, maintainerRoot, writerRoot, publisherRoot, blogRoot,
    publicOrigin: "https://apframework.example",
    verifyFetch: async () => new Response(publicHtml, { status: 200 }),
  });
  await app.inject({ method: "GET", url: "/api/v1/vaults" });
  writeFileSync(join(dataDir, "vaults", "default", "raw", "sources", "source.md"), "# 来源\n\n可回查的依据。\n");
  const created = await app.inject({ method: "POST", url: "/api/v1/articles", headers: { "x-ocf-client": "1" },
    payload: { title: "我的文章", summary: "发布前的简要说明", date: "2026-10-22", sourceRef: { vaultId: "default", snapshot: "raw/sources/source.md" } } });
  const articleId = created.json().id as string;
  await app.inject({ method: "PUT", url: `/api/v1/articles/${articleId}/draft`, headers: { "x-ocf-client": "1" },
    payload: { markdown: "# 我的文章\n\n这段内容有来源。", expectedRevision: 0 } });
  await app.inject({ method: "POST", url: `/api/v1/articles/${articleId}/finalize`, headers: { "x-ocf-client": "1" }, payload: { expectedRevision: 1 } });
  const prepared = await app.inject({ method: "POST", url: `/api/v1/articles/${articleId}/publications/prepare`, headers: { "x-ocf-client": "1" }, payload: { slug: "my-article" } });
  expect(prepared.statusCode).toBe(201);
  return { root, remote, blogRoot, app, articleId, publication: prepared.json(), beforeHead };
}

function publishRequest(publication: { id: string; revision: number; articlePath: string }, overrides: Record<string, unknown> = {}) {
  return { method: "POST" as const, url: `/api/v1/publications/${publication.id}/publish`,
    headers: { "x-ocf-client": "1" }, payload: { confirmedRevision: publication.revision, confirmedArticlePath: publication.articlePath, ...overrides } };
}

test("rejects confirmation that does not match the reviewed package", async () => {
  const fixture = await setup();
  try {
    const response = await fixture.app.inject(publishRequest(fixture.publication, { confirmedRevision: 1 }));
    expect(response.statusCode).toBe(409);
    expect(git(fixture.remote, "rev-parse", "refs/heads/main")).toBe(fixture.beforeHead);
  } finally { await fixture.app.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("publishes from an isolated worktree without changing dirty source checkout", async () => {
  const fixture = await setup();
  try {
    writeFileSync(join(fixture.blogRoot, "README.md"), "# Local changes stay here\n");
    const response = await fixture.app.inject(publishRequest(fixture.publication));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "deployment-pending" });
    expect(git(fixture.remote, "rev-parse", "refs/heads/main")).not.toBe(fixture.beforeHead);
    expect(git(fixture.remote, "ls-tree", "-r", "--name-only", "main")).toContain(fixture.publication.articlePath);
    expect(readFileSync(join(fixture.blogRoot, "README.md"), "utf8")).toBe("# Local changes stay here\n");
    const repeated = await fixture.app.inject(publishRequest(fixture.publication));
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json().commitSha).toBe(response.json().commitSha);
  } finally { await fixture.app.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("a failed isolated build never pushes to the remote", async () => {
  const fixture = await setup(true);
  try {
    const response = await fixture.app.inject(publishRequest(fixture.publication));
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ error: "BLOG_BUILD_FAILED" });
    expect(git(fixture.remote, "rev-parse", "refs/heads/main")).toBe(fixture.beforeHead);
    expect(existsSync(join(fixture.root, "app", "publications", fixture.publication.id, "publication.json"))).toBe(true);
  } finally { await fixture.app.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("public URL must contain the reviewed title and body before status becomes live", async () => {
  const fixture = await setup();
  try {
    await fixture.app.inject(publishRequest(fixture.publication));
    const url = `/api/v1/publications/${fixture.publication.id}/verify`;
    const mismatch = await fixture.app.inject({ method: "POST", url, headers: { "x-ocf-client": "1" }, payload: { publicUrl: "https://other.example/post", confirmedLayout: true } });
    expect(mismatch.statusCode).toBe(422);
    const verified = await fixture.app.inject({ method: "POST", url, headers: { "x-ocf-client": "1" }, payload: { publicUrl: "https://apframework.example/blog/essay/2026-10-22-my-article", confirmedLayout: true } });
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toMatchObject({ status: "live", publicUrl: "https://apframework.example/blog/essay/2026-10-22-my-article" });
  } finally { await fixture.app.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test("matching URL without the reviewed body remains pending", async () => {
  const fixture = await setup(false, "<html><title>我的文章</title><main>其他内容</main></html>");
  try {
    await fixture.app.inject(publishRequest(fixture.publication));
    const response = await fixture.app.inject({ method: "POST", url: `/api/v1/publications/${fixture.publication.id}/verify`, headers: { "x-ocf-client": "1" },
      payload: { publicUrl: "https://apframework.example/blog/essay/2026-10-22-my-article", confirmedLayout: true } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "VERIFY_FAILED" });
    const current = await fixture.app.inject({ method: "GET", url: `/api/v1/articles/${fixture.articleId}/publications/${fixture.publication.id}` });
    expect(current.json().status).toBe("deployment-pending");
  } finally { await fixture.app.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});
