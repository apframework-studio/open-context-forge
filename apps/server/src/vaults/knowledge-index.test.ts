import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, vi } from "vitest";
import Database from "better-sqlite3";
import { createApp } from "../app.js";
import { KnowledgeIndex } from "./knowledge-index.js";

const maintainerRoot = resolve(process.cwd(), "../../../open-context-forge-vault-maintainer");
const headers = { "x-ocf-client": "1" };

test("browses the whole vault and counts nested document formats without images or migration backups", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocf-document-tree-"));
  const external = join(root, "vault");
  for (const folder of ["10-raw/public-blog/essay", "10-raw/public-blog/notes", "10-raw/public-blog/opensource",
    "10-raw/public-blog/assets", "10-raw/web-clips", "10-raw/_legacy-public-blog", "20-wiki", "Empty"]) {
    mkdirSync(join(external, folder), { recursive: true });
  }
  const source = "# Registered source\n";
  const fingerprint = createHash("sha256").update(source).digest("hex");
  const documents = {
    "10-raw/public-blog/registered.md": source,
    "10-raw/public-blog/essay/Long.mdx": "import Widget from './Widget'\n\n# MDX essay\n\n[[Map]]\n<Widget />",
    "10-raw/public-blog/notes/Note.MD": "# Note\n",
    "10-raw/public-blog/opensource/Report.pdf": "%PDF-1.4\n%%EOF\n",
    "10-raw/web-clips/Clip.markdown": "# Clip\n",
    "10-raw/web-clips/Plain.txt": "A plain text document.",
    "10-raw/web-clips/Page.html": "<title>Web page</title><script>SECRET_SCRIPT()</script><article><h1>HTML note</h1><p>Readable text.</p></article>",
    "20-wiki/Map.md": "# Map\n[essay](../10-raw/public-blog/essay/Long.mdx)\n[report](../10-raw/public-blog/opensource/Report.pdf)\n",
    "20-wiki/Large.md": "# Large note\n" + "x".repeat(2 * 1024 * 1024),
    "10-raw/public-blog/assets/diagram.png": "image bytes",
    "10-raw/_legacy-public-blog/Backup.md": "# Backup\n",
  };
  for (const [path, body] of Object.entries(documents)) writeFileSync(join(external, path), body);
  symlinkSync(join(external, "20-wiki"), join(external, "Linked-folder"));
  const app = createApp({ dataDir: join(root, "data"), maintainerRoot });
  try {
    await app.inject({ method: "POST", url: "/api/v1/vaults", headers, payload: { id: "documents", path: external, adopt: true } });
    const profilePath = join(external, ".ocf", "vault.json");
    const profile = JSON.parse(readFileSync(profilePath, "utf8"));
    profile.paths.sources = "10-raw/public-blog"; profile.paths.wiki = "20-wiki";
    writeFileSync(profilePath, JSON.stringify(profile));
    writeFileSync(join(external, ".ocf", "ingest-manifest.json"), JSON.stringify({ sources: {
      [fingerprint]: { snapshot: "10-raw/public-blog/registered.md" },
    } }));
    await app.inject({ method: "POST", url: "/api/v1/knowledge/documents/rescan", headers });
    const listed = await app.inject({ method: "GET", url: "/api/v1/knowledge/items?vaultId=documents" });
    expect(listed.json().total).toBe(9);
    expect(listed.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "10-raw/public-blog/essay/Long.mdx", format: "mdx" }),
      expect.objectContaining({ path: "10-raw/public-blog/opensource/Report.pdf", format: "pdf" }),
      expect.objectContaining({ path: "20-wiki/Large.md", previewLimited: true }),
    ]));
    const folders = await app.inject({ method: "GET", url: "/api/v1/knowledge/folders?vaultId=documents" });
    expect(folders.json().items).toEqual(expect.arrayContaining([
      { vaultId: "documents", path: "", count: 9 },
      { vaultId: "documents", path: "10-raw", count: 7 },
      { vaultId: "documents", path: "10-raw/public-blog", count: 4 },
      { vaultId: "documents", path: "10-raw/public-blog/essay", count: 1 },
      { vaultId: "documents", path: "10-raw/public-blog/notes", count: 1 },
      { vaultId: "documents", path: "10-raw/public-blog/opensource", count: 1 },
      { vaultId: "documents", path: "10-raw/public-blog/assets", count: 0 },
      { vaultId: "documents", path: "Empty", count: 0 },
    ]));
    expect(folders.json().items.some((item: { path: string }) => item.path.includes("_legacy") || item.path.includes("Linked-folder"))).toBe(false);
    const nested = await app.inject({ method: "GET", url: "/api/v1/knowledge/items?vaultId=documents&folder=10-raw%2Fpublic-blog" });
    expect(nested.json().total).toBe(4);
    const html = await app.inject({ method: "GET", url: "/api/v1/knowledge/items/documents?path=10-raw%2Fweb-clips%2FPage.html" });
    expect(html.json().markdown).toContain("Readable text.");
    expect(html.json().markdown).not.toContain("SECRET_SCRIPT");
    const detail = await app.inject({ method: "GET", url: "/api/v1/knowledge/items/documents?path=20-wiki%2FMap.md" });
    expect(detail.json().outlinks).toEqual(expect.arrayContaining([
      expect.objectContaining({ to: "10-raw/public-blog/essay/Long.mdx" }),
      expect.objectContaining({ to: "10-raw/public-blog/opensource/Report.pdf" }),
    ]));
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});

