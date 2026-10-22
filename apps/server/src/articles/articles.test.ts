import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { createApp } from "../app.js";

const maintainerRoot = resolve(process.cwd(), "../../../open-context-forge-vault-maintainer");
const writerRoot = resolve(process.cwd(), "../../../open-context-forge-tech-article-writer");

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-article-"));
  const app = createApp({ dataDir, maintainerRoot, writerRoot });
  await app.inject({ method: "GET", url: "/api/v1/vaults" });
  const snapshot = "raw/sources/source.md";
  writeFileSync(join(dataDir, "vaults", "default", snapshot), "# 资料来源\n\n可回查的事实。\n");
  return { dataDir, app, sourceRef: { vaultId: "default", snapshot } };
}

async function createArticle(app: ReturnType<typeof createApp>, sourceRef: { vaultId: string; snapshot: string }) {
  return app.inject({
    method: "POST", url: "/api/v1/articles", headers: { "x-ocf-client": "1" },
    payload: { title: "我的文章", summary: "一篇有来源的文章", date: "2026-10-22", sourceRef },
  });
}

test("creates an inspectable article project with public metadata and source reference", async () => {
  const { dataDir, app, sourceRef } = await setup();
  try {
    const response = await createArticle(app, sourceRef);
    expect(response.statusCode).toBe(201);
    const article = response.json();
    expect(article).toMatchObject({ revision: 0, status: "draft", sourceRef });
    const project = join(dataDir, "writing-projects", article.id);
    expect(readFileSync(join(project, "article.md"), "utf8")).toContain("summary: '一篇有来源的文章'");
    expect(readFileSync(join(project, "article.md"), "utf8")).toContain("draft: true");
    expect(JSON.parse(readFileSync(join(project, "project.json"), "utf8")).sourceRef).toEqual(sourceRef);
    expect(existsSync(join(project, "versions", "0.md"))).toBe(true);
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("saving a draft creates a new revision and rejects a stale revision", async () => {
  const { dataDir, app, sourceRef } = await setup();
  try {
    const created = (await createArticle(app, sourceRef)).json();
    const url = `/api/v1/articles/${created.id}/draft`;
    const saved = await app.inject({ method: "PUT", url, headers: { "x-ocf-client": "1" }, payload: { markdown: "# 我的文章\n\n经过修改的正文。", expectedRevision: 0 } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ revision: 1, status: "draft" });
    const stale = await app.inject({ method: "PUT", url, headers: { "x-ocf-client": "1" }, payload: { markdown: "不应覆盖", expectedRevision: 0 } });
    expect(stale.statusCode).toBe(409);
    const project = join(dataDir, "writing-projects", created.id);
    expect(readFileSync(join(project, "versions", "1.md"), "utf8")).toBe(readFileSync(join(project, "article.md"), "utf8"));
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("finalizing a checked article preserves its revision and later edits return it to draft", async () => {
  const { dataDir, app, sourceRef } = await setup();
  try {
    const created = (await createArticle(app, sourceRef)).json();
    await app.inject({ method: "PUT", url: `/api/v1/articles/${created.id}/draft`, headers: { "x-ocf-client": "1" }, payload: { markdown: "# 我的文章\n\n可回查来源的判断。", expectedRevision: 0 } });
    const final = await app.inject({ method: "POST", url: `/api/v1/articles/${created.id}/finalize`, headers: { "x-ocf-client": "1" }, payload: { expectedRevision: 1 } });
    expect(final.statusCode).toBe(200);
    expect(final.json()).toMatchObject({ revision: 2, status: "final" });
    const project = join(dataDir, "writing-projects", created.id);
    const finalized = readFileSync(join(project, "versions", "2.md"), "utf8");
    expect(finalized).toContain("status: reviewed");
    expect(finalized).toContain("draft: false");
    const edited = await app.inject({ method: "PUT", url: `/api/v1/articles/${created.id}/draft`, headers: { "x-ocf-client": "1" }, payload: { markdown: "# 我的文章\n\n更新后的判断。", expectedRevision: 2 } });
    expect(edited.json()).toMatchObject({ revision: 3, status: "draft" });
    expect(readFileSync(join(project, "versions", "2.md"), "utf8")).toBe(finalized);
    expect(readFileSync(join(project, "article.md"), "utf8")).toContain("draft: true");
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("writer check blocks finalizing unfinished text", async () => {
  const { dataDir, app, sourceRef } = await setup();
  try {
    const created = (await createArticle(app, sourceRef)).json();
    await app.inject({ method: "PUT", url: `/api/v1/articles/${created.id}/draft`, headers: { "x-ocf-client": "1" }, payload: { markdown: "# 我的文章\n\nTODO: 核对这一句。", expectedRevision: 0 } });
    const final = await app.inject({ method: "POST", url: `/api/v1/articles/${created.id}/finalize`, headers: { "x-ocf-client": "1" }, payload: { expectedRevision: 1 } });
    expect(final.statusCode).toBe(422);
    expect(final.json()).toMatchObject({ error: "ARTICLE_CHECK_FAILED" });
    const read = await app.inject({ method: "GET", url: `/api/v1/articles/${created.id}` });
    expect(read.json()).toMatchObject({ revision: 1, status: "draft" });
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("a heading-only draft cannot be finalized", async () => {
  const { dataDir, app, sourceRef } = await setup();
  try {
    const created = (await createArticle(app, sourceRef)).json();
    const final = await app.inject({ method: "POST", url: `/api/v1/articles/${created.id}/finalize`, headers: { "x-ocf-client": "1" }, payload: { expectedRevision: 0 } });
    expect(final.statusCode).toBe(422);
    expect(final.json()).toMatchObject({ error: "ARTICLE_CHECK_FAILED" });
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("local preview can read an image inside the article project only", async () => {
  const { dataDir, app, sourceRef } = await setup();
  try {
    const created = (await createArticle(app, sourceRef)).json();
    const assets = join(dataDir, "writing-projects", created.id, "assets");
    mkdirSync(assets);
    writeFileSync(join(assets, "figure.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
    const good = await app.inject({ method: "GET", url: `/api/v1/articles/${created.id}/asset?path=assets%2Ffigure.svg` });
    expect(good.statusCode).toBe(200);
    expect(good.headers["content-type"]).toContain("image/svg+xml");
    const escaped = await app.inject({ method: "GET", url: `/api/v1/articles/${created.id}/asset?path=..%2F..%2Fsource.md` });
    expect(escaped.statusCode).toBe(404);
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});
