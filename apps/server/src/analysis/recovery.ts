import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Vault } from "../vaults/registry.js";
import { verifiedSnapshot } from "../import/filing-recovery.js";

type Journal = {
  status?: string; fingerprint?: string; snapshot?: string; analysisHash?: string; planHash?: string;
  paths?: { path?: string; baseHash?: string | null; afterHash?: string }[];
};
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const validHash = (value: unknown): value is string => typeof value === "string" && /^[a-f\d]{64}$/.test(value);

export async function reconcileMaintenanceWrite(vault: Vault, fingerprint: string, snapshot: string):
  Promise<{ files: string[] } | null> {
  if (!await verifiedSnapshot(vault.path, snapshot, fingerprint)) return null;
  try {
    const root = await realpath(vault.path);
    const processDir = join(root, ".ocf", "compilations", fingerprint);
    if (await realpath(processDir) !== processDir) return null;
    const journal = JSON.parse(await readFile(join(processDir, "journal.json"), "utf8")) as Journal;
    if (journal.status !== "complete" || journal.fingerprint !== fingerprint || journal.snapshot !== snapshot ||
      !validHash(journal.analysisHash) || !validHash(journal.planHash) || !Array.isArray(journal.paths) ||
      journal.paths.length > 14) return null;
    if (hash(await readFile(join(processDir, "analysis.md"))) !== journal.analysisHash ||
      hash(await readFile(join(processDir, "plan.md"))) !== journal.planHash) return null;
    const profile = JSON.parse(await readFile(join(root, ".ocf", "vault.json"), "utf8")) as {
      paths?: { wiki?: string } };
    if (!profile.paths?.wiki) return null;
    const wiki = resolve(root, profile.paths.wiki);
    const seen = new Set<string>();
    for (const entry of journal.paths) {
      const name = entry.path;
      if (!name || !validHash(entry.afterHash) || isAbsolute(name) || name.includes("\\") ||
        name.split("/").some((part) => !part || part === "." || part === "..")) return null;
      const target = resolve(root, name);
      const rel = relative(root, target);
      if (!rel || rel.startsWith("..") || isAbsolute(rel) || !target.startsWith(`${root}${sep}`) ||
        (target !== wiki && !target.startsWith(`${wiki}${sep}`)) || seen.has(target) ||
        await realpath(target) !== target || hash(await readFile(target)) !== entry.afterHash) return null;
      seen.add(target);
    }
    return { files: journal.paths.map((entry) => entry.path!) };
  } catch { return null; }
}

export async function reconcileRolledBackWrite(vault: Vault, fingerprint: string, snapshot: string): Promise<boolean> {
  if (!await verifiedSnapshot(vault.path, snapshot, fingerprint)) return false;
  try {
    const root = await realpath(vault.path);
    const processDir = join(root, ".ocf", "compilations", fingerprint);
    if (await realpath(processDir) !== processDir) return false;
    const artifactPaths = ["analysis.md", "plan.md", "journal.json"].map((name) => join(processDir, name));
    for (const path of artifactPaths) if (await realpath(path) !== path) return false;
    const journal = JSON.parse(await readFile(artifactPaths[2], "utf8")) as Journal;
    if (journal.status !== "rolled_back" || journal.fingerprint !== fingerprint || journal.snapshot !== snapshot ||
      !validHash(journal.analysisHash) || !validHash(journal.planHash) || !Array.isArray(journal.paths) ||
      journal.paths.length > 14 ||
      hash(await readFile(artifactPaths[0])) !== journal.analysisHash ||
      hash(await readFile(artifactPaths[1])) !== journal.planHash) return false;
    const profile = JSON.parse(await readFile(join(root, ".ocf", "vault.json"), "utf8")) as {
      paths?: { wiki?: string } };
    if (!profile.paths?.wiki) return false;
    const wiki = resolve(root, profile.paths.wiki);
    const seen = new Set<string>();
    for (const entry of journal.paths) {
      const name = entry.path;
      if (!name || !validHash(entry.afterHash) ||
        (entry.baseHash !== null && !validHash(entry.baseHash)) || isAbsolute(name) || name.includes("\\") ||
        name.split("/").some((part) => !part || part === "." || part === "..")) return false;
      const target = resolve(root, name);
      const rel = relative(root, target);
      if (!rel || rel.startsWith("..") || isAbsolute(rel) || !target.startsWith(`${root}${sep}`) ||
        (target !== wiki && !target.startsWith(`${wiki}${sep}`)) || seen.has(target)) return false;
      seen.add(target);
      let cursor = root;
      for (const part of rel.split(sep)) {
        cursor = join(cursor, part);
        let info;
        try { info = await lstat(cursor); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        if (info.isSymbolicLink()) return false;
      }
      if (entry.baseHash === null) {
        try { await lstat(target); return false; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      } else if (hash(await readFile(target)) !== entry.baseHash) return false;
    }
    return true;
  } catch { return false; }
}
