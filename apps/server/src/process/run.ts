import { spawn } from "node:child_process";

export interface ToolOptions {
  cwd: string;
  timeoutMs: number;
  terminationGraceMs?: number;
  signal?: AbortSignal;
}

export async function runTool(binary: string, args: string[], options: ToolOptions): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let reason: string | null = null;
    let settled = false;
    let forceTimer: ReturnType<typeof setTimeout> | null = null;
    let unconfirmedTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (forceTimer) clearTimeout(forceTimer);
      if (unconfirmedTimer) clearTimeout(unconfirmedTimer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error); else resolve({ stdout, stderr });
    };
    const terminate = (code: string) => {
      if (reason || settled) return;
      reason = code;
      child.kill("SIGTERM");
      const grace = options.terminationGraceMs ?? 2_000;
      forceTimer = setTimeout(() => {
        if (settled) return;
        child.kill("SIGKILL");
        unconfirmedTimer = setTimeout(() => finish(new Error("PROCESS_EXIT_UNCONFIRMED")), grace);
      }, grace);
    };
    const onAbort = () => terminate("PROCESS_CANCELLED");
    const deadline = setTimeout(() => terminate("PROCESS_TIMEOUT"), options.timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 1_048_576) terminate("PROCESS_OUTPUT_TOO_LARGE");
    });
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4096); });
    child.on("error", () => { reason = "PROCESS_START_FAILED"; });
    child.on("close", (exitCode) => {
      if (reason) return finish(new Error(reason));
      if (exitCode !== 0) return finish(new Error(stderr || "PROCESS_RUN_FAILED"));
      finish();
    });
  });
}