test("PDF preview serves only indexed documents and rejects images, traversal and symlinks", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocf-pdf-preview-"));
  const external = join(root, "vault"); mkdirSync(external);
  const bytes = Buffer.from("%PDF-1.4\nTest PDF bytes\n%%EOF\n");
  writeFileSync(join(external, "报告.pdf"), bytes);
  writeFileSync(join(external, "picture.png"), "png");
  const app = createApp({ dataDir: join(root, "data"), maintainerRoot });
  try {
    await app.inject({ method: "POST", url: "/api/v1/vaults", headers, payload: { id: "pdf-preview", path: external, adopt: true } });
    const detail = await app.inject({ method: "GET", url: "/api/v1/knowledge/items/pdf-preview?path=%E6%8A%A5%E5%91%8A.pdf" });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ format: "pdf", markdown: "", sizeBytes: bytes.length });
    const content = await app.inject({ method: "GET", url: "/api/v1/knowledge/files/pdf-preview?path=%E6%8A%A5%E5%91%8A.pdf" });
    expect(content.statusCode).toBe(200);
    expect(content.headers["content-type"]).toBe("application/pdf");
    expect(content.headers["content-disposition"]).toContain("inline;");
    expect(content.rawPayload).toEqual(bytes);
    const partial = await app.inject({ method: "GET", url: "/api/v1/knowledge/files/pdf-preview?path=%E6%8A%A5%E5%91%8A.pdf", headers: { range: "bytes=0-3" } });
    expect(partial.statusCode).toBe(206);
    expect(partial.body).toBe("%PDF");
    expect(partial.headers["content-range"]).toBe(`bytes 0-3/${bytes.length}`);
    const invalidRange = await app.inject({ method: "GET", url: "/api/v1/knowledge/files/pdf-preview?path=%E6%8A%A5%E5%91%8A.pdf", headers: { range: "bytes=999999-" } });
    expect(invalidRange.statusCode).toBe(416);
    for (const path of ["picture.png", "../outside.pdf", ".ocf/vault.json"]) {
      const rejected = await app.inject({ method: "GET", url: `/api/v1/knowledge/files/pdf-preview?path=${encodeURIComponent(path)}` });
      expect([404, 422]).toContain(rejected.statusCode);
    }
    const outside = join(root, "outside.pdf"); writeFileSync(outside, bytes);
    rmSync(join(external, "报告.pdf")); symlinkSync(outside, join(external, "报告.pdf"));
    const linked = await app.inject({ method: "GET", url: "/api/v1/knowledge/files/pdf-preview?path=%E6%8A%A5%E5%91%8A.pdf" });
    expect(linked.statusCode).toBe(404);
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});

test("PDF streaming retains the verified file when its path is replaced before the stream opens", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocf-pdf-swap-"));
  const external = join(root, "vault"); mkdirSync(external);
  const original = "%PDF-1.4\nInside\n%%EOF\n";
  writeFileSync(join(external, "Report.pdf"), original);
  const outside = join(root, "outside.pdf"); writeFileSync(outside, "%PDF-1.4\nSecret\n%%EOF\n");
  const app = createApp({ dataDir: join(root, "data"), maintainerRoot });
  const realFile = KnowledgeIndex.prototype.file;
  let swap: ReturnType<typeof vi.spyOn> | undefined;
  try {
    await app.inject({ method: "POST", url: "/api/v1/vaults", headers, payload: { id: "pdf-swap", path: external, adopt: true } });
    // Keep validation real; replace only the filesystem path at the streaming boundary.
    swap = vi.spyOn(KnowledgeIndex.prototype, "file").mockImplementation(function (this: KnowledgeIndex, vaultId, path) {
      const file = realFile.call(this, vaultId, path);
      rmSync(file.path); symlinkSync(outside, file.path);
      return file;
    });
    const streamed = await app.inject({ method: "GET", url: "/api/v1/knowledge/files/pdf-swap?path=Report.pdf" });
    expect(streamed.statusCode).toBe(200);
    expect(streamed.body).toBe(original);
  } finally { swap?.mockRestore(); await app.close(); rmSync(root, { recursive: true, force: true }); }
});

