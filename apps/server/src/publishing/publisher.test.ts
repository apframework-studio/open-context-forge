import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { createApp } from "../app.js";

const maintainerRoot = resolve(process.cwd(), "../../../open-context-forge-vault-maintainer");
const writerRoot = resolve(process.cwd(), "../../../open-context-forge-tech-article-writer");
const publisherRoot = resolve(process.cwd(), "../../../open-context-forge-article-publisher");

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-publish-"));
  const app = createApp({ dataDir, maintainerRoot, writerRoot, publisherRoot });
  await app.inject({ method: "GET", url: "/api/v1/vaults" });
  writeFileSync(join(dataDir, "vaults", "default", "raw", "sources", "source.md"), "# 来源\n\n可回查的依据。\n");
  const created = await app.inject({
    method: "POST", url: "/api/v1/articles", headers: { "x-ocf-client": "1" },
    payload: { title: "我的文章", summary: "发布前的简要说明", date: "2026-10-22", sourceRef: { vaultId: "default", snapshot: "raw/sources/source.md" } },
  });
  expect(created.statusCode).toBe(201);
  return { dataDir, app, articleId: created.json().id as string };
}

async function draft(app: ReturnType<typeof createApp>, articleId: string, markdown: string, expectedRevision = 0) {
  return app.inject({ method: "PUT", url: `/api/v1/articles/${articleId}/draft`, headers: { "x-ocf-client": "1" }, payload: { markdown, expectedRevision } });
}

async function finalize(app: ReturnType<typeof createApp>, articleId: string, expectedRevision = 1) {
  return app.inject({ method: "POST", url: `/api/v1/articles/${articleId}/finalize`, headers: { "x-ocf-client": "1" }, payload: { expectedRevision } });
}

async function prepare(app: ReturnType<typeof createApp>, articleId: string) {
  return app.inject({ method: "POST", url: `/api/v1/articles/${articleId}/publications/prepare`, headers: { "x-ocf-client": "1" }, payload: { slug: "my-article" } });
}

test("draft articles cannot produce a publication package", async () => {
  const { dataDir, app, articleId } = await setup();
  try {
    const response = await prepare(app, articleId);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "ARTICLE_NOT_FINAL" });
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("final article prepares a portable MDX package with copied local image", async () => {
  const { dataDir, app, articleId } = await setup();
  try {
    const project = join(dataDir, "writing-projects", articleId);
    mkdirSync(join(project, "assets"));
    writeFileSync(join(project, "assets", "diagram.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
    await draft(app, articleId, "# 我的文章\n\n这段内容有来源。\n\n![图示](assets/diagram.svg)");
    const finalized = await finalize(app, articleId);
    expect(finalized.statusCode).toBe(200);
    const response = await prepare(app, articleId);
    expect(response.statusCode).toBe(201);
    const publication = response.json();
    expect(publication).toMatchObject({ status: "prepared", revision: 2, slug: "my-article", articlePath: "data/blog/essay/2026-10-22-my-article.mdx" });
    expect(publication.assets).toEqual(["public/static/images/2026-10-22-my-article/diagram.svg"]);
    expect(publication.mdx).toContain("这段内容有来源。");
    const packageRoot = join(dataDir, "publications", publication.id);
    expect(readFileSync(join(packageRoot, "publication.json"), "utf8")).toContain("2026-10-22-my-article.mdx");
    expect(readFileSync(join(packageRoot, publication.assets[0]), "utf8")).toContain("<svg");
    const image = await app.inject({ method: "GET", url: `/api/v1/publications/${publication.id}/asset?path=${encodeURIComponent(publication.assets[0])}` });
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toContain("image/svg+xml");
    expect(image.body).toContain("<svg");
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("preparing the same final revision and slug is idempotent", async () => {
  const { dataDir, app, articleId } = await setup();
  try {
    await draft(app, articleId, "# 我的文章\n\n这段内容有来源。");
    await finalize(app, articleId);
    const firstResponse = await prepare(app, articleId);
    const secondResponse = await prepare(app, articleId);
    expect(firstResponse.statusCode).toBe(201);
    expect(secondResponse.statusCode).toBe(200);
    const first = firstResponse.json();
    const second = secondResponse.json();
    expect(second.id).toBe(first.id);
    expect(second.articlePath).toBe(first.articlePath);
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("editing after preparation marks the old package stale", async () => {
  const { dataDir, app, articleId } = await setup();
  try {
    await draft(app, articleId, "# 我的文章\n\n第一版内容。");
    await finalize(app, articleId);
    const publication = (await prepare(app, articleId)).json();
    await draft(app, articleId, "# 我的文章\n\n新的内容需要重审。", 2);
    const old = await app.inject({ method: "GET", url: `/api/v1/articles/${articleId}/publications/${publication.id}` });
    expect(old.statusCode).toBe(200);
    expect(old.json()).toMatchObject({ status: "stale", revision: 2 });
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});
