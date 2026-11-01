import type { WritingTurnContext } from "@ocf/contracts";
import { spawn } from "node:child_process";
import { constants, accessSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { homedir } from "node:os";

export interface AgentRunInput {
  prompt: string;
  context?: WritingTurnContext;
  nativeSessionId: string | null;
  profileId: string;
  executablePath: string;
  cwd: string;
  environment: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  terminationGraceMs?: number;
  onEvent?: (event: AgentEvent) => void;
  onProcessId?: (pid: number) => void;
  onPermission?: (request: AgentPermission) => Promise<string>;
}

export interface AgentTool { id: string; title: string; status: string; detail?: string }
export interface AgentPermission { id: string; title: string; options: { optionId: string; name: string; kind: string }[] }
export type AgentEvent = { type: "text"; text: string } | { type: "tool"; tool: AgentTool } |
  { type: "activity"; text: string } | { type: "session"; sessionId: string };

export type AgentRunner = (input: AgentRunInput) => Promise<{ text: string; sessionId: string }>;

export interface AgentProfile {
  id: "claude-current" | "claude-deepseek" | "claude-api" | "codex-current";
  label: string;
  description: string;
  available: boolean;
  reason?: string;
  protocol?: "acp";
  capabilities?: string[];
}

function executable(path: string): boolean {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}

export function findClaude(environment: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [
    environment.OCF_CLAUDE_PATH,
    ...(environment.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, "claude")),
    join(homedir(), ".local", "bin", "claude"),
    join(homedir(), ".claude", "local", "claude"),
  ];
  const found = candidates.find((item): item is string => !!item && executable(item));
  return found ? resolve(found) : null;
}

export function findCodex(environment: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [environment.OCF_CODEX_PATH,
    ...(environment.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, "codex")),
    join(homedir(), ".local", "bin", "codex"),
    "/Applications/Codex.app/Contents/Resources/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"];
  return candidates.find((item): item is string => !!item && executable(item)) ?? null;
}

export function agentProfiles(claudePath: string | null, environment: NodeJS.ProcessEnv): AgentProfile[] {
  return [
    { id: "claude-current", label: "Claude CLI · 当前登录", description: "使用本机 Claude CLI 已有的登录状态", available: !!claudePath,
      ...(!claudePath ? { reason: "未发现 Claude CLI；可设置 OCF_CLAUDE_PATH" } : {}) },
    { id: "claude-deepseek", label: "Claude CLI · DeepSeek", description: "通过 DeepSeek 的 Anthropic 兼容接口运行", available: !!claudePath && !!environment.OCF_DEEPSEEK_API_KEY,
      ...(!environment.OCF_DEEPSEEK_API_KEY ? { reason: "尚未设置 OCF_DEEPSEEK_API_KEY" } : !claudePath ? { reason: "未发现 Claude CLI" } : {}) },
    { id: "claude-api", label: "Claude CLI · API Key", description: "使用单独提供的 Anthropic API Key", available: !!claudePath && !!environment.OCF_ANTHROPIC_API_KEY,
      ...(!environment.OCF_ANTHROPIC_API_KEY ? { reason: "尚未设置 OCF_ANTHROPIC_API_KEY" } : !claudePath ? { reason: "未发现 Claude CLI" } : {}) },
    { id: "codex-current", label: "Codex · 本机登录", description: "通过现成 ACP 适配器连接本机 Codex", available: !!findCodex(environment),
      ...(!findCodex(environment) ? { reason: "未发现 Codex；可设置 OCF_CODEX_PATH" } : {}) },
  ].map((profile) => ({ ...profile, protocol: "acp", capabilities: ["stream", "tools", "permission", "cancel", "resume"] })) as AgentProfile[];
}

