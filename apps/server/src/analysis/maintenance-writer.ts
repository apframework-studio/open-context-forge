import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { copyFile, link, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Vault } from "../vaults/registry.js";
import type { FileChange } from "./maintenance.js";
import { reconcileRolledBackWrite } from "./recovery.js";

const require = createRequire(import.meta.url);
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
export class MaintenanceWriteError extends Error { constructor(readonly code: string) { super(code); } }
type CheckIssue = { code: string; path?: string; detail?: string };

async function safeTarget(root: string, path: string, wiki: string, sources: string): Promise<string> {
  if (!path || isAbsolute(path) || path.includes("\\") || path.includes("\0") ||
    path.split("/").some((part) => !part || part === "." || part === "..") ||
    path.startsWith(".ocf/") || path.startsWith("raw/") || !path.endsWith(".md")) {
    throw new MaintenanceWriteError("INVALID_TARGET");
  }
  const target = resolve(root, path);
  const wikiRoot = resolve(root, wiki);
  const sourceRoot = resolve(root, sources);
  if (target === root || !target.startsWith(`${root}${sep}`) ||
    target === sourceRoot || target.startsWith(`${sourceRoot}${sep}`) ||
    (target !== wikiRoot && !target.startsWith(`${wikiRoot}${sep}`))) throw new MaintenanceWriteError("INVALID_TARGET");
  let cursor = root;
  for (const part of relative(root, target).split(sep)) {
    cursor = join(cursor, part);
    try { if ((await lstat(cursor)).isSymbolicLink()) throw new MaintenanceWriteError("INVALID_TARGET"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return target;
}

export async function applyMaintenanceChanges(vault: Vault, fingerprint: string, snapshot: string,
  changes: FileChange[], maintainerRoot: string,
  artifacts: { analysisMarkdown: string; planMarkdown: string; authorship?: string; author?: string | null }):
  Promise<{ files: string[]; warnings: string[] }> {
  const root = await realpath(vault.path);
  if (!/^[a-f\d]{64}$/.test(fingerprint) || !snapshot || isAbsolute(snapshot) ||
    snapshot.split("/").some((part) => part === ".." || part === ".")) throw new MaintenanceWriteError("SOURCE_CHANGED");
  const sourcePath = resolve(root, snapshot);
  if (!sourcePath.startsWith(`${root}${sep}`) || await realpath(sourcePath).catch(() => "") !== sourcePath) {
    throw new MaintenanceWriteError("SOURCE_CHANGED");
  }
  const source = await readFile(sourcePath);
  const manifest = JSON.parse(await readFile(join(root, ".ocf", "ingest-manifest.json"), "utf8")) as
    { sources?: Record<string, { snapshot?: string; authorship?: string; author?: string | null }> };
  if (sha(source) !== fingerprint || manifest.sources?.[fingerprint]?.snapshot !== snapshot) {
    throw new MaintenanceWriteError("SOURCE_CHANGED");
  }
  const metadata = manifest.sources[fingerprint];
  if ((artifacts.authorship !== undefined && (metadata.authorship ?? "unknown") !== artifacts.authorship) ||
    (artifacts.author !== undefined && (metadata.author ?? null) !== artifacts.author))
    throw new MaintenanceWriteError("SOURCE_METADATA_CHANGED");
  const profile = JSON.parse(await readFile(join(root, ".ocf", "vault.json"), "utf8")) as
    { mode: string; paths: { wiki: string; sources: string; index?: string; log?: string } };
  const allChanges = [...changes];
  const noteChanges = changes.filter((change) => ![profile.paths.index, profile.paths.log].includes(change.path));
  if (profile.mode === "standard" && noteChanges.length) {
    if (profile.paths.index && !changes.some((change) => change.path === profile.paths.index)) {
      const old = await readFile(join(root, profile.paths.index), "utf8");
      let content = old.replace(/\nNo compiled notes yet\.\n/, "\n");
      for (const note of noteChanges) {
        const link = relative(dirname(join(root, profile.paths.index)), join(root, note.path)).split(sep).join("/").replace(/\.md$/, "");
        const title = note.content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? note.path;
        if (!content.includes(`[[${link}|`)) content += `- [[${link}|${title}]]\n`;
      }
      allChanges.push({ action: "update", path: profile.paths.index, baseHash: sha(old), content, evidenceIds: [] });
    }
    if (profile.paths.log && !changes.some((change) => change.path === profile.paths.log)) {
      const old = await readFile(join(root, profile.paths.log), "utf8");
      const entries = noteChanges.map((change) => `- ${new Date().toISOString()} ${change.action} ${change.path} ← ${snapshot}`);
      allChanges.push({ action: "update", path: profile.paths.log, baseHash: sha(old),
        content: `${old.endsWith("\n") ? old : `${old}\n`}${entries.join("\n")}\n`, evidenceIds: [] });
    }
  }
  const sourceLines = source.toString("utf8").replace(/\r\n/g, "\n").split("\n");
  if (sourceLines.at(-1) === "") sourceLines.pop();
  const seen = new Set<string>();
  const prepared: { change: FileChange; target: string; original: Buffer | null }[] = [];
  for (const change of allChanges) {
    const target = await safeTarget(root, change.path, profile.paths.wiki, profile.paths.sources);
    if (seen.has(target)) throw new MaintenanceWriteError("DUPLICATE_TARGET");
    seen.add(target);
    let original: Buffer | null = null;
    if (existsSync(target)) original = await readFile(target);
    if (change.action === "create" && (original || change.baseHash !== null)) throw new MaintenanceWriteError("TARGET_EXISTS");
    if (change.action === "update" && (!original || sha(original) !== change.baseHash)) throw new MaintenanceWriteError("BASE_CHANGED");
    if (![profile.paths.index, profile.paths.log].includes(change.path)) {
      if (!Array.isArray(change.evidenceIds) || !change.evidenceIds.length) throw new MaintenanceWriteError("EVIDENCE_MISSING");
      const escaped = snapshot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const refs = [...change.content.matchAll(new RegExp(`${escaped}#L(\\d+)-L(\\d+)`, "g"))]
        .filter((match) => Number(match[1]) >= 1 && Number(match[2]) >= Number(match[1]) &&
          Number(match[2]) <= sourceLines.length);
      if (!refs.length) throw new MaintenanceWriteError("EVIDENCE_MISSING");
    }
    prepared.push({ change, target, original });
  }
  const checkNotes = require(join(maintainerRoot, "scripts", "check-notes.js")) as
    { checkNotes(input: { vault: string; note?: string }): { issues: CheckIssue[] } };
  const checkVault = require(join(maintainerRoot, "scripts", "check-vault.js")) as
    { checkVault(vault: string): { issues: CheckIssue[] } };
  const baseline = checkVault.checkVault(root).issues;
  const baselineKeys = new Set(baseline.map((issue) => JSON.stringify(issue)));
  const processDir = join(root, ".ocf", "compilations", fingerprint);
  if (await realpath(join(root, ".ocf")) !== join(root, ".ocf")) throw new MaintenanceWriteError("INVALID_TARGET");
  const compilations = join(root, ".ocf", "compilations");
  if (existsSync(compilations) && await realpath(compilations) !== compilations) throw new MaintenanceWriteError("INVALID_TARGET");
  await mkdir(processDir, { recursive: true });
  if (await realpath(processDir) !== processDir) throw new MaintenanceWriteError("INVALID_TARGET");
  const analysisPath = join(processDir, "analysis.md");
  const planPath = join(processDir, "plan.md");
  const journal = join(processDir, "journal.json");
  let revising = false;
  if (existsSync(journal)) {
    let prior: { status?: string; paths?: unknown[] };
    try { prior = JSON.parse(await readFile(journal, "utf8")) as typeof prior; }
    catch { throw new MaintenanceWriteError("PROCESS_ARTIFACT_EXISTS"); }
    const oldPlan = existsSync(planPath) ? await readFile(planPath, "utf8") : "";
    revising = prior.status === "complete" && Array.isArray(prior.paths) && prior.paths.length === 0 &&
      /^- Decision: ask_user$/m.test(oldPlan) ||
      prior.status === "rolled_back" && await reconcileRolledBackWrite(vault, fingerprint, snapshot);
    if (!revising) throw new MaintenanceWriteError("PROCESS_ARTIFACT_EXISTS");
  }
  if (existsSync(analysisPath)) {
    const existing = await readFile(analysisPath, "utf8");
    if (!existing.includes(fingerprint) || !existing.includes(snapshot)) throw new MaintenanceWriteError("PROCESS_ARTIFACT_EXISTS");
  }
  if (!revising && existsSync(planPath) && await readFile(planPath, "utf8") !== artifacts.planMarkdown) {
    throw new MaintenanceWriteError("PROCESS_ARTIFACT_EXISTS");
  }
  const journalPaths = prepared.map(({ change, original }) =>
    ({ path: change.path, action: change.action, baseHash: original ? sha(original) : null,
      afterHash: sha(change.content) }));
  const journalContent = JSON.stringify({ status: "writing", fingerprint, snapshot,
    analysisHash: sha(artifacts.analysisMarkdown), planHash: sha(artifacts.planMarkdown), paths: journalPaths });
  if (revising) {
    const historyRoot = join(processDir, "history");
    if (existsSync(historyRoot) && await realpath(historyRoot) !== historyRoot) throw new MaintenanceWriteError("INVALID_TARGET");
    const history = join(historyRoot, `${Date.now()}-${randomUUID()}`);
    await mkdir(history, { recursive: true });
    for (const path of [analysisPath, planPath, journal]) {
      if (existsSync(path)) await copyFile(path, join(history, path.split(sep).at(-1)!));
    }
    for (const [path, content] of [[analysisPath, artifacts.analysisMarkdown], [planPath, artifacts.planMarkdown],
      [journal, journalContent]] as const) {
      const temporary = `${path}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, content, { flag: "wx" }); await rename(temporary, path); }
      finally { await rm(temporary, { force: true }); }
    }
  } else {
    if (!existsSync(analysisPath)) await writeFile(analysisPath, artifacts.analysisMarkdown, { flag: "wx" });
    if (!existsSync(planPath)) await writeFile(planPath, artifacts.planMarkdown, { flag: "wx" });
    await writeFile(journal, journalContent, { flag: "wx" });
  }
  const written: typeof prepared = [];
  try {
    for (const entry of prepared) {
      await mkdir(dirname(entry.target), { recursive: true });
      if (entry.original) {
        const current = await readFile(entry.target);
        if (sha(current) !== sha(entry.original)) throw new MaintenanceWriteError("BASE_CHANGED");
      } else if (existsSync(entry.target)) throw new MaintenanceWriteError("TARGET_EXISTS");
      const temp = `${entry.target}.${randomUUID()}.tmp`;
      await writeFile(temp, entry.change.content, { flag: "wx" });
      try {
        if (entry.original) await rename(temp, entry.target);
        else { await link(temp, entry.target); await rm(temp); }
      } finally { await rm(temp, { force: true }); }
      written.push(entry);
    }
    for (const entry of prepared) {
      const issues = checkNotes.checkNotes({ vault: root, note: entry.change.path }).issues;
      if (issues.length) throw new MaintenanceWriteError("NOTE_VALIDATION_FAILED");
    }
    const newIssues = checkVault.checkVault(root).issues.filter((issue) => !baselineKeys.has(JSON.stringify(issue)));
    if (newIssues.length) throw new MaintenanceWriteError("VAULT_VALIDATION_FAILED");
    await writeFile(journal, JSON.stringify({ status: "complete", fingerprint, snapshot,
      analysisHash: sha(artifacts.analysisMarkdown), planHash: sha(artifacts.planMarkdown), paths: journalPaths }));
    return { files: prepared.map(({ change }) => change.path), warnings: baseline.map((issue) => issue.code) };
  } catch (error) {
    let restored = true;
    for (const entry of written.reverse()) {
      try {
        if (entry.original) await writeFile(entry.target, entry.original);
        else await rm(entry.target, { force: true });
      } catch { restored = false; }
    }
    await writeFile(journal, JSON.stringify({ status: restored ? "rolled_back" : "needs_attention",
      fingerprint, snapshot, analysisHash: sha(artifacts.analysisMarkdown),
      planHash: sha(artifacts.planMarkdown), paths: journalPaths }));
    if (!restored) throw new MaintenanceWriteError("PARTIAL_WRITE");
    throw error;
  }
}
