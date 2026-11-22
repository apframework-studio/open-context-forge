import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { client, methods, ndJsonStream, PROTOCOL_VERSION, type ClientCapabilities, type SessionNotification } from "@agentclientprotocol/sdk";
import { childEnvironment, type AgentRunInput, type AgentRunner } from "./runner.js";

const require = createRequire(import.meta.url);
export interface AcpCommand { executable: string; args: string[] }

function codexMessagePhase(meta: Record<string, unknown> | null | undefined): "commentary" | "final_answer" | undefined {
  const air = (meta?.jetbrains as { air?: { phase?: unknown } } | undefined)?.air;
  return air?.phase === "commentary" || air?.phase === "final_answer" ? air.phase : undefined;
}

function commandFor(input: AgentRunInput): AcpCommand {
  const name = input.profileId === "codex-current" ? "codex-acp" : "claude-agent-acp";
  return { executable: process.execPath, args: [join(dirname(require.resolve(`@agentclientprotocol/${name}/package.json`)), "dist", "index.js")] };
}

export async function stopAcpProcess(child: ChildProcess): Promise<void> {
  const alive = () => {
    if (!child.pid) return false;
    if (process.platform === "win32") return child.exitCode === null && child.signalCode === null;
    try { process.kill(-child.pid, 0); return true; } catch { return false; }
  };
  const kill = (signal: NodeJS.Signals) => {
    try {
      // The adapter is the group leader. Its exit does not imply its native CLI or tools exited.
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
      else if (alive()) child.kill(signal);
    } catch { /* already exited */ }
  };
  kill("SIGTERM");
  for (let i = 0; i < 10 && alive(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  if (alive()) kill("SIGKILL");
}

// The adapter owns the agent loop. This module only implements an ACP client.
export async function runAcp(input: AgentRunInput, command = commandFor(input)): ReturnType<AgentRunner> {
  input.signal?.throwIfAborted();
  const env: NodeJS.ProcessEnv = input.profileId === "codex-current" ? { ...input.environment, CODEX_PATH: input.executablePath } :
    { ...childEnvironment(input), CLAUDE_CODE_EXECUTABLE: input.executablePath };
  // Never inherit a nested host marker from the desktop running this server.
  delete env.CLAUDECODE;
  const child = spawn(command.executable, command.args, { cwd: input.cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
  let text = "", sessionId = "", replaying = false, diagnostics = "";
  let finalAnswer: string | undefined;
  let failure = "AGENT_RUN_FAILED";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { diagnostics = (diagnostics + chunk).slice(-4000); });
  const connection = client({ name: "wenmai" })
    .onNotification(methods.client.session.update, ({ params }: { params: SessionNotification }) => {
      if (replaying || input.signal?.aborted || (sessionId && params.sessionId !== sessionId)) return;
      const update = params.update;
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        text += update.content.text;
        if (text.length > 2_000_000) { failure = "AGENT_OUTPUT_TOO_LARGE"; connection.close(new Error(failure)); return; }
        if (input.profileId === "codex-current") {
          const phase = codexMessagePhase(update._meta);
          if (phase) {
            finalAnswer ??= "";
            if (phase === "final_answer") finalAnswer += update.content.text;
          }
        }
        input.onEvent?.({ type: "text", text: update.content.text });
      } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
        const detail = update.content?.flatMap((part) => part.type === "content" && part.content.type === "text" ? [part.content.text] : []).join("\n").slice(0, 8000);
        input.onEvent?.({ type: "tool", tool: { id: update.toolCallId, title: update.title ?? "", status: update.status ?? "", ...(detail ? { detail } : {}) } });
      } else if (update.sessionUpdate === "plan") {
        input.onEvent?.({ type: "activity", text: update.entries.map((entry) => `${entry.status === "completed" ? "✓" : "·"} ${entry.content}`).join("\n").slice(0, 4000) });
      }
    })
    .onRequest(methods.client.session.requestPermission, async ({ params }) => {
      if (input.signal?.aborted || !input.onPermission) return { outcome: { outcome: "cancelled" as const } };
      const optionId = await input.onPermission({ id: randomUUID(), title: params.toolCall.title ?? "工具操作", options: params.options });
      return optionId ? { outcome: { outcome: "selected" as const, optionId } } : { outcome: { outcome: "cancelled" as const } };
    })
    .connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as unknown as Parameters<typeof ndJsonStream>[1], { maxMessageBytes: 4_000_000 }));
  child.on("error", () => { failure = "AGENT_START_FAILED"; connection.close(new Error(failure)); });
  child.on("close", () => connection.close());
  const abort = () => {
    if (sessionId) void connection.agent.notify(methods.agent.session.cancel, { sessionId }).catch(() => {});
    connection.close(new Error("AGENT_CANCELLED"));
  };
  input.signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => { failure = "AGENT_TIMEOUT"; connection.close(new Error(failure)); }, 10 * 60_000);
  try {
    if (input.signal?.aborted) throw new Error("AGENT_CANCELLED");
    input.onEvent?.({ type: "activity", text: "正在连接本机智能体…" });
    // The Codex adapter sends message phases through this ACP extension.
    const clientCapabilities: ClientCapabilities = input.profileId === "codex-current" ? { _meta: { jetbrains: { air: { version: 1 } } } } : {};
    const init = await connection.agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION,
      clientCapabilities, clientInfo: { name: "wenmai", version: "1" } });
    const meta = input.profileId === "codex-current" ? undefined : { claudeCode: { options: {
      settings: { disableAllHooks: true }, allowDangerouslySkipPermissions: false,
    } } };
    if (input.nativeSessionId) {
      if (!init.agentCapabilities?.loadSession) throw new Error("AGENT_RESUME_UNAVAILABLE");
      sessionId = input.nativeSessionId;
      replaying = true;
      try { await connection.agent.request(methods.agent.session.load, { sessionId, cwd: input.cwd, mcpServers: [], _meta: meta }); }
      finally { replaying = false; }
    } else {
      const session = await connection.agent.request(methods.agent.session.new, { cwd: input.cwd, mcpServers: [], _meta: meta });
      sessionId = session.sessionId;
    }
    input.onEvent?.({ type: "session", sessionId });
    input.onEvent?.({ type: "activity", text: "智能体正在处理当前文章" });
    const result = await connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: input.prompt }] });
    if (input.signal?.aborted || result.stopReason === "cancelled") throw new Error("AGENT_CANCELLED");
    if (!text.trim()) throw new Error("AGENT_RESPONSE_INVALID");
    return { text, sessionId, ...(finalAnswer !== undefined ? { finalAnswer } : {}) };
  } catch (error) {
    if (input.signal?.aborted) throw new Error("AGENT_CANCELLED");
    const message = error instanceof Error ? error.message : "";
    if (/^AGENT_[A-Z_]+$/.test(message)) throw error;
    const code = /auth.*(?:required|fail|invalid)|not logged in|login required|invalid.*credential/i.test(`${message}\n${diagnostics}`) ? "AGENT_AUTH_REQUIRED" : failure;
    let reason = `${message}\n${diagnostics}`;
    for (const [name, value] of Object.entries(env)) if (/token|secret|key|password/i.test(name) && value && value.length >= 4) reason = reason.replaceAll(value, "[redacted]");
    reason = reason.replace(/Bearer\s+\S+|\b(?:sk-|ghp_)[A-Za-z0-9_-]+/gi, "[redacted]").slice(-1600);
    console.error("[agent-acp]", JSON.stringify({ provider: input.profileId, code, reason }));
    throw new Error(code);
  } finally {
    clearTimeout(timeout); input.signal?.removeEventListener("abort", abort); connection.close();
    await stopAcpProcess(child);
  }
}
