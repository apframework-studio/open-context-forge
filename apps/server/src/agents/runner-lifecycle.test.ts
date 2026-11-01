import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, vi } from "vitest";
import { runClaude } from "./runner.js";

test("Claude timeout waits for a child that ignores SIGTERM to exit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocf-claude-exit-"));
  const pidFile = join(dir, "pid");
  const fixture = resolve(process.cwd(), "src/agents/fixtures/ignore-term.mjs");
  let pid: number | null = null;
  try {
    const run = runClaude({ prompt: "test", nativeSessionId: null, profileId: "claude-current",
      executablePath: fixture, cwd: dir, environment: { ...process.env, OCF_TEST_PID_FILE: pidFile },
      timeoutMs: 200, terminationGraceMs: 30 });
    void run.catch(() => {});
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 1000, interval: 10 });
    pid = Number(readFileSync(pidFile, "utf8"));
    await expect(run).rejects.toThrow("AGENT_TIMEOUT");
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    if (pid !== null) { try { process.kill(pid, "SIGKILL"); } catch { /* Child already exited. */ } }
    rmSync(dir, { recursive: true, force: true });
  }
});
