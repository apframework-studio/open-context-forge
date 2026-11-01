import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CaptureCandidate } from "@ocf/contracts";
import { runTool } from "../process/run.js";

export interface SnapshotResult {
  snapshot: string;
  fingerprint: string;
  duplicate: boolean;
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

export function renderCaptureMarkdown(candidate: CaptureCandidate): string {
  return [
    `# ${oneLine(candidate.title)}`,
    "",
    candidate.originalUrl ? `- 来源：${candidate.originalUrl}` : `- 本地文件：${oneLine(candidate.sourceFilename ?? "未命名文件")}`,
    `- ${candidate.originalUrl ? "抓取" : "导入"}时间：${candidate.capturedAt}`,
    ...(candidate.note ? [`- 备注：${oneLine(candidate.note)}`] : []),
    `- ${candidate.originalUrl ? "Clipper " : ""}内容指纹：${candidate.contentHash}`,
    "",
    "---",
    "",
    candidate.markdown,
    "",
  ].join("\n");
}

export async function importSnapshot(candidate: CaptureCandidate, vaultPath: string, maintainerRoot: string): Promise<SnapshotResult> {
  const tempDir = await mkdtemp(join(tmpdir(), "ocf-source-"));
  const localName = candidate.sourceFilename ? basename(candidate.sourceFilename).replace(/[^\p{L}\p{N}._-]/gu, "-").slice(0, 120) : "";
  const temporaryMarkdown = join(tempDir, localName || "source.md");
  const metadata = renderCaptureMarkdown(candidate);

  try {
    await writeFile(temporaryMarkdown, metadata, { flag: "wx" });
    const args = [join(maintainerRoot, "scripts", "import-markdown.js"),
      "--vault", vaultPath, "--file", temporaryMarkdown,
      "--authorship", candidate.authorship ?? "unknown", "--json"];
    if (candidate.originalUrl) args.push("--url", candidate.originalUrl);
    if (candidate.author) args.push("--author", candidate.author);
    const result = await runTool(process.execPath, args, { cwd: maintainerRoot, timeoutMs: 60_000 });
    const report: unknown = JSON.parse(result.stdout);
    if (typeof report !== "object" || report === null || !("snapshot" in report) ||
      typeof report.snapshot !== "string" || !("fingerprint" in report) ||
      typeof report.fingerprint !== "string" || !("duplicate" in report) ||
      typeof report.duplicate !== "boolean") throw new Error("INVALID_MAINTAINER_REPORT");
    if (isAbsolute(report.snapshot) || report.snapshot === "." || report.snapshot.startsWith("..")) throw new Error("INVALID_SNAPSHOT_PATH");
    const target = resolve(vaultPath, report.snapshot);
    const rel = relative(vaultPath, target);
    if (!rel || rel.startsWith("..") || rel.includes(`${sep}..${sep}`)) throw new Error("INVALID_SNAPSHOT_PATH");
    const realTarget = await realpath(target);
    if (!realTarget.startsWith(`${vaultPath}${sep}`)) throw new Error("INVALID_SNAPSHOT_PATH");
    const hash = createHash("sha256").update(await readFile(realTarget)).digest("hex");
    if (hash !== report.fingerprint) throw new Error("INVALID_SNAPSHOT_HASH");
    return { snapshot: report.snapshot, fingerprint: report.fingerprint, duplicate: report.duplicate };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
