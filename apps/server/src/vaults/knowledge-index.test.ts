import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import Database from "better-sqlite3";
import { createApp } from "../app.js";

const maintainerRoot = resolve(process.cwd(), "../../../open-context-forge-vault-maintainer");
const headers = { "x-ocf-client": "1" };

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
