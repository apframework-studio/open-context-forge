import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ToolOptions {
  cwd: string;
  timeoutMs: number;
}

export async function runTool(binary: string, args: string[], options: ToolOptions) {
  const result = await execFileAsync(binary, args, {
    cwd: options.cwd,
    timeout: options.timeoutMs,
    maxBuffer: 1024 * 1024,
    encoding: "utf8",
    windowsHide: true,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}
