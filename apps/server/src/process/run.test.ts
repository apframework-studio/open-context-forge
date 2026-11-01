import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, vi } from "vitest";
import { runTool } from "./run.js";

test("raw CLI timeout waits for forced child exit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocf-raw-exit-"));
  const pidFile = join(dir, "pid");
  const fixture = resolve(process.cwd(), "src/agents/fixtures/ignore-term.mjs");
  let pid: number | null = null;
  try {
    const started = Date.now();
    const run = runTool(process.execPath, [fixture, pidFile], { cwd: dir, timeoutMs: 200, terminationGraceMs: 30 });
    void run.catch(() => {});
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 1000, interval: 10 });
    pid = Number(readFileSync(pidFile, "utf8"));
    await expect(run).rejects.toThrow("PROCESS_TIMEOUT");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(() => process.kill(pid!, 0)).toThrow();
  } finally {
    if (pid !== null) { try { process.kill(pid, "SIGKILL"); } catch { /* Child already exited. */ } }
    rmSync(dir, { recursive: true, force: true });
  }
});