test("indexes original notes and sources, resolves only verified links, and resynchronizes", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocf-knowledge-"));
  const external = join(root, "my-vault");
  const outside = join(root, "private.md");
  mkdirSync(join(external, "Research"), { recursive: true });
  writeFileSync(join(external, "Research", "Ideas.md"), "# Ideas\n原有笔记内容。\n[[Other]]\n[[Missing]]\n[source](../raw/sources/article.md#L2)\nsource_snapshot: raw/sources/article.md\n");
  writeFileSync(join(external, "Other.md"), "# Other\n可验证链接。\n");
  writeFileSync(outside, "private content");
  symlinkSync(outside, join(external, "Private.md"));
  const app = createApp({ dataDir: join(root, "data"), maintainerRoot });
  try {
    const adopted = await app.inject({ method: "POST", url: "/api/v1/vaults", headers,
      payload: { id: "research", path: external, adopt: true } });
    expect(adopted.statusCode).toBe(201);
    mkdirSync(join(external, "raw", "sources"), { recursive: true });
    const sourceBody = "# Imported source\nEvidence line\n";
    const fingerprint = createHash("sha256").update(sourceBody).digest("hex");
    writeFileSync(join(external, "raw", "sources", "article.md"), sourceBody);
    writeFileSync(join(external, ".ocf", "ingest-manifest.json"), JSON.stringify({ format_version: 1,
      sources: { [fingerprint]: { snapshot: "raw/sources/article.md", imported_at: "2026-10-23T10:00:00Z", origins: [{ url: "https://example.org" }] } } }));

    const rescan = await app.inject({ method: "POST", url: "/api/v1/knowledge/research/rescan", headers });
    expect(rescan.statusCode).toBe(200);
    expect(rescan.json()).toMatchObject({ sources: 1, notes: 2 });
    const analysisDb = new Database(join(root, "data", "state.sqlite"));
    try {
      analysisDb.prepare(`INSERT INTO source_analyses
        (vault_id, fingerprint, snapshot, status, card_json, updated_at) VALUES (?, ?, ?, 'proposed', '{}', ?)`)
        .run("research", fingerprint, "raw/sources/article.md", new Date().toISOString());
    } finally { analysisDb.close(); }
    await app.inject({ method: "POST", url: "/api/v1/knowledge/research/rescan", headers });
    const analyzed = await app.inject({ method: "GET", url: "/api/v1/knowledge/items?vaultId=research&kind=source&analysisStatus=analyzed" });
    expect(analyzed.json().items.map((item: { path: string }) => item.path)).toEqual(["raw/sources/article.md"]);
    const unanalyzed = await app.inject({ method: "GET", url: "/api/v1/knowledge/items?vaultId=research&kind=source&analysisStatus=none" });
    expect(unanalyzed.json().total).toBe(0);
    const overview = await app.inject({ method: "GET", url: "/api/v1/knowledge/overview?vaultId=research" });
    expect(overview.json().vaults[0].confirmedAnalyses).toBe(1);
    const list = await app.inject({ method: "GET", url: "/api/v1/knowledge/items?vaultId=research&q=原有笔记" });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toMatchObject([{ path: "Research/Ideas.md", kind: "note" }]);
    const graph = await app.inject({ method: "GET", url: "/api/v1/knowledge/graph/research" });
    expect(graph.statusCode).toBe(200);
    expect(graph.json().nodes).toHaveLength(3);
    expect(graph.json().edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "Research/Ideas.md", to: "Other.md", type: "wikilink" }),
      expect.objectContaining({ from: "Research/Ideas.md", to: "raw/sources/article.md", type: "markdown" }),
      expect.objectContaining({ from: "Research/Ideas.md", to: "raw/sources/article.md", type: "source_metadata" }),
    ]));
    expect(graph.json().issues).toEqual(expect.arrayContaining([expect.objectContaining({ from: "Research/Ideas.md", target: "Missing", reason: "missing" })]));
    const detail = await app.inject({ method: "GET", url: "/api/v1/knowledge/items/research?path=Other.md" });
    expect(detail.json().backlinks).toEqual(expect.arrayContaining([expect.objectContaining({ from: "Research/Ideas.md" })]));
    const escaped = await app.inject({ method: "GET", url: "/api/v1/knowledge/items/research?path=..%2Fprivate.md" });
    expect(escaped.statusCode).toBe(422);
    const future = await app.inject({ method: "GET", url: "/api/v1/knowledge/items?vaultId=research&modifiedSince=2100-01-01T00%3A00%3A00Z" });
    expect(future.json().total).toBe(0);

    writeFileSync(join(external, "Other.md"), "# Other\nChanged externally\n");
    rmSync(join(external, "Research", "Ideas.md"));
    await app.inject({ method: "POST", url: "/api/v1/knowledge/research/rescan", headers });
    const changed = await app.inject({ method: "GET", url: "/api/v1/knowledge/items?vaultId=research&q=Changed" });
    expect(changed.json().total).toBe(1);
    const removed = await app.inject({ method: "GET", url: "/api/v1/knowledge/items?vaultId=research&q=Ideas" });
    expect(removed.json().total).toBe(0);
    const privateFile = await app.inject({ method: "GET", url: "/api/v1/knowledge/items/research?path=Private.md" });
    expect(privateFile.statusCode).toBe(404);
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});

