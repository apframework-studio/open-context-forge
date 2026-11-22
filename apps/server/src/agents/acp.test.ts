import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { runAcp, stopAcpProcess } from "./acp.js";
import { spawn } from "node:child_process";
import type { AgentEvent, AgentRunInput } from "./runner.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const fixture = fileURLToPath(new URL("./fixtures/acp-peer.mjs", import.meta.url));
const input: AgentRunInput = { prompt: "写文章", nativeSessionId: null, profileId: "claude-current", executablePath: "/unused",
  cwd: process.cwd(), environment: {} };
const command = (mode = "normal") => ({ executable: process.execPath, args: [fixture, mode] });

test("ACP client receives fragmented text and tool events and excludes replayed history on resume", async () => {
  const events: AgentEvent[] = [];
  const result = await runAcp({ ...input, nativeSessionId: "native-session", onEvent: (event) => events.push(event) }, command());
  expect(result).toEqual({ sessionId: "native-session", text: "第一段，第二段。" });
  expect(events.filter((event) => event.type === "text")).toEqual([{ type: "text", text: "第一段，" }, { type: "text", text: "第二段。" }]);
  expect(events).toContainEqual({ type: "tool", tool: { id: "read-1", title: "读取资料", status: "in_progress" } });
  expect(events).toContainEqual({ type: "tool", tool: { id: "read-1", title: "", status: "completed" } });
});
test("ACP client forwards permission choices to the native agent", async () => {
  const result = await runAcp({ ...input, onPermission: async (request) => {
    expect(request.title).toBe("读取资料"); return request.options[0].optionId;
  } }, command("permission"));
  expect(result.text).toBe("第一段，第二段。");
});
test("Codex final answer is available separately without losing the conversation text", async () => {
  const result = await runAcp({ ...input, profileId: "codex-current" }, command("phases"));
  expect(result.text).toBe("我会先读取资料。\n# 正文\n\n这是可以采用的文稿。");
  expect(result).toHaveProperty("finalAnswer", "# 正文\n\n这是可以采用的文稿。");
});
test("ACP cancellation stops an in-flight process while retaining already emitted text", async () => {
  const controller = new AbortController();
  let partial = "";
  const promise = runAcp({ ...input, signal: controller.signal, onEvent: (event) => {
    if (event.type === "text") { partial += event.text; controller.abort(); }
  } }, command("cancel"));
  await expect(promise).rejects.toThrow("AGENT_CANCELLED");
  expect(partial).toBe("第一段，");
});
test("a native agent exiting before a response fails without hanging", async () => {
  await expect(runAcp(input, command("exit"))).rejects.toThrow("AGENT_RUN_FAILED");
});
test.skipIf(process.platform === "win32")("process cleanup terminates descendants even after the adapter leader has exited", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocf-acp-orphan-"));
  let pid = 0;
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    const file = join(dir, "child.pid");
    const adapter = spawn(process.execPath, ["-e", `const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); require('node:fs').writeFileSync(process.argv[1],String(c.pid)); process.exit(1);`, file], { detached: true, stdio: "ignore" });
    await new Promise((resolve) => adapter.once("close", resolve));
    pid = Number(readFileSync(file, "utf8"));
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    expect(alive()).toBe(true);
    await stopAcpProcess(adapter);
    for (let i = 0; i < 30 && alive(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(alive()).toBe(false);
  } finally { if (pid && alive()) process.kill(pid, "SIGKILL"); rmSync(dir, { recursive: true, force: true }); }
});
