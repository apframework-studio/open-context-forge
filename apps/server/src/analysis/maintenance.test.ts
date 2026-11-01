import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { openDatabase } from "../state/db.js";
import { VaultRegistry } from "../vaults/registry.js";
import { importSnapshot } from "../vaults/maintainer.js";
import type { AgentRunner } from "../agents/runner.js";
import { MaintenanceCompiler } from "./maintenance.js";

const maintainerRoot = resolve(process.cwd(), "../../../open-context-forge-vault-maintainer");

test("maintainer skill produces an evidence card and a defer plan without wiki changes", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-maintainer-agent-"));
  const db = openDatabase(dataDir);
  try {
    const vaults = new VaultRegistry(db, dataDir, maintainerRoot);
    await vaults.ensureDefault();
    const vault = vaults.get("default")!;
    const filed = await importSnapshot({ title: "可信分析", capturedAt: "2026-10-27T00:00:00Z",
      contentHash: "source-content", markdown: "# 可信分析\n\n作者陈述：固定规则生成查询。" } as Parameters<typeof importSnapshot>[0],
      vault.path, maintainerRoot);
    const stages: string[] = [];
    const runner: AgentRunner = async (input) => {
      if (input.prompt.includes("<analysis_stage>")) {
        expect(input.prompt).toContain("Open Context Forge Vault Maintainer");
        const line = input.prompt.split("\n").find((part) => part.includes("作者陈述：固定规则生成查询。") && /^L\d+ /.test(part));
        const startLine = Number(line?.match(/^L(\d+)/)?.[1]);
        return { sessionId: "maintainer-analysis", text: JSON.stringify({ fingerprint: filed.fingerprint,
          summary: "固定规则承接查询生成", mainPoints: [{ claim: "作者描述确定性查询", kind: "article_statement",
            evidence: [{ startLine, endLine: startLine, excerpt: "作者陈述：固定规则生成查询。" }] }],
          limitations: ["仅来自单篇文章"], recommendation: "defer", reason: "需要与现有笔记比较" }) };
      }
      expect(input.prompt).toContain("<planning_stage>");
      return { sessionId: "maintainer-plan", text: JSON.stringify({ fingerprint: filed.fingerprint,
        decision: "defer", reason: "缺少复用判断", changes: [] }) };
    };
    const compiler = new MaintenanceCompiler(vaults, dataDir, { runner, claudePath: "/fake/claude", environment: {} });
    const result = await compiler.propose({ vaultId: "default", snapshot: filed.snapshot, fingerprint: filed.fingerprint },
      (stage) => stages.push(stage));
    expect(result.recommendation).toBe("defer");
    expect(result.changes).toEqual([]);
    expect(result.analysisMarkdown).toContain(`${filed.snapshot}#L`);
    expect(result.planMarkdown).toContain("defer");
    expect(stages).toEqual(["analyzing", "planning"]);
  } finally { db.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("maintainer refuses a stale source fingerprint before invoking the CLI", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-maintainer-stale-"));
  const db = openDatabase(dataDir);
  try {
    const vaults = new VaultRegistry(db, dataDir, maintainerRoot);
    await vaults.ensureDefault();
    const compiler = new MaintenanceCompiler(vaults, dataDir, { runner: async () => { throw new Error("CLI_SHOULD_NOT_RUN"); },
      claudePath: "/fake/claude", environment: {} });
    await expect(compiler.propose({ vaultId: "default", snapshot: "raw/sources/missing.md",
      fingerprint: createHash("sha256").update("other").digest("hex") }, () => undefined))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  } finally { db.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("a metadata-only plan drafts each wiki note in a separate serial CLI step", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-maintainer-draft-"));
  const db = openDatabase(dataDir);
  try {
    const vaults = new VaultRegistry(db, dataDir, maintainerRoot);
    await vaults.ensureDefault();
    const vault = vaults.get("default")!;
    const filed = await importSnapshot({ title: "规则分析", capturedAt: "2026-10-27T00:00:00Z",
      contentHash: "source-content", markdown: "# 规则分析\n\n固定规则生成查询。" } as Parameters<typeof importSnapshot>[0],
      vault.path, maintainerRoot);
    const stages: string[] = [];
    const calls: string[] = [];
    const runner: AgentRunner = async (input) => {
      if (input.prompt.includes("<analysis_stage>")) {
        calls.push("analysis");
        const line = input.prompt.split("\n").find((part) => /^L\d+ 固定规则生成查询。/.test(part))!;
        const number = Number(line.match(/^L(\d+)/)?.[1]);
        return { sessionId: "analysis", text: JSON.stringify({ fingerprint: filed.fingerprint,
          summary: "固定规则生成查询", mainPoints: [{ claim: "作者描述确定性查询", kind: "article_statement",
            evidence: [{ startLine: number, endLine: number, excerpt: "固定规则生成查询。" }] }],
          limitations: [], recommendation: "compile_now", reason: "可复用" }) };
      }
      if (input.prompt.includes("<planning_stage>")) {
        calls.push("planning");
        return { sessionId: "planning", text: JSON.stringify({ fingerprint: filed.fingerprint,
          decision: "compile_now", reason: "新建概念", changes: [{ action: "create", path: "wiki/concepts/query-rules.md",
            baseHash: null, evidenceIds: ["E1.1"] }] }) };
      }
      calls.push("drafting");
      const sourceLine = input.prompt.match(/E1\.1[^\n]*#L(\d+)-L(\d+)/)!;
      return { sessionId: "drafting", text: `---\ntype: concept\nsource_snapshot: '${filed.snapshot}'\nsource_fingerprint: '${filed.fingerprint}'\n---\n# 查询规则\n\n${filed.snapshot}#L${sourceLine[1]}-L${sourceLine[2]}\n` };
    };
    const compiler = new MaintenanceCompiler(vaults, dataDir, { runner, claudePath: "/fake/claude", environment: {} });
    const result = await compiler.propose({ vaultId: "default", snapshot: filed.snapshot, fingerprint: filed.fingerprint },
      (stage) => stages.push(stage));
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].content).toContain(`${filed.snapshot}#L`);
    expect(calls).toEqual(["analysis", "planning", "drafting"]);
    expect(stages).toEqual(["analyzing", "planning", "drafting"]);
  } finally { db.close(); rmSync(dataDir, { recursive: true, force: true }); }
});
