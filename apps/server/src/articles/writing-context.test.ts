import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import Database from "better-sqlite3";
import { createApp } from "../app.js";
import { ArticleStore } from "./store.js";
import { VaultRegistry } from "../vaults/registry.js";
import { KnowledgeIndex } from "../vaults/knowledge-index.js";
import { WritingContextStore } from "./writing-context.js";

const maintainerRoot = resolve(process.cwd(), "../../../open-context-forge-vault-maintainer");
const writerRoot = resolve(process.cwd(), "../../../open-context-forge-tech-article-writer");
const headers = { "x-ocf-client": "1" };
async function setup() {
  const root = mkdtempSync(join(tmpdir(), "ocf-writing-context-"));
  const dataDir = join(root, "data");
  const app = createApp({ dataDir, maintainerRoot, writerRoot });
  await app.ready();
  for (const id of ["one", "two"]) {
    const vault = join(root, id); mkdirSync(vault);
    writeFileSync(join(vault, "Note.md"), `# ${id}\nline two\nline three\n`);
    writeFileSync(join(vault, "Other.md"), "# Other\n");
    const response = await app.inject({ method: "POST", url: "/api/v1/vaults", headers, payload: { id, path: vault, adopt: true } });
    expect(response.statusCode).toBe(201);
  }
  const db = new Database(join(dataDir, "state.sqlite")); db.pragma("foreign_keys = ON");
  const vaults = new VaultRegistry(db, dataDir, maintainerRoot);
  const articles = new ArticleStore(db, dataDir, vaults, writerRoot);
  const knowledge = new KnowledgeIndex(db, vaults);
  const store = new WritingContextStore(db, dataDir, vaults, articles, knowledge);
  const article = await articles.create();
  return { root, dataDir, app, db, vaults, articles, knowledge, store, id: article.id,
    close: async () => { knowledge.close(); db.close(); await app.close(); rmSync(root, { recursive: true, force: true }); } };
}
const refs = [{ vaultId: "one", path: "Note.md" }, { vaultId: "two", path: "Note.md" }];

test("newly browsable text formats can be referenced while PDF bytes cannot become writing text", async () => {
  const f = await setup();
  try {
    for (const [path, body] of Object.entries({ "Essay.mdx": "# MDX essay\n\nEvidence in MDX.\n<Component />",
      "Note.txt": "Plain text evidence.", "Page.html": "<script>neverRun()</script><h1>HTML evidence</h1><p>Readable evidence.</p>",
      "Report.pdf": "%PDF-1.4\n%%EOF\n" })) writeFileSync(join(f.root, "one", path), body);
    const saved = await f.store.save(f.id, { expectedRevision: 0, vaultIds: ["one"],
      materials: ["Essay.mdx", "Note.txt", "Page.html"].map(path => ({ vaultId: "one", path })) });
    expect(saved.materials).toHaveLength(3);
    const html = await f.store.material(f.id, "S3");
    expect(html.markdown).toContain("Readable evidence.");
    expect(html.markdown).not.toContain("neverRun");
    await expect(f.store.save(f.id, { expectedRevision: 1, vaultIds: ["one"],
      materials: [{ vaultId: "one", path: "Report.pdf" }] })).rejects.toMatchObject({ statusCode: 422 });
  } finally { await f.close(); }
});

