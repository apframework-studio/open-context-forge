import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { accessSync, constants, lstatSync, readFileSync, readdirSync, realpathSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { VaultRegistry } from "./registry.js";

type Kind = "source" | "note";
type LinkType = "wikilink" | "markdown" | "source_metadata";
export interface KnowledgeItem {
  vaultId: string; path: string; kind: Kind; title: string; body: string; modifiedAt: string;
  importedAt: string | null; fingerprint: string | null; originalUrl: string | null;
  analysisStatus: string | null; folder: string; snippet?: string;
}
type KnowledgeSummary = Omit<KnowledgeItem, "body">;
export interface KnowledgeLink { from: string; to: string; type: LinkType; line: number; target: string }
export interface KnowledgeIssue { from: string; target: string; reason: "missing" | "ambiguous"; line: number }
type Profile = { paths: { wiki: string; sources: string; index?: string; log?: string } };
type Manifest = { sources?: Record<string, { snapshot: string; imported_at?: string; authorship?: string; author?: string | null; origins?: { url?: string }[] }> };
const maxFileBytes = 2 * 1024 * 1024;
const maxNodes = 10_000;

export class KnowledgeError extends Error {
  constructor(readonly code: "VAULT_NOT_FOUND" | "KNOWLEDGE_ITEM_NOT_FOUND" | "KNOWLEDGE_ITEM_CHANGED" | "INVALID_KNOWLEDGE_PATH" | "INVALID_KNOWLEDGE_QUERY", readonly status: number) { super(code); }
}

function safeRelative(path: string): string | null {
  if (!path || isAbsolute(path) || path.includes("\0") || path.includes("\\")) return null;
  const clean = normalize(path).split(sep).join("/");
  return clean === ".." || clean.startsWith("../") ? null : clean;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !rel.startsWith("..") && !isAbsolute(rel);
}

function safeFile(root: string, rel: string): string | null {
  const clean = safeRelative(rel);
  if (!clean) return null;
  try {
    const target = resolve(root, clean);
    if (!inside(root, target)) return null;
    let cursor = root;
    for (const segment of clean.split("/")) {
      cursor = join(cursor, segment);
      if (lstatSync(cursor).isSymbolicLink()) return null;
    }
    const real = realpathSync(target);
    return inside(root, real) && lstatSync(real).isFile() ? real : null;
  } catch { return null; }
}

function firstHeading(body: string, path: string): string {
  return body.match(/^#\s+(.+)$/m)?.[1]?.trim() || basename(path, extname(path));
}

function cleanLinkText(body: string): string {
  return body.replace(/^\s*(```|~~~)[^\n]*\n[\s\S]*?^\s*\1[^\n]*$/gm, "").replace(/`[^`\n]+`/g, "");
}

function parsedLinks(item: KnowledgeItem): { target: string; type: LinkType; line: number }[] {
  if (item.kind !== "note") return [];
  const body = cleanLinkText(item.body);
  const lines = body.split("\n");
  const links: { target: string; type: LinkType; line: number }[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    for (const match of line.matchAll(/\[\[([^\]]+)\]\]/g)) links.push({ target: match[1].split("|")[0].split("#")[0].trim(), type: "wikilink", line: index + 1 });
    for (const match of line.matchAll(/(?<!!)\[[^\]]*\]\(([^)]+)\)/g)) {
      let target: string;
      try { target = decodeURIComponent(match[1].split("#")[0].trim()); }
      catch { continue; }
      if (target && !/^[a-z][a-z\d+.-]*:/i.test(target) && !target.startsWith("/")) links.push({ target, type: "markdown", line: index + 1 });
    }
    const metadata = line.match(/^\s*(?:source_snapshot|source_fingerprint):\s*["']?([^"'\s]+)["']?/);
    if (metadata) links.push({ target: metadata[1], type: "source_metadata", line: index + 1 });
  }
  return links.filter((link) => !!link.target);
}

export class KnowledgeIndex {
  private lastRefresh = new Map<string, number>();
  private watchers = new Map<string, FSWatcher>();
  private refreshTimers = new Map<string, NodeJS.Timeout>();
  constructor(private readonly db: Database.Database, private readonly registry: VaultRegistry) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_items (
        vault_id TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
        body TEXT NOT NULL, modified_at TEXT NOT NULL, imported_at TEXT, fingerprint TEXT,
        original_url TEXT, analysis_status TEXT, folder TEXT NOT NULL,
        PRIMARY KEY(vault_id,path)
      );
      CREATE TABLE IF NOT EXISTS knowledge_links (
        vault_id TEXT NOT NULL, from_path TEXT NOT NULL, to_path TEXT, type TEXT NOT NULL,
        target TEXT NOT NULL, line INTEGER NOT NULL, issue TEXT,
        PRIMARY KEY(vault_id,from_path,type,target,line)
      );
      CREATE TABLE IF NOT EXISTS knowledge_state (
        vault_id TEXT PRIMARY KEY, indexed_at TEXT NOT NULL, errors_json TEXT NOT NULL,
        index_markdown TEXT
      );
      CREATE INDEX IF NOT EXISTS knowledge_items_kind ON knowledge_items(vault_id,kind,modified_at);
      CREATE INDEX IF NOT EXISTS knowledge_links_to ON knowledge_links(vault_id,to_path);
    `);
  }

  private vault(id: string) {
    const vault = this.registry.get(id);
    if (!vault) throw new KnowledgeError("VAULT_NOT_FOUND", 404);
    return vault;
  }

  private rows(vaultId?: string): KnowledgeSummary[] {
    const sql = `SELECT vault_id AS vaultId,path,kind,title,modified_at AS modifiedAt,
      imported_at AS importedAt,fingerprint,original_url AS originalUrl,analysis_status AS analysisStatus,folder
      FROM knowledge_items ${vaultId ? "WHERE vault_id = ?" : ""}`;
    return (vaultId ? this.db.prepare(sql).all(vaultId) : this.db.prepare(sql).all()) as KnowledgeSummary[];
  }

  private bodyFor(vaultId: string, path: string): string {
    const result = this.db.prepare("SELECT body FROM knowledge_items WHERE vault_id = ? AND path = ?")
      .get(vaultId, path) as { body: string } | undefined;
    return result?.body ?? "";
  }

  refresh(vaultId: string) {
    const vault = this.vault(vaultId);
    const root = vault.path;
    const profile = JSON.parse(readFileSync(join(root, ".ocf", "vault.json"), "utf8")) as Profile;
    const sourcesDir = safeRelative(profile.paths.sources);
    const wikiDir = safeRelative(profile.paths.wiki);
    if (!sourcesDir || !wikiDir) throw new KnowledgeError("INVALID_KNOWLEDGE_PATH", 422);
    const excluded = new Set([profile.paths.index, profile.paths.log].filter(Boolean).map((value) => safeRelative(value!)));
    const errors: string[] = [];
    const items: KnowledgeItem[] = [];
    const add = (path: string, kind: Kind, importedAt: string | null, fingerprint: string | null, originalUrl: string | null) => {
      const safe = safeFile(root, path);
      if (!safe) { errors.push(`无法读取：${path}`); return; }
      const stat = lstatSync(safe);
      if (stat.size > maxFileBytes) { errors.push(`文件超过 2 MiB：${path}`); return; }
      const body = readFileSync(safe, "utf8");
      if (kind === "source" && fingerprint && createHash("sha256").update(body).digest("hex") !== fingerprint) {
        errors.push(`来源指纹不匹配：${path}`);
      }
      const row = kind === "source" ? this.db.prepare("SELECT status FROM source_analyses WHERE vault_id = ? AND fingerprint = ?")
        .get(vaultId, fingerprint) as { status: string } | undefined : undefined;
      const imported = kind === "source" ? this.db.prepare(`SELECT i.payload_json FROM import_items i JOIN import_item_vaults m
        ON m.batch_id = i.batch_id AND m.capture_id = i.capture_id
        WHERE m.vault_id = ? AND m.fingerprint = ? LIMIT 1`)
        .get(vaultId, fingerprint) as { payload_json: string } | undefined : undefined;
      const capture = imported ? JSON.parse(imported.payload_json) as { title?: string; originalUrl?: string } : null;
      items.push({ vaultId, path, kind, title: capture?.title || firstHeading(body, path), body,
        modifiedAt: stat.mtime.toISOString(), importedAt, fingerprint, originalUrl: capture?.originalUrl || originalUrl,
        analysisStatus: row?.status ?? null, folder: dirname(path) === "." ? "" : dirname(path).split(sep).join("/") });
    };
    try {
      const manifest = JSON.parse(readFileSync(join(root, ".ocf", "ingest-manifest.json"), "utf8")) as Manifest;
      for (const [fingerprint, source] of Object.entries(manifest.sources ?? {})) {
        const path = safeRelative(source.snapshot);
        if (!/^[a-f\d]{64}$/.test(fingerprint) || !path || !path.startsWith(`${sourcesDir}/`) || extname(path).toLowerCase() !== ".md") {
          errors.push(`无效来源记录：${fingerprint}`); continue;
        }
        add(path, "source", source.imported_at ?? null, fingerprint, source.origins?.[0]?.url ?? null);
      }
    } catch { errors.push("来源清单无法读取"); }
    const visit = (rel: string) => {
      const path = resolve(root, rel);
      try {
        if (!inside(root, path) || !inside(root, realpathSync(path)) ||
          (rel !== "." && rel.split("/").some((segment, index, all) => lstatSync(resolve(root, ...all.slice(0, index + 1))).isSymbolicLink()))) {
          errors.push(`目录越界或符号链接：${rel}`); return;
        }
        for (const entry of readdirSync(path, { withFileTypes: true })) {
          if (items.length >= maxNodes) { errors.push("索引达到 10000 个文件上限"); return; }
          if (entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
          const child = join(rel, entry.name).split(sep).join("/");
          if (child === sourcesDir || child.startsWith(`${sourcesDir}/`) || child === ".ocf" || child.startsWith(".ocf/")) continue;
          if (entry.isDirectory()) visit(child);
          else if (entry.isFile() && extname(entry.name).toLowerCase() === ".md" && !excluded.has(child)) add(child, "note", null, null, null);
        }
      } catch { errors.push(`目录无法读取：${rel}`); }
    };
    visit(wikiDir);
    const lookup = new Map(items.map((item) => [item.path.toLowerCase(), item]));
    const basenameIndex = new Map<string, KnowledgeItem[]>();
    for (const item of items) {
      const key = basename(item.path, ".md").toLowerCase();
      basenameIndex.set(key, [...(basenameIndex.get(key) ?? []), item]);
    }
    const links: (KnowledgeLink & { issue: string | null })[] = [];
    for (const item of items) for (const link of parsedLinks(item)) {
      let candidates: KnowledgeItem[] = [];
      if (link.type === "source_metadata" && /^[a-f\d]{64}$/.test(link.target)) candidates = items.filter((node) => node.fingerprint === link.target);
      else {
        const raw = link.target.replace(/\\/g, "/");
        const relativeTarget = safeRelative(join(dirname(item.path), raw));
        const exactTargets = [relativeTarget, relativeTarget && `${relativeTarget}.md`, safeRelative(raw), safeRelative(`${raw}.md`)].filter((value): value is string => !!value);
        for (const target of exactTargets) { const found = lookup.get(target.toLowerCase()); if (found) { candidates = [found]; break; } }
        if (!candidates.length && link.type === "wikilink" && !raw.includes("/")) candidates = basenameIndex.get(basename(raw, ".md").toLowerCase()) ?? [];
      }
      links.push({ from: item.path, to: candidates.length === 1 ? candidates[0].path : "", type: link.type,
        target: link.target, line: link.line, issue: candidates.length > 1 ? "ambiguous" : candidates.length === 0 ? "missing" : null });
    }
    const indexPath = profile.paths.index ? safeFile(root, profile.paths.index) : null;
    const indexMarkdown = indexPath && lstatSync(indexPath).size <= maxFileBytes ? readFileSync(indexPath, "utf8") : null;
    const indexedAt = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM knowledge_links WHERE vault_id = ?").run(vaultId);
      this.db.prepare("DELETE FROM knowledge_items WHERE vault_id = ?").run(vaultId);
      const insertItem = this.db.prepare(`INSERT INTO knowledge_items
        (vault_id,path,kind,title,body,modified_at,imported_at,fingerprint,original_url,analysis_status,folder)
        VALUES (@vaultId,@path,@kind,@title,@body,@modifiedAt,@importedAt,@fingerprint,@originalUrl,@analysisStatus,@folder)`);
      for (const item of items) insertItem.run(item);
      const insertLink = this.db.prepare(`INSERT OR IGNORE INTO knowledge_links
        (vault_id,from_path,to_path,type,target,line,issue) VALUES (?,?,?,?,?,?,?)`);
      for (const link of links) insertLink.run(vaultId, link.from, link.to || null, link.type, link.target, link.line, link.issue);
      this.db.prepare(`INSERT INTO knowledge_state(vault_id,indexed_at,errors_json,index_markdown) VALUES (?,?,?,?)
        ON CONFLICT(vault_id) DO UPDATE SET indexed_at=excluded.indexed_at,errors_json=excluded.errors_json,index_markdown=excluded.index_markdown`)
        .run(vaultId, indexedAt, JSON.stringify(errors), indexMarkdown);
    })();
    this.lastRefresh.set(vaultId, Date.now());
    if (!this.watchers.has(vaultId)) {
      try {
        const watcher = watch(root, { recursive: true }, () => {
          const pending = this.refreshTimers.get(vaultId);
          if (pending) clearTimeout(pending);
          this.refreshTimers.set(vaultId, setTimeout(() => {
            this.refreshTimers.delete(vaultId);
            try { this.refresh(vaultId); } catch { /* Manual rescan remains available. */ }
          }, 450));
        });
        watcher.on("error", () => { watcher.close(); this.watchers.delete(vaultId); });
        this.watchers.set(vaultId, watcher);
      } catch { /* Filesystem watching may be unavailable; reads still refresh on a timer. */ }
    }
    return { vaultId, sources: items.filter((item) => item.kind === "source").length,
      notes: items.filter((item) => item.kind === "note").length, indexedAt, errors };
  }

  ensureFresh(vaultId: string) {
    this.vault(vaultId);
    if (Date.now() - (this.lastRefresh.get(vaultId) ?? 0) > 5000) this.refresh(vaultId);
  }

  list(options: { vaultId?: string; q?: string; kind?: Kind; folder?: string; analysisStatus?: string; modifiedSince?: string; sort?: string; page: number; pageSize: number }) {
    for (const vault of options.vaultId ? [this.vault(options.vaultId)] : this.registry.list().vaults) this.ensureFresh(vault.id);
    const query = options.q?.trim().toLocaleLowerCase() ?? "";
    const matched = query ? new Set((this.db.prepare(`SELECT vault_id AS vaultId,path FROM knowledge_items
      WHERE ${options.vaultId ? "vault_id = ? AND" : ""} (instr(lower(title), ?) > 0 OR instr(lower(path), ?) > 0 OR instr(lower(body), ?) > 0)`)
      .all(...(options.vaultId ? [options.vaultId] : []), query, query, query) as { vaultId: string; path: string }[])
      .map((row) => `${row.vaultId}:${row.path}`)) : null;
    let items = this.rows(options.vaultId).filter((item) =>
      (!options.kind || item.kind === options.kind) && (!options.folder || item.folder === options.folder || item.folder.startsWith(`${options.folder}/`)) &&
      (!options.analysisStatus || (options.analysisStatus === "analyzed" ? !!item.analysisStatus :
        options.analysisStatus === "none" ? !item.analysisStatus : item.analysisStatus === options.analysisStatus)) &&
      (!options.modifiedSince || item.modifiedAt >= options.modifiedSince) &&
      (!matched || matched.has(`${item.vaultId}:${item.path}`)));
    items = items.sort((a, b) => options.sort === "title" ? a.title.localeCompare(b.title) :
      options.sort === "modified" ? b.modifiedAt.localeCompare(a.modifiedAt) :
        (b.importedAt ?? b.modifiedAt).localeCompare(a.importedAt ?? a.modifiedAt));
    return { total: items.length, page: options.page, pageSize: options.pageSize,
      items: items.slice((options.page - 1) * options.pageSize, options.page * options.pageSize).map((item) => {
        const body = this.bodyFor(item.vaultId, item.path);
        const hit = body.toLocaleLowerCase().indexOf(query);
        return { ...item, snippet: query && hit >= 0 ? body.slice(Math.max(0, hit - 55), hit + query.length + 90) : body.slice(0, 120) };
      }) };
  }

  folders(vaultId?: string) {
    for (const vault of vaultId ? [this.vault(vaultId)] : this.registry.list().vaults) this.ensureFresh(vault.id);
    const counts = new Map<string, number>();
    for (const item of this.rows(vaultId)) {
      const parts = item.folder ? item.folder.split("/") : [];
      counts.set(`${item.vaultId}:`, (counts.get(`${item.vaultId}:`) ?? 0) + 1);
      for (let i = 1; i <= parts.length; i++) {
        const key = `${item.vaultId}:${parts.slice(0, i).join("/")}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return [...counts].map(([key, count]) => {
      const split = key.indexOf(":"); return { vaultId: key.slice(0, split), path: key.slice(split + 1), count };
    }).sort((a, b) => a.vaultId.localeCompare(b.vaultId) || a.path.localeCompare(b.path));
  }

  detail(vaultId: string, path: string) {
    const vault = this.vault(vaultId);
    const clean = safeRelative(path);
    if (!clean) throw new KnowledgeError("INVALID_KNOWLEDGE_PATH", 422);
    this.ensureFresh(vaultId);
    const item = this.rows(vaultId).find((row) => row.path === clean);
    if (!item) throw new KnowledgeError("KNOWLEDGE_ITEM_NOT_FOUND", 404);
    const real = safeFile(vault.path, clean);
    if (!real) throw new KnowledgeError("KNOWLEDGE_ITEM_NOT_FOUND", 404);
    const markdown = readFileSync(real, "utf8");
    if (item.kind === "source" && createHash("sha256").update(markdown).digest("hex") !== item.fingerprint) {
      throw new KnowledgeError("KNOWLEDGE_ITEM_CHANGED", 409);
    }
    const links = this.linkRows(vaultId);
    let authorship: string | null = null;
    let author: string | null = null;
    if (item.kind === "source" && item.fingerprint) {
      try {
        const manifest = JSON.parse(readFileSync(join(vault.path, ".ocf", "ingest-manifest.json"), "utf8")) as Manifest;
        const source = manifest.sources?.[item.fingerprint];
        authorship = source?.authorship ?? null;
        author = source?.author ?? null;
      } catch { /* The source itself remains readable; overview reports manifest errors on rescan. */ }
    }
    return { ...item, markdown, absolutePath: real,
      authorship, author,
      outlinks: links.filter((link) => link.from === clean && link.to),
      backlinks: links.filter((link) => link.to === clean),
      issues: links.filter((link) => link.from === clean && link.issue) };
  }

  private linkRows(vaultId: string): (KnowledgeLink & { issue: string | null })[] {
    return this.db.prepare(`SELECT from_path AS 'from',to_path AS 'to',type,target,line,issue
      FROM knowledge_links WHERE vault_id = ?`).all(vaultId) as (KnowledgeLink & { issue: string | null })[];
  }

  graph(vaultId: string, options: { q?: string; kind?: Kind; focus?: string; limit?: number } = {}) {
    this.ensureFresh(vaultId);
    const all = this.rows(vaultId);
    const links = this.linkRows(vaultId);
    let selected = all.filter((item) => (!options.kind || item.kind === options.kind) &&
      (options.focus || !options.q || `${item.title} ${item.path}`.toLocaleLowerCase().includes(options.q.toLocaleLowerCase())));
    if (options.focus) {
      const neighbors = new Set([options.focus, ...links.filter((link) => link.from === options.focus || link.to === options.focus).flatMap((link) => [link.from, link.to])]);
      selected = selected.filter((item) => neighbors.has(item.path));
    }
    const totalNodes = selected.length;
    selected = selected.sort((a, b) => a.path.localeCompare(b.path)).slice(0, options.limit ?? 120);
    const paths = new Set(selected.map((item) => item.path));
    return { vaultId, nodes: selected, totalNodes, truncated: selected.length < totalNodes,
      edges: links.filter((link) => !!link.to && paths.has(link.from) && paths.has(link.to)).map(({ issue, ...link }) => link),
      issues: links.filter((link) => !!link.issue && paths.has(link.from)).map((link) =>
        ({ from: link.from, target: link.target, reason: link.issue, line: link.line })) as KnowledgeIssue[] };
  }

  overview(vaultId?: string) {
    const vaults = vaultId ? [this.vault(vaultId)] : this.registry.list().vaults;
    const summaries = vaults.map((vault) => {
      this.ensureFresh(vault.id);
      const state = this.db.prepare("SELECT indexed_at AS indexedAt,errors_json AS errorsJson,index_markdown AS indexMarkdown FROM knowledge_state WHERE vault_id = ?")
        .get(vault.id) as { indexedAt: string; errorsJson: string; indexMarkdown: string | null };
      const items = this.rows(vault.id);
      let readable = true; let writable = true;
      try { accessSync(vault.path, constants.R_OK); } catch { readable = false; }
      try { accessSync(vault.path, constants.W_OK); } catch { writable = false; }
      return { ...vault, sources: items.filter((item) => item.kind === "source").length,
        notes: items.filter((item) => item.kind === "note").length,
        confirmedAnalyses: items.filter((item) => !!item.analysisStatus).length,
        indexedAt: state.indexedAt, errors: JSON.parse(state.errorsJson) as string[], indexMarkdown: state.indexMarkdown,
        readable, writable, watching: this.watchers.has(vault.id) };
    });
    const items = this.rows(vaultId);
    return { vaults: summaries,
      recentSources: items.filter((item) => item.kind === "source").sort((a, b) => (b.importedAt ?? "").localeCompare(a.importedAt ?? "")).slice(0, 8),
      recentNotes: items.filter((item) => item.kind === "note").sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, 8) };
  }

  forget(vaultId: string) {
    this.db.transaction(() => {
      for (const table of ["knowledge_links", "knowledge_items", "knowledge_state"]) this.db.prepare(`DELETE FROM ${table} WHERE vault_id = ?`).run(vaultId);
    })();
    this.lastRefresh.delete(vaultId);
    this.watchers.get(vaultId)?.close(); this.watchers.delete(vaultId);
    const timer = this.refreshTimers.get(vaultId);
    if (timer) clearTimeout(timer);
    this.refreshTimers.delete(vaultId);
  }

  close() {
    for (const vaultId of this.watchers.keys()) {
      this.watchers.get(vaultId)?.close();
    }
    this.watchers.clear();
    for (const timer of this.refreshTimers.values()) clearTimeout(timer);
    this.refreshTimers.clear();
  }
}