test("overview keeps ten recent items by default and accepts a bounded display limit", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocf-overview-limit-"));
  const external = join(root, "vault");
  mkdirSync(external);
  for (let index = 1; index <= 12; index++) {
    writeFileSync(join(external, `Note ${String(index).padStart(2, "0")}.md`), `# Note ${index}\n`);
  }
  const app = createApp({ dataDir: join(root, "data"), maintainerRoot });
  try {
    const adopted = await app.inject({ method: "POST", url: "/api/v1/vaults", headers,
      payload: { id: "overview-limit", path: external, adopt: true } });
    expect(adopted.statusCode).toBe(201);
    mkdirSync(join(external, "raw", "sources"), { recursive: true });
    const sources: Record<string, { snapshot: string; imported_at: string }> = {};
    for (let index = 1; index <= 12; index++) {
      const body = `# Source ${index}\n`;
      const fingerprint = createHash("sha256").update(body).digest("hex");
      const snapshot = `raw/sources/source-${index}.md`;
      writeFileSync(join(external, snapshot), body);
      sources[fingerprint] = { snapshot, imported_at: `2026-01-${String(index).padStart(2, "0")}T00:00:00Z` };
    }
    writeFileSync(join(external, ".ocf", "ingest-manifest.json"), JSON.stringify({ format_version: 1, sources }));
    await app.inject({ method: "POST", url: "/api/v1/knowledge/overview-limit/rescan", headers });
    const initial = await app.inject({ method: "GET", url: "/api/v1/knowledge/overview?vaultId=overview-limit" });
    expect(initial.json().recentNotes).toHaveLength(10);
    expect(initial.json().recentSources).toHaveLength(10);
    const expanded = await app.inject({ method: "GET", url: "/api/v1/knowledge/overview?vaultId=overview-limit&limit=20" });
    expect(expanded.statusCode).toBe(200);
    expect(expanded.json().recentNotes).toHaveLength(12);
    expect(expanded.json().recentSources).toHaveLength(12);
    expect(expanded.json().recentSources[0].title).toBe("Source 12");
    for (const limit of ["0", "51", "abc"]) {
      const invalid = await app.inject({ method: "GET", url: `/api/v1/knowledge/overview?limit=${limit}` });
      expect(invalid.statusCode).toBe(422);
    }
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});

test("graph includes a medium vault without arbitrarily truncating at 120 nodes", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocf-graph-limit-"));
  const external = join(root, "vault");
  mkdirSync(external);
  for (let index = 1; index <= 130; index++) {
    writeFileSync(join(external, `Note ${String(index).padStart(3, "0")}.md`), `# Note ${index}\n`);
  }
  const app = createApp({ dataDir: join(root, "data"), maintainerRoot });
  try {
    const adopted = await app.inject({ method: "POST", url: "/api/v1/vaults", headers,
      payload: { id: "graph-limit", path: external, adopt: true } });
    expect(adopted.statusCode).toBe(201);
    const graph = await app.inject({ method: "GET", url: "/api/v1/knowledge/graph/graph-limit" });
    expect(graph.statusCode).toBe(200);
    expect(graph.json()).toMatchObject({ totalNodes: 130, truncated: false });
    expect(graph.json().nodes).toHaveLength(130);
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});

