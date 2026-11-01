import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import Database from "better-sqlite3";
import { createApp } from "../app.js";
import type { AgentOptions } from "../agents/service.js";

const maintainerRoot = resolve(process.cwd(), "../../../open-context-forge-vault-maintainer");
const writerRoot = resolve(process.cwd(), "../../../open-context-forge-tech-article-writer");

async function setup(agentOptions?: AgentOptions) {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-article-"));
  const app = createApp({ dataDir, maintainerRoot, writerRoot, agentOptions });
  await app.inject({ method: "GET", url: "/api/v1/vaults" });
  const snapshot = "raw/sources/source.md";
  writeFileSync(join(dataDir, "vaults", "default", snapshot), "# 资料来源\n\n可回查的事实。\n");
  return { dataDir, app, sourceRef: { vaultId: "default", snapshot } };
}

const clientHeaders = { "x-ocf-client": "1" };
async function trashItems(app: ReturnType<typeof createApp>, ids: { id: string; revision: number }[]) {
  const response = await app.inject({ method: "POST", url: "/api/v1/articles/actions", headers: clientHeaders,
    payload: { action: "trash", items: ids.map((item) => ({ id: item.id, expectedRevision: item.revision })) } });
  expect(response.statusCode).toBe(200);
  return (await app.inject({ method: "GET", url: "/api/v1/articles?includeTrashed=true" })).json().items
    .filter((item: { id: string }) => ids.some(({ id }) => item.id === id))
    .map((item: { id: string; revision: number; trashedAt: string }) => ({ id: item.id, expectedRevision: item.revision, expectedTrashedAt: item.trashedAt }));
}

