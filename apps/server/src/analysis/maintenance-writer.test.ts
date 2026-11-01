import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { openDatabase } from "../state/db.js";
import { importSnapshot } from "../vaults/maintainer.js";
import { VaultRegistry } from "../vaults/registry.js";
import { applyMaintenanceChanges } from "./maintenance-writer.js";
import { reconcileMaintenanceWrite, reconcileRolledBackWrite } from "./recovery.js";

const maintainerRoot = resolve(process.cwd(), "../../../open-context-forge-vault-maintainer");
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

test("writer saves a valid cited note and process artifacts in the selected vault", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocf-maintenance-write-"));
  const db = openDatabase(dir);
  try {
    const vaults = new VaultRegistry(db, dir, maintainerRoot);
    await vaults.ensureDefault();
    const vault = vaults.get("default")!;
    const source = await importSnapshot({ title: "测试", capturedAt: "2026-10-27T00:00:00Z", contentHash: "x",
      markdown: "# 测试\n\n固定规则生成查询。" } as Parameters<typeof importSnapshot>[0], vault.path, maintainerRoot);
    const path = "wiki/concepts/query-rules.md";
    const sourceLines = readFileSync(join(vault.path, source.snapshot), "utf8").split("\n");
    const evidenceLine = sourceLines.findIndex((line) => line.includes("固定规则生成查询。")) + 1;
    const content = `---\ntype: concept\nsource_snapshot: '${source.snapshot}'\nsource_fingerprint: '${source.fingerprint}'\n---\n# 查询规则\n\n固定规则生成查询。 ${source.snapshot}#L${evidenceLine}-L${evidenceLine}\n`;
    const result = await applyMaintenanceChanges(vault, source.fingerprint, source.snapshot,
      [{ action: "create", path, baseHash: null, content, evidenceIds: ["E1.1"] }], maintainerRoot,
      { analysisMarkdown: "# Card", planMarkdown: "# Plan" });
    expect(result.files).toEqual([path, "wiki/index.md", "wiki/log.md"]);
    expect(readFileSync(join(vault.path, path), "utf8")).toBe(content);
    expect(readFileSync(join(vault.path, ".ocf", "compilations", source.fingerprint, "analysis.md"), "utf8")).toBe("# Card");
    const journal = JSON.parse(readFileSync(join(vault.path, ".ocf", "compilations", source.fingerprint,
      "journal.json"), "utf8"));
    expect(journal).toMatchObject({ status: "complete", fingerprint: source.fingerprint,
      snapshot: source.snapshot, paths: expect.arrayContaining([
        expect.objectContaining({ path, afterHash: sha(content) })]) });
    expect(await reconcileMaintenanceWrite(vault, source.fingerprint, source.snapshot))
      .toMatchObject({ files: result.files });
    writeFileSync(join(vault.path, path), "# changed\n");
    expect(await reconcileMaintenanceWrite(vault, source.fingerprint, source.snapshot)).toBeNull();
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("writer rejects escaping paths and stale updates before changing any note", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocf-maintenance-reject-"));
  const db = openDatabase(dir);
  try {
    const vaults = new VaultRegistry(db, dir, maintainerRoot);
    await vaults.ensureDefault();
    const vault = vaults.get("default")!;
    const source = await importSnapshot({ title: "测试", capturedAt: "2026-10-27T00:00:00Z", contentHash: "x",
      markdown: "# 测试\n\n证据。" } as Parameters<typeof importSnapshot>[0], vault.path, maintainerRoot);
    const oldPath = join(vault.path, "wiki", "existing.md");
    writeFileSync(oldPath, "# User note\n");
    for (const path of ["../escape.md", "/tmp/escape.md", "raw/sources/replace.md", ".ocf/vault.json"]) {
      await expect(applyMaintenanceChanges(vault, source.fingerprint, source.snapshot,
        [{ action: "create", path, baseHash: null, content: "# bad", evidenceIds: ["E1.1"] }], maintainerRoot,
        { analysisMarkdown: "# Card", planMarkdown: "# Plan" })).rejects.toBeTruthy();
    }
    await expect(applyMaintenanceChanges(vault, source.fingerprint, source.snapshot,
      [{ action: "update", path: "wiki/existing.md", baseHash: sha("old"), content: "# changed", evidenceIds: ["E1.1"] }],
      maintainerRoot, { analysisMarkdown: "# Card", planMarkdown: "# Plan" })).rejects.toMatchObject({ code: "BASE_CHANGED" });
    expect(readFileSync(oldPath, "utf8")).toBe("# User note\n");
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("an ask_user plan can be safely revised after clarification while preserving its first version", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocf-maintenance-revise-"));
  const db = openDatabase(dir);
  try {
    const vaults = new VaultRegistry(db, dir, maintainerRoot);
    await vaults.ensureDefault();
    const vault = vaults.get("default")!;
    const source = await importSnapshot({ title: "待确认", capturedAt: "2026-10-27T00:00:00Z", contentHash: "x",
      markdown: "# 待确认\n\n证据。" } as Parameters<typeof importSnapshot>[0], vault.path, maintainerRoot);
    const first = { analysisMarkdown: `# Card\n${source.snapshot}\n${source.fingerprint}`, planMarkdown: "# Plan\n- Decision: ask_user\n" };
    const second = { analysisMarkdown: `# Revised card\n${source.snapshot}\n${source.fingerprint}`,
      planMarkdown: "# Plan\n- Decision: defer\n" };
    await applyMaintenanceChanges(vault, source.fingerprint, source.snapshot, [], maintainerRoot, first);
    await applyMaintenanceChanges(vault, source.fingerprint, source.snapshot, [], maintainerRoot, second);
    const processDir = join(vault.path, ".ocf", "compilations", source.fingerprint);
    expect(readFileSync(join(processDir, "plan.md"), "utf8")).toBe(second.planMarkdown);
    const revisions = readdirSync(join(processDir, "history"));
    expect(revisions).toHaveLength(1);
    expect(readFileSync(join(processDir, "history", revisions[0], "plan.md"), "utf8")).toBe(first.planMarkdown);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("writer rejects a proposal whose source attribution changed during Claude analysis", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocf-maintenance-attribution-"));
  const db = openDatabase(dir);
  try {
    const vaults = new VaultRegistry(db, dir, maintainerRoot);
    await vaults.ensureDefault();
    const vault = vaults.get("default")!;
    const source = await importSnapshot({ title: "Attribution", capturedAt: "2026-10-27T00:00:00Z",
      contentHash: "x", markdown: "# Attribution\n\nEvidence." } as Parameters<typeof importSnapshot>[0],
    vault.path, maintainerRoot);
    const manifestPath = join(vault.path, ".ocf", "ingest-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.sources[source.fingerprint].authorship = "third_party";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    await expect(applyMaintenanceChanges(vault, source.fingerprint, source.snapshot, [], maintainerRoot,
      { analysisMarkdown: "# Card", planMarkdown: "# Plan", authorship: "unknown", author: null }))
      .rejects.toMatchObject({ code: "SOURCE_METADATA_CHANGED" });
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a verified rolled back write can be revised and retried, but a changed target cannot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocf-maintenance-rollback-"));
  const db = openDatabase(dir);
  try {
    const vaults = new VaultRegistry(db, dir, maintainerRoot);
    await vaults.ensureDefault();
    const vault = vaults.get("default")!;
    const source = await importSnapshot({ title: "Rollback", capturedAt: "2026-10-27T00:00:00Z",
      contentHash: "x", markdown: "# Rollback\n\nEvidence." } as Parameters<typeof importSnapshot>[0],
    vault.path, maintainerRoot);
    const path = "wiki/concepts/rollback.md";
    const sourceLines = readFileSync(join(vault.path, source.snapshot), "utf8").split("\n");
    const line = sourceLines.findIndex((value) => value.includes("Evidence.")) + 1;
    const citation = `${source.snapshot}#L${line}-L${line}`;
    const invalid = `# Broken\n\n${citation}\n`;
    const artifacts = { analysisMarkdown: `# Card\n${source.fingerprint}\n${source.snapshot}`,
      planMarkdown: "# Plan\n- Decision: compile_now\n" };
    await expect(applyMaintenanceChanges(vault, source.fingerprint, source.snapshot,
      [{ action: "create", path, baseHash: null, content: invalid, evidenceIds: ["E1.1"] }],
      maintainerRoot, artifacts)).rejects.toMatchObject({ code: "NOTE_VALIDATION_FAILED" });
    expect(await reconcileRolledBackWrite(vault, source.fingerprint, source.snapshot)).toBe(true);
    const valid = `---\ntype: concept\nsource_snapshot: '${source.snapshot}'\nsource_fingerprint: '${source.fingerprint}'\n---\n# Rollback\n\n${citation}\n`;
    const next = await applyMaintenanceChanges(vault, source.fingerprint, source.snapshot,
      [{ action: "create", path, baseHash: null, content: valid, evidenceIds: ["E1.1"] }],
      maintainerRoot, { ...artifacts, planMarkdown: "# Plan\n- Decision: compile_now\n- Revised: true\n" });
    expect(next.files).toContain(path);
    const processDir = join(vault.path, ".ocf", "compilations", source.fingerprint);
    expect(readdirSync(join(processDir, "history"))).toHaveLength(1);
    expect(await reconcileMaintenanceWrite(vault, source.fingerprint, source.snapshot))
      .toMatchObject({ files: next.files });
    const journal = JSON.parse(readFileSync(join(processDir, "journal.json"), "utf8"));
    journal.status = "rolled_back";
    writeFileSync(join(processDir, "journal.json"), JSON.stringify(journal));
    expect(await reconcileRolledBackWrite(vault, source.fingerprint, source.snapshot)).toBe(false);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