export function childEnvironment(input: AgentRunInput): NodeJS.ProcessEnv {
  const env = { ...input.environment };
  for (const name of [
    "OCF_DEEPSEEK_API_KEY", "OCF_ANTHROPIC_API_KEY",
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS",
    "ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL",
    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
  ]) delete env[name];
  if (input.profileId === "claude-deepseek") {
    env.ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";
    env.ANTHROPIC_AUTH_TOKEN = input.environment.OCF_DEEPSEEK_API_KEY;
    env.ANTHROPIC_MODEL = "deepseek-flash[1m]";
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = "deepseek-flash[1m]";
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = "deepseek-flash[1m]";
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = "deepseek-flash";
  } else if (input.profileId === "claude-api") {
    env.ANTHROPIC_API_KEY = input.environment.OCF_ANTHROPIC_API_KEY;
  }
  return env;
}

export const runClaude: AgentRunner = (input) => new Promise((resolve, reject) => {
  // --safe-mode skips user hooks (including iTerm2's cc-status hook) while preserving the current CLI login.
  const args = ["-p", "--output-format", "json", "--safe-mode", "--strict-mcp-config", "--permission-mode", "dontAsk", "--permission-prompts", "none", "--disable-slash-commands", "--tools", ""];
  if (input.nativeSessionId) args.push("--resume", input.nativeSessionId);
  const child = spawn(input.executablePath, args, { cwd: input.cwd, env: childEnvironment(input), stdio: ["pipe", "pipe", "pipe"] });
  if (child.pid) input.onProcessId?.(child.pid);
  let output = "";
  let errorOutput = "";
  let settled = false;
  let stopReason: Error | null = null;
  let forceTimer: ReturnType<typeof setTimeout> | null = null;
  let unconfirmedTimer: ReturnType<typeof setTimeout> | null = null;
  const requestStop = (reason: Error) => {
    if (stopReason || settled) return;
    stopReason = reason;
    child.kill("SIGTERM");
    const grace = input.terminationGraceMs ?? 2_000;
    forceTimer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGKILL");
      unconfirmedTimer = setTimeout(() => finish(new Error("AGENT_EXIT_UNCONFIRMED")), grace);
    }, grace);
  };
  const finish = (error?: Error, result?: { text: string; sessionId: string }) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (forceTimer) clearTimeout(forceTimer);
    if (unconfirmedTimer) clearTimeout(unconfirmedTimer);
    input.signal?.removeEventListener("abort", onAbort);
    if (error) reject(error); else resolve(result!);
  };
  const onAbort = () => requestStop(new Error("AGENT_CANCELLED"));
  input.signal?.addEventListener("abort", onAbort, { once: true });
  if (input.signal?.aborted) onAbort();
  const timer = setTimeout(() => requestStop(new Error("AGENT_TIMEOUT")), input.timeoutMs ?? 120_000);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
    if (output.length > 2_000_000) requestStop(new Error("AGENT_OUTPUT_TOO_LARGE"));
  });
  child.stderr.on("data", (chunk: string) => { errorOutput = (errorOutput + chunk).slice(-4_000); });
  child.on("error", () => { stopReason = new Error("AGENT_START_FAILED"); });
  child.on("close", (code) => {
    if (settled) return;
    if (stopReason) return finish(stopReason);
    if (code !== 0) return finish(new Error(/log(?:ged)?[ -]?in|login/i.test(errorOutput) ? "AGENT_AUTH_REQUIRED" : "AGENT_RUN_FAILED"));
    try {
      const value: unknown = JSON.parse(output);
      if (!value || typeof value !== "object" || !("result" in value) || !("session_id" in value) ||
        typeof value.result !== "string" || !value.result.trim() || typeof value.session_id !== "string") throw new Error("bad response");
      if ("is_error" in value && value.is_error === true) {
        return finish(new Error(value.result.includes("Not logged in") ? "AGENT_AUTH_REQUIRED" : "AGENT_RUN_FAILED"));
      }
      finish(undefined, { text: value.result.trim(), sessionId: value.session_id });
    } catch { finish(new Error("AGENT_RESPONSE_INVALID")); }
  });
  child.stdin.on("error", () => {});
  child.stdin.end(input.prompt);
});