test("emptying article trash removes local drafts, histories and publication packages while preserving active articles and vault sources", async () => {
  const { dataDir, app, sourceRef } = await setup({ claudePath: "/test/claude", environment: {},
    runner: async () => ({ text: "写作建议", sessionId: "article-cleanup-session" }) });
  try {
    const article = (await createArticle(app, sourceRef)).json();
    const active = (await createArticle(app, sourceRef)).json();
    await app.inject({ method: "PUT", url: `/api/v1/articles/${article.id}/draft`, headers: clientHeaders,
      payload: { markdown: "# 我的文章\n\n需要清理的正文。", expectedRevision: 0 } });
    await app.inject({ method: "POST", url: `/api/v1/articles/${article.id}/finalize`, headers: clientHeaders, payload: { expectedRevision: 1 } });
    const publication = (await app.inject({ method: "POST", url: `/api/v1/articles/${article.id}/publications/prepare`,
      headers: clientHeaders, payload: { slug: "purged-article" } })).json();
    const retainedWorktree = join(dataDir, "blog-worktrees", "retained-deployment");
    mkdirSync(retainedWorktree, { recursive: true });
    writeFileSync(join(retainedWorktree, "published.mdx"), "博客仓库中的文章副本");
    const publicationDb = new Database(join(dataDir, "state.sqlite"));
    publicationDb.prepare("UPDATE publications SET worktree_path = ?, commit_sha = ?, status = 'written-to-repository' WHERE id = ?")
      .run(retainedWorktree, "a".repeat(40), publication.id);
    publicationDb.close();
    await app.inject({ method: "POST", url: `/api/v1/articles/${article.id}/agent/runs`, headers: clientHeaders,
      payload: { profileId: "claude-current", content: "给我写作建议" } });
    await expect.poll(async () => (await app.inject({ method: "GET", url: `/api/v1/articles/${article.id}/agent?profileId=claude-current` })).json().run?.status).toBe("completed");
    const items = await trashItems(app, [{ id: article.id, revision: 2 }]);
    const response = await app.inject({ method: "POST", url: "/api/v1/articles/trash/empty", headers: clientHeaders,
      payload: { confirmed: true, items } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ changed: 1, cleanupPending: 0 });
    expect((await app.inject({ method: "GET", url: `/api/v1/articles/${article.id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/v1/articles/${active.id}` })).statusCode).toBe(200);
    expect(existsSync(join(dataDir, "writing-projects", article.id))).toBe(false);
    expect(existsSync(join(dataDir, "agent-workspaces", article.id))).toBe(false);
    expect(existsSync(join(dataDir, "publications", publication.id))).toBe(false);
    expect(readFileSync(join(retainedWorktree, "published.mdx"), "utf8")).toBe("博客仓库中的文章副本");
    expect(readFileSync(join(dataDir, "vaults", "default", sourceRef.snapshot), "utf8")).toContain("可回查的事实");
    const db = new Database(join(dataDir, "state.sqlite"));
    try {
      for (const table of ["agent_conversations", "agent_messages", "agent_runs", "agent_run_events", "publications"]) {
        expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
      }
      expect(db.prepare("SELECT publication_id, article_id, worktree_path, commit_sha FROM retained_publication_worktrees").get())
        .toEqual({ publication_id: publication.id, article_id: article.id, worktree_path: retainedWorktree, commit_sha: "a".repeat(40) });
    } finally { db.close(); }
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("emptying trash rejects a restored article and requires confirmation before deleting any article", async () => {
  const { dataDir, app, sourceRef } = await setup();
  try {
    const a = (await createArticle(app, sourceRef)).json(), b = (await createArticle(app, sourceRef)).json();
    const items = await trashItems(app, [a, b]);
    const unconfirmed = await app.inject({ method: "POST", url: "/api/v1/articles/trash/empty", headers: clientHeaders, payload: { items } });
    expect(unconfirmed.statusCode).toBe(422);
    await app.inject({ method: "POST", url: "/api/v1/articles/actions", headers: clientHeaders,
      payload: { action: "restore", items: [{ id: b.id, expectedRevision: 0 }] } });
    const stale = await app.inject({ method: "POST", url: "/api/v1/articles/trash/empty", headers: clientHeaders, payload: { confirmed: true, items } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: "ARTICLE_TRASH_CHANGED" });
    expect((await app.inject({ method: "GET", url: "/api/v1/articles?includeTrashed=true" })).json().items).toHaveLength(2);
    const valid = await app.inject({ method: "POST", url: "/api/v1/articles/trash/empty", headers: clientHeaders,
      payload: { confirmed: true, items: items.filter((item: { id: string }) => item.id === a.id) } });
    expect(valid.statusCode).toBe(200);
    const remaining = (await app.inject({ method: "GET", url: "/api/v1/articles?includeTrashed=true" })).json().items;
    expect(remaining.map((item: { id: string }) => item.id)).toEqual([b.id]);
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("emptying trash waits for an article's running agent task", async () => {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const { dataDir, app, sourceRef } = await setup({ claudePath: "/test/claude", environment: {}, runner: async () => {
    await gate; return { text: "保留到任务结束", sessionId: "busy-session" };
  } });
  const db = new Database(join(dataDir, "state.sqlite"));
  try {
    const article = (await createArticle(app, sourceRef)).json();
    const run = (await app.inject({ method: "POST", url: `/api/v1/articles/${article.id}/agent/runs`, headers: clientHeaders,
      payload: { profileId: "claude-current", content: "继续写作" } })).json();
    await app.inject({ method: "POST", url: `/api/v1/articles/${article.id}/agent/runs/${run.id}/cancel`, headers: clientHeaders });
    const items = await trashItems(app, [article]);
    const response = await app.inject({ method: "POST", url: "/api/v1/articles/trash/empty", headers: clientHeaders, payload: { confirmed: true, items } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "ARTICLE_BUSY" });
    expect(existsSync(join(dataDir, "writing-projects", article.id))).toBe(true);
    finish();
    await expect.poll(async () => (await app.inject({ method: "POST", url: "/api/v1/articles/trash/empty", headers: clientHeaders,
      payload: { confirmed: true, items } })).statusCode).toBe(200);
  } finally { finish(); db.close(); await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("service restart finishes local file cleanup recorded before an interruption", async () => {
  const { dataDir, app, sourceRef } = await setup();
  let restarted: ReturnType<typeof createApp> | undefined;
  let closed = false;
  try {
    const article = (await createArticle(app, sourceRef)).json();
    await app.close(); closed = true;
    const db = new Database(join(dataDir, "state.sqlite"));
    try {
      db.prepare("INSERT INTO article_deletions (id, publication_ids) VALUES (?, '[]')").run(article.id);
      db.prepare("DELETE FROM articles WHERE id = ?").run(article.id);
    } finally { db.close(); }
    expect(existsSync(join(dataDir, "writing-projects", article.id))).toBe(true);
    restarted = createApp({ dataDir, maintainerRoot, writerRoot });
    await restarted.ready();
    expect(existsSync(join(dataDir, "writing-projects", article.id))).toBe(false);
    expect((await restarted.inject({ method: "GET", url: `/api/v1/articles/${article.id}` })).statusCode).toBe(404);
    expect(existsSync(join(dataDir, "vaults", "default", sourceRef.snapshot))).toBe(true);
  } finally { if (!closed) await app.close(); await restarted?.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

async function createArticle(app: ReturnType<typeof createApp>, sourceRef: { vaultId: string; snapshot: string }) {
  return app.inject({
    method: "POST", url: "/api/v1/articles", headers: { "x-ocf-client": "1" },
    payload: { title: "我的文章", summary: "一篇有来源的文章", date: "2026-10-22", sourceRef },
  });
}

test("trashing and restoring an article preserves its revisions, sources and publication package", async () => {
  const { dataDir, app, sourceRef } = await setup();
  try {
    const created = (await createArticle(app, sourceRef)).json();
    await app.inject({ method: "PUT", url: `/api/v1/articles/${created.id}/draft`, headers: { "x-ocf-client": "1" },
      payload: { markdown: "# 我的文章\n\n需要保留的正文。", expectedRevision: 0 } });
    await app.inject({ method: "POST", url: `/api/v1/articles/${created.id}/finalize`, headers: { "x-ocf-client": "1" }, payload: { expectedRevision: 1 } });
    const publication = (await app.inject({ method: "POST", url: `/api/v1/articles/${created.id}/publications/prepare`,
      headers: { "x-ocf-client": "1" }, payload: { slug: "recoverable-article" } })).json();
    const project = join(dataDir, "writing-projects", created.id);
    const before = readFileSync(join(project, "article.md"), "utf8");
    const action = (name: string) => app.inject({ method: "POST", url: "/api/v1/articles/actions", headers: { "x-ocf-client": "1" },
      payload: { action: name, items: [{ id: created.id, expectedRevision: 2 }] } });
    expect((await action("trash")).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/articles" })).json().items).toHaveLength(0);
    expect((await app.inject({ method: "GET", url: "/api/v1/articles?includeTrashed=true" })).json().items[0]).toMatchObject({ id: created.id, trashedAt: expect.any(String) });
    expect((await app.inject({ method: "GET", url: `/api/v1/articles/${created.id}` })).json()).toMatchObject({ error: "ARTICLE_TRASHED" });
    expect((await app.inject({ method: "POST", url: `/api/v1/articles/${created.id}/publications/prepare`,
      headers: { "x-ocf-client": "1" }, payload: { slug: "blocked-while-trashed" } })).statusCode).toBe(409);
    expect(readFileSync(join(project, "article.md"), "utf8")).toBe(before);
    expect(existsSync(join(project, "versions", "2.md"))).toBe(true);
    expect(existsSync(join(dataDir, "publications", publication.id))).toBe(true);
    expect(existsSync(join(dataDir, "vaults", "default", sourceRef.snapshot))).toBe(true);
    expect((await action("restore")).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/v1/articles/${created.id}` })).json()).toMatchObject({ revision: 2, status: "final", markdown: "# 我的文章\n\n需要保留的正文。" });
    expect((await app.inject({ method: "GET", url: `/api/v1/articles/${created.id}/publications/${publication.id}` })).json()).toMatchObject({ status: "prepared" });
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("batch article management rejects stale revisions before changing any selected article", async () => {
  const { dataDir, app } = await setup();
  try {
    const create = () => app.inject({ method: "POST", url: "/api/v1/articles", headers: { "x-ocf-client": "1" }, payload: {} });
    const a = (await create()).json(), b = (await create()).json();
    await app.inject({ method: "PUT", url: `/api/v1/articles/${b.id}/draft`, headers: { "x-ocf-client": "1" },
      payload: { markdown: "更新后的正文", expectedRevision: 0 } });
    const stale = await app.inject({ method: "POST", url: "/api/v1/articles/actions", headers: { "x-ocf-client": "1" },
      payload: { action: "trash", items: [{ id: a.id, expectedRevision: 0 }, { id: b.id, expectedRevision: 0 }] } });
    expect(stale.statusCode).toBe(409);
    expect((await app.inject({ method: "GET", url: "/api/v1/articles" })).json().items).toHaveLength(2);
    const valid = await app.inject({ method: "POST", url: "/api/v1/articles/actions", headers: { "x-ocf-client": "1" },
      payload: { action: "trash", items: [{ id: a.id, expectedRevision: 0 }, { id: b.id, expectedRevision: 1 }] } });
    expect(valid.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/articles" })).json().items).toHaveLength(0);
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

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

test("creates an empty article first and collects public metadata while writing", async () => {
  const { dataDir, app } = await setup();
  try {
    const createdResponse = await app.inject({ method: "POST", url: "/api/v1/articles",
      headers: { "x-ocf-client": "1" }, payload: {} });
    expect(createdResponse.statusCode).toBe(201);
    const created = createdResponse.json();
    expect(created).toMatchObject({ title: "", summary: "", date: "", sourceRef: null, markdown: "", revision: 0, status: "draft" });
    const initialList = await app.inject({ method: "GET", url: "/api/v1/articles" });
    expect(initialList.json().items[0]).toMatchObject({ id: created.id, stage: "new", publicationId: null });

    const body = await app.inject({ method: "PUT", url: `/api/v1/articles/${created.id}/draft`,
      headers: { "x-ocf-client": "1" }, payload: { markdown: "# 临时想法\n\n开始写正文。", expectedRevision: 0 } });
    expect(body.statusCode).toBe(200);
    expect(body.json()).toMatchObject({ revision: 1, title: "", status: "draft" });
    expect((await app.inject({ method: "GET", url: "/api/v1/articles" })).json().items[0].stage).toBe("writing");
    const premature = await app.inject({ method: "POST", url: `/api/v1/articles/${created.id}/finalize`,
      headers: { "x-ocf-client": "1" }, payload: { expectedRevision: 1 } });
    expect(premature.statusCode).toBe(422);

    const metadata = await app.inject({ method: "PUT", url: `/api/v1/articles/${created.id}/draft`,
      headers: { "x-ocf-client": "1" }, payload: { title: "正式标题", summary: "公开摘要", date: "2026-10-24", expectedRevision: 1 } });
    expect(metadata.statusCode).toBe(200);
    expect(metadata.json()).toMatchObject({ title: "正式标题", summary: "公开摘要", date: "2026-10-24", revision: 2 });
    expect(readFileSync(join(dataDir, "writing-projects", created.id, "article.md"), "utf8")).toContain("title: '正式标题'");
    const final = await app.inject({ method: "POST", url: `/api/v1/articles/${created.id}/finalize`,
      headers: { "x-ocf-client": "1" }, payload: { expectedRevision: 2 } });
    expect(final.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/articles" })).json().items[0].stage).toBe("complete");
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("article list keeps separate drafts and marks prepared publications as pending", async () => {
  const { dataDir, app, sourceRef } = await setup();
  try {
    const first = (await createArticle(app, sourceRef)).json();
    const second = (await app.inject({ method: "POST", url: "/api/v1/articles",
      headers: { "x-ocf-client": "1" }, payload: {} })).json();
    await app.inject({ method: "PUT", url: `/api/v1/articles/${first.id}/draft`, headers: { "x-ocf-client": "1" },
      payload: { markdown: "# 我的文章\n\n足够完整的正文。", expectedRevision: 0 } });
    await app.inject({ method: "POST", url: `/api/v1/articles/${first.id}/finalize`, headers: { "x-ocf-client": "1" },
      payload: { expectedRevision: 1 } });
    const prepared = await app.inject({ method: "POST", url: `/api/v1/articles/${first.id}/publications/prepare`,
      headers: { "x-ocf-client": "1" }, payload: { slug: "first-article" } });
    expect(prepared.statusCode).toBe(201);
    const items = (await app.inject({ method: "GET", url: "/api/v1/articles" })).json().items;
    expect(items).toHaveLength(2);
    expect(items.find((item: { id: string }) => item.id === first.id)).toMatchObject({
      title: "我的文章", stage: "pending_publish", publicationId: prepared.json().id,
    });
    expect(items.find((item: { id: string }) => item.id === second.id)).toMatchObject({ title: "", stage: "new" });
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