test("persists two vault materials independently, rejects stale writes and never reuses source ids", async () => {
  const f = await setup();
  try {
    const saved = await f.store.save(f.id, { expectedRevision: 0, vaultIds: ["one", "two"], materials: refs });
    expect(saved.materials.map(m => m.id)).toEqual(["S1", "S2"]);
    const other = await f.articles.create();
    expect(await f.store.get(other.id)).toMatchObject({ revision: 0, vaultIds: [], materials: [] });
    await expect(f.store.save(f.id, { expectedRevision: 0, vaultIds: [], materials: [] })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    const removed = await f.store.save(f.id, { expectedRevision: 1, vaultIds: ["two"], materials: [refs[1]] });
    expect(removed.materials.map(m => m.id)).toEqual(["S2"]);
    const readded = await f.store.save(f.id, { expectedRevision: 2, vaultIds: ["one", "two"], materials: refs });
    expect(readded.materials.map(m => m.id)).toEqual(["S3", "S2"]);
    expect(await f.store.get(f.id)).toEqual(readded);
  } finally { await f.close(); }
});

test("rejects traversal, symlinks, invalid vault membership and malformed selection ranges", async () => {
  const f = await setup();
  try {
    writeFileSync(join(f.root, "outside.md"), "private"); symlinkSync(join(f.root, "outside.md"), join(f.root, "one", "Escape.md"));
    symlinkSync(join(f.root, "one", "Other.md"), join(f.root, "one", "Inside.md"));
    for (const path of ["../outside.md", "/etc/passwd", "Escape.md", "Inside.md", ".ocf/vault.json"]) {
      await expect(f.store.save(f.id, { expectedRevision: 0, vaultIds: ["one"], materials: [{ vaultId: "one", path }] })).rejects.toMatchObject({ statusCode: 422 });
    }
    await expect(f.store.save(f.id, { expectedRevision: 0, vaultIds: ["one"], materials: refs })).rejects.toMatchObject({ statusCode: 422 });
    await f.store.save(f.id, { expectedRevision: 0, vaultIds: ["one"], materials: [refs[0]] });
    for (const selection of [{ materialId: "S9" }, { materialId: "S1", startLine: 0 }, { materialId: "S1", startLine: 3, endLine: 2 }, { materialId: "S1", endLine: 99 }]) {
      await expect(f.store.createTurn(f.id, [selection])).rejects.toMatchObject({ statusCode: 422 });
    }
    expect((await f.store.get(f.id)).revision).toBe(1);
  } finally { await f.close(); }
});

test("turn snapshots contain only selected sources and preserve ranges and survive refresh, removal and external file edits", async () => {
  const f = await setup();
  try {
    await f.store.save(f.id, { expectedRevision: 0, vaultIds: ["one", "two"], materials: refs });
    const turn = await f.store.createTurn(f.id, [{ materialId: "S2", startLine: 2, endLine: 3 }]);
    expect(turn.sources.map(s => s.id)).toEqual(["S2"]);
    expect((await f.store.material(f.id, "S2", turn.id)).markdown).toBe("# two\nline two\nline three\n");
    await expect(f.store.material(f.id, "S1", turn.id)).rejects.toMatchObject({ statusCode: 404 });
    writeFileSync(join(f.root, "two", "Note.md"), "# changed\n");
    const retained = await f.store.save(f.id, { expectedRevision: 1, vaultIds: ["one", "two"], materials: refs });
    expect(retained.materials[1].title).toBe("two");
    await f.store.save(f.id, { expectedRevision: 2, vaultIds: ["one", "two"], materials: refs, refresh: true });
    expect((await f.store.material(f.id, "S2")).markdown).toBe("# changed\n");
    await f.store.save(f.id, { expectedRevision: 3, vaultIds: [], materials: [] });
    expect((await f.store.material(f.id, "S2", turn.id)).markdown).toBe("# two\nline two\nline three\n");
    expect((await f.store.createTurn(f.id, [])).sources).toEqual([]);
  } finally { await f.close(); }
});

test("outline edits and context changes revoke approval with optimistic revisions", async () => {
  const f = await setup();
  try {
    expect(await f.store.outline(f.id)).toMatchObject({ revision: 0, markdown: "", approved: false });
    await f.store.saveOutline(f.id, "# Plan", 0);
    expect(await f.store.approveOutline(f.id, 1)).toMatchObject({ revision: 1, approved: true });
    expect((await f.store.createTurn(f.id, [])).outlineRevision).toBe(1);
    await f.store.saveOutline(f.id, "# New plan", 1);
    expect(await f.store.outline(f.id)).toMatchObject({ revision: 2, approved: false });
    await expect(f.store.approveOutline(f.id, 1)).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await f.store.approveOutline(f.id, 2);
    await f.store.save(f.id, { expectedRevision: 0, vaultIds: ["one"], materials: [refs[0]] });
    expect((await f.store.outline(f.id)).approved).toBe(false);
  } finally { await f.close(); }
});

test("migrates a legacy unindexed source only once", async () => {
  const f = await setup();
  try {
    const path = "raw/sources/legacy.md";
    writeFileSync(join(f.root, "one", path), "# Legacy\noriginal\n");
    const article = await f.articles.create({ sourceRef: { vaultId: "one", snapshot: path } });
    const migrated = await f.store.get(article.id);
    expect(migrated.materials).toMatchObject([{ id: "S1", vaultId: "one", path, kind: "source" }]);
    await f.store.save(article.id, { expectedRevision: migrated.revision, vaultIds: [], materials: [] });
    expect((await f.store.get(article.id)).materials).toEqual([]);
  } finally { await f.close(); }
});

test("routes expose context and safe material links, combined knowledge pagination and purge cascade", async () => {
  const f = await setup();
  try {
    writeFileSync(join(f.root, "one", "Note.md"), "# one\n[[Other]]\n[[Missing]]\n");
    const response = await f.app.inject({ method: "PUT", url: `/api/v1/articles/${f.id}/context`, headers,
      payload: { expectedRevision: 0, vaultIds: ["one", "two"], materials: refs } });
    expect(response.statusCode).toBe(200);
    const detail = (await f.app.inject({ method: "GET", url: `/api/v1/articles/${f.id}/materials/S1` })).json();
    expect(detail.outlinks).toMatchObject([{ to: "Other.md" }]); expect(detail.issues).toMatchObject([{ reason: "missing" }]);
    expect(detail.absolutePath).toBeUndefined();
    const listing = (await f.app.inject({ method: "GET", url: "/api/v1/knowledge/items?vaultIds=one,two&q=line%20two&pageSize=1&page=2" })).json();
    expect(listing).toMatchObject({ total: 1, page: 2, items: [] });
    const combined = (await f.app.inject({ method: "GET", url: "/api/v1/knowledge/items?vaultIds=one,two&sort=title&pageSize=1&page=2" })).json();
    expect(combined.total).toBe(4); expect(combined.items).toHaveLength(1);
    expect((await f.app.inject({ method: "GET", url: "/api/v1/writing/skill" })).json()).toMatchObject({ available: true });
    await f.store.createTurn(f.id, [{ materialId: "S1" }]);
    f.articles.manage("trash", [{ id: f.id, expectedRevision: 0 }]);
    const trashed = (f.db.prepare("SELECT trashed_at FROM articles WHERE id = ?").get(f.id) as { trashed_at: string }).trashed_at;
    await f.articles.emptyTrash(true, [{ id: f.id, expectedRevision: 0, expectedTrashedAt: trashed }]);
    expect(existsSync(join(f.dataDir, "writing-projects", f.id))).toBe(false);
    for (const table of ["writing_contexts", "writing_materials", "writing_turns", "writing_outlines"]) expect(f.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE article_id = ?`).get(f.id)).toEqual({ n: 0 });
    expect(readFileSync(join(f.root, "one", "Note.md"), "utf8")).toContain("[[Other]]");
  } finally { await f.close(); }
});

test("context writes are atomic across invalid batches and concurrent optimistic saves", async () => {
  const f = await setup();
  try {
    await f.store.save(f.id, { expectedRevision: 0, vaultIds: ["one"], materials: [refs[0]] });
    await expect(f.store.save(f.id, { expectedRevision: 1, vaultIds: ["one", "two"], materials: [refs[1], { vaultId: "one", path: "missing.md" }] })).rejects.toMatchObject({ statusCode: 422 });
    expect((await f.store.get(f.id)).materials.map(m => m.id)).toEqual(["S1"]);
    const results = await Promise.allSettled([
      f.store.save(f.id, { expectedRevision: 1, vaultIds: ["one", "two"], materials: refs }),
      f.store.save(f.id, { expectedRevision: 1, vaultIds: [], materials: [] }),
    ]);
    expect(results.map(r => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const context = await f.store.get(f.id);
    expect(context.revision).toBe(2);
    expect(context.materials.map(m => m.id)).toEqual(results[0].status === "fulfilled" ? ["S1", "S2"] : []);
    const restarted = new WritingContextStore(f.db, f.dataDir, f.vaults, f.articles, f.knowledge);
    expect(await restarted.get(f.id)).toEqual(context);
  } finally { await f.close(); }
});

test("rejects oversize files, turn totals, material counts and outline content", async () => {
  const f = await setup();
  try {
    writeFileSync(join(f.root, "one", "Big.md"), "x".repeat(2 * 1024 * 1024 + 1));
    await expect(f.store.save(f.id, { expectedRevision: 0, vaultIds: ["one"], materials: [{ vaultId: "one", path: "Big.md" }] })).rejects.toMatchObject({ code: "WRITING_CONTEXT_TOO_LARGE" });
    const largeRefs = Array.from({ length: 7 }, (_, index) => ({ vaultId: "one", path: `Large${index}.md` }));
    for (const ref of largeRefs) writeFileSync(join(f.root, "one", ref.path), "x".repeat(2 * 1024 * 1024));
    const context = await f.store.save(f.id, { expectedRevision: 0, vaultIds: ["one"], materials: largeRefs });
    await expect(f.store.createTurn(f.id, context.materials.map(m => ({ materialId: m.id })))).rejects.toMatchObject({ code: "WRITING_CONTEXT_TOO_LARGE" });
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM writing_turns").get()).toEqual({ n: 0 });
    await expect(f.store.save(f.id, { expectedRevision: 1, vaultIds: ["one"], materials: Array.from({ length: 31 }, () => refs[0]) })).rejects.toMatchObject({ statusCode: 422 });
    await expect(f.store.saveOutline(f.id, "x".repeat(100001), 0)).rejects.toMatchObject({ code: "INVALID_WRITING_OUTLINE" });
    await expect(f.store.approveOutline(f.id, 1)).rejects.toMatchObject({ code: "INVALID_WRITING_OUTLINE" });
    expect(await f.store.outline(f.id)).toMatchObject({ revision: 1, approved: false });
  } finally { await f.close(); }
});

test("outline routes reject stale revisions, require client headers and preserve approval semantics", async () => {
  const f = await setup();
  try {
    const url = `/api/v1/articles/${f.id}/outline`;
    expect((await f.app.inject({ method: "PUT", url, payload: { expectedRevision: 0, markdown: "# Outline" } })).statusCode).toBe(403);
    expect((await f.app.inject({ method: "PUT", url, headers, payload: { expectedRevision: 0, markdown: "# Outline" } })).json()).toMatchObject({ revision: 1, approved: false });
    expect((await f.app.inject({ method: "POST", url: `${url}/approve`, headers, payload: { expectedRevision: 1 } })).json()).toMatchObject({ revision: 1, approved: true });
    expect((await f.app.inject({ method: "GET", url })).json()).toMatchObject({ markdown: "# Outline", approved: true });
    expect((await f.app.inject({ method: "PUT", url, headers, payload: { expectedRevision: 0, markdown: "stale" } })).statusCode).toBe(409);
    for (const query of ["vaultIds=one,one", "vaultIds=", "vaultId=one&vaultIds=two"]) expect((await f.app.inject({ method: "GET", url: `/api/v1/knowledge/items?${query}` })).statusCode).toBe(422);
  } finally { await f.close(); }
});

test("skill status detects absent writer skill and snapshot readers reject replaced symlinks", async () => {
  const f = await setup();
  try {
    const fakeWriter = join(f.root, "writer"); mkdirSync(fakeWriter);
    const articles = new ArticleStore(f.db, f.dataDir, f.vaults, fakeWriter);
    const store = new WritingContextStore(f.db, f.dataDir, f.vaults, articles, f.knowledge);
    expect(store.skillStatus()).toMatchObject({ available: false, path: null });
    await f.store.save(f.id, { expectedRevision: 0, vaultIds: ["one"], materials: [refs[0]] });
    const row = f.db.prepare("SELECT snapshot_file FROM writing_materials WHERE article_id=?").get(f.id) as { snapshot_file: string };
    const snapshot = join(f.dataDir, "writing-projects", f.id, "context", row.snapshot_file);
    rmSync(snapshot); symlinkSync(join(f.root, "one", "Note.md"), snapshot);
    await expect(f.store.material(f.id, "S1")).rejects.toMatchObject({ statusCode: 422 });
  } finally { await f.close(); }
});


test("rejects a symlinked article project before creating snapshot directories outside the project", async () => {
  const f = await setup();
  try {
    await f.store.get(f.id);
    const project = join(f.dataDir, "writing-projects", f.id), moved = join(f.root, "moved-project");
    renameSync(project, moved); symlinkSync(moved, project);
    await expect(f.store.save(f.id, { expectedRevision: 0, vaultIds: ["one"], materials: [refs[0]] })).rejects.toMatchObject({ statusCode: 422 });
    expect(existsSync(join(moved, "context"))).toBe(false);
  } finally { await f.close(); }
});

test("context invalidation advances outline revision and rejects stale approval even while unapproved", async () => {
 const f = await setup();
 try {
  await f.store.saveOutline(f.id,"# Plan",0); await f.store.approveOutline(f.id,1);
  await f.store.save(f.id,{expectedRevision:0,vaultIds:['one'],materials:[refs[0]]});
  expect(await f.store.outline(f.id)).toMatchObject({revision:2,approved:false});
  await expect(f.store.approveOutline(f.id,1)).rejects.toMatchObject({code:'REVISION_CONFLICT'});
  await f.store.save(f.id,{expectedRevision:1,vaultIds:['one'],materials:[]});
  expect(await f.store.outline(f.id)).toMatchObject({revision:3,approved:false});
  await expect(f.store.approveOutline(f.id,2)).rejects.toMatchObject({code:'REVISION_CONFLICT'});
  await f.store.approveOutline(f.id,3);
  await f.store.save(f.id,{expectedRevision:2,vaultIds:['one'],materials:[]});
  expect(await f.store.outline(f.id)).toMatchObject({revision:3,approved:true});
 } finally {await f.close();}
});