test("disconnecting an external vault removes its index, retains notes, and restores built-in default", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocf-disconnect-"));
  const external = join(root, "vault");
  mkdirSync(external);
  writeFileSync(join(external, "Keep.md"), "# Keep\n");
  const app = createApp({ dataDir: join(root, "data"), maintainerRoot });
  try {
    await app.inject({ method: "POST", url: "/api/v1/vaults", headers, payload: { id: "keep", path: external, adopt: true } });
    await app.inject({ method: "PUT", url: "/api/v1/vaults/default", headers, payload: { vaultId: "keep" } });
    const builtIn = await app.inject({ method: "DELETE", url: "/api/v1/vaults/default", headers });
    expect(builtIn.statusCode).toBe(409);
    const removed = await app.inject({ method: "DELETE", url: "/api/v1/vaults/keep", headers });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ defaultVaultId: "default" });
    expect(existsSync(join(external, "Keep.md"))).toBe(true);
    expect(readFileSync(join(external, "Keep.md"), "utf8")).toBe("# Keep\n");
    const list = await app.inject({ method: "GET", url: "/api/v1/knowledge/items?vaultId=keep" });
    expect(list.statusCode).toBe(404);
    const reconnected = await app.inject({ method: "POST", url: "/api/v1/vaults", headers, payload: { id: "keep", path: external } });
    expect(reconnected.statusCode).toBe(201);
    const rebuilt = await app.inject({ method: "GET", url: "/api/v1/knowledge/items?vaultId=keep" });
    expect(rebuilt.json().items).toMatchObject([{ path: "Keep.md", kind: "note" }]);
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});

test("ambiguous wikilinks stay issues and generated index files are not counted as notes", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocf-links-"));
  const external = join(root, "vault");
  mkdirSync(join(external, "A"), { recursive: true });
  mkdirSync(join(external, "B"), { recursive: true });
  writeFileSync(join(external, "Start.md"), "# Start\n[[Same]]\n```md\n[[Ghost]]\n```\n[broken](bad%ZZ.md)\n");
  writeFileSync(join(external, "A", "Same.md"), "# Same A\n");
  writeFileSync(join(external, "B", "Same.md"), "# Same B\n");
  const app = createApp({ dataDir: join(root, "data"), maintainerRoot });
  try {
    const response = await app.inject({ method: "POST", url: "/api/v1/vaults", headers,
      payload: { id: "links", path: external, adopt: true } });
    expect(response.statusCode).toBe(201);
    const profilePath = join(external, ".ocf", "vault.json");
    const profile = JSON.parse(readFileSync(profilePath, "utf8"));
    profile.paths.index = "Index.md";
    profile.paths.log = "Log.md";
    writeFileSync(profilePath, JSON.stringify(profile));
    writeFileSync(join(external, "Index.md"), "# Curated index\n");
    writeFileSync(join(external, "Log.md"), "# Private log\n");
    const scan = await app.inject({ method: "POST", url: "/api/v1/knowledge/links/rescan", headers });
    expect(scan.statusCode).toBe(200);
    expect(scan.json().notes).toBe(3);
    const graph = await app.inject({ method: "GET", url: "/api/v1/knowledge/graph/links" });
    expect(graph.json().edges).toHaveLength(0);
    expect(graph.json().issues).toEqual([expect.objectContaining({ target: "Same", reason: "ambiguous" })]);
    const detail = await app.inject({ method: "GET", url: "/api/v1/knowledge/items/links?path=Start.md" });
    expect(detail.json().issues).toEqual([{ from: "Start.md", target: "Same", reason: "ambiguous", line: 2 }]);
    const overview = await app.inject({ method: "GET", url: "/api/v1/knowledge/overview?vaultId=links" });
    expect(overview.json().vaults[0].indexMarkdown).toContain("Curated index");
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});

test("external changes become visible on later reads when file watching is unavailable", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocf-watch-"));
  const external = join(root, "vault");
  mkdirSync(external);
  writeFileSync(join(external, "Live.md"), "# Live\nBefore edit\n");
  const app = createApp({ dataDir: join(root, "data"), maintainerRoot });
  try {
    await app.inject({ method: "POST", url: "/api/v1/vaults", headers, payload: { id: "live", path: external, adopt: true } });
    await app.inject({ method: "POST", url: "/api/v1/knowledge/live/rescan", headers });
    writeFileSync(join(external, "Live.md"), "# Live\nAfter Obsidian edit\n");
    let found = false;
    const deadline = Date.now() + 7000;
    while (!found && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 100));
      const listed = await app.inject({ method: "GET", url: "/api/v1/knowledge/items?vaultId=live&q=After%20Obsidian%20edit" });
      found = listed.json().total === 1;
    }
    expect(found).toBe(true);
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
}, 10_000);
