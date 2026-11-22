import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createApp } from "../app.js";
import { openDatabase } from "../state/db.js";
import type { AgentRunInput, AgentRunner } from "./runner.js";

const headers = { "x-ocf-client": "1" };
async function setup(runner: AgentRunner) {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-live-agent-"));
  const app = createApp({ dataDir, agentOptions: { runner, claudePath: "/fake/claude", environment: {} } });
  const article = (await app.inject({ method: "POST", url: "/api/v1/articles", headers, payload: {} })).json();
  const base = `/api/v1/articles/${article.id}/agent`;
  return { app, dataDir, base };
}
async function eventually(read: () => Promise<any>, accept: (value: any) => boolean) {
  for (let i = 0; i < 100; i++) { const value = await read(); if (accept(value)) return value; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error("Expected agent state was not reached");
}

test("accepted runs expose partial text before completion and persist it across service restart", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const c = await setup(async (input) => {
    input.onEvent?.({ type: "text", text: "正在写第一段" });
    await gate;
    return { text: "正在写第一段，文章完成。", finalAnswer: "文章完成。", sessionId: "acp-session" };
  });
  try {
    const started = await c.app.inject({ method: "POST", url: `${c.base}/runs`, headers,
      payload: { profileId: "claude-current", content: "起草文章" } });
    expect(started.statusCode).toBe(202);
    const read = async () => (await c.app.inject({ url: `${c.base}?profileId=claude-current` })).json();
    const partial = await eventually(read, (h) => h.run?.text === "正在写第一段");
    expect(partial.run.status).toBe("running");
    expect(partial.messages[0].content).toBe("起草文章");
    const duplicate = await c.app.inject({ method: "POST", url: `${c.base}/runs`, headers,
      payload: { profileId: "claude-current", content: "重复发送" } });
    expect(duplicate.statusCode).toBe(409);
    release();
    const done = await eventually(read, (h) => h.run?.status === "completed");
    expect(done.messages.at(-1).content).toBe("正在写第一段，文章完成。");
    await c.app.close();
    const reopened = createApp({ dataDir: c.dataDir, agentOptions: { claudePath: "/fake/claude", environment: {} } });
    try {
      expect((await reopened.inject({ url: `${c.base}?profileId=claude-current` })).json().run)
        .toMatchObject({ text: "正在写第一段，文章完成。", finalAnswer: "文章完成。" });
    }
    finally { await reopened.close(); }
  } finally { release(); await c.app.close(); rmSync(c.dataDir, { recursive: true, force: true }); }
});

test("cancel interrupts the runner and keeps partial output, while another article cannot control it", async () => {
  let aborted = false;
  const c = await setup(async (input) => {
    input.onEvent?.({ type: "text", text: "保留的部分" });
    await new Promise<void>((_, reject) => input.signal!.addEventListener("abort", () => { aborted = true; reject(new Error("AGENT_CANCELLED")); }, { once: true }));
    return { text: "", sessionId: "never" };
  });
  try {
    const run = (await c.app.inject({ method: "POST", url: `${c.base}/runs`, headers,
      payload: { profileId: "claude-current", content: "写文章" } })).json();
    const read = async () => (await c.app.inject({ url: `${c.base}?profileId=claude-current` })).json();
    await eventually(read, (h) => h.run?.text === "保留的部分");
    const other = (await c.app.inject({ method: "POST", url: "/api/v1/articles", headers, payload: {} })).json();
    expect((await c.app.inject({ method: "POST", url: `/api/v1/articles/${other.id}/agent/runs/${run.id}/cancel`, headers })).statusCode).toBe(404);
    expect((await c.app.inject({ method: "POST", url: `${c.base}/runs/${run.id}/cancel`, headers })).statusCode).toBe(200);
    const stopped = await eventually(read, (h) => h.run?.status === "cancelled");
    expect(aborted).toBe(true);
    expect(stopped.run.text).toBe("保留的部分");
  } finally { await c.app.close(); rmSync(c.dataDir, { recursive: true, force: true }); }
});

test("permission options must belong to this pending request and are only answered once", async () => {
  let choice = "";
  const c = await setup(async (input: AgentRunInput) => {
    choice = await input.onPermission!({ id: "permission-1", title: "读取素材", options: [{ optionId: "allow", name: "允许一次", kind: "allow_once" }] });
    return { text: "读取完成", sessionId: "permission-session" };
  });
  try {
    const run = (await c.app.inject({ method: "POST", url: `${c.base}/runs`, headers,
      payload: { profileId: "claude-current", content: "读取素材" } })).json();
    const read = async () => (await c.app.inject({ url: `${c.base}?profileId=claude-current` })).json();
    await eventually(read, (h) => h.run?.status === "waiting_permission");
    const url = `${c.base}/runs/${run.id}/permission`;
    expect((await c.app.inject({ method: "POST", url, headers, payload: { requestId: "permission-1", optionId: "bypass" } })).statusCode).toBe(422);
    expect((await c.app.inject({ method: "POST", url, headers, payload: { requestId: "permission-1", optionId: "allow" } })).statusCode).toBe(200);
    expect((await c.app.inject({ method: "POST", url, headers, payload: { requestId: "permission-1", optionId: "allow" } })).statusCode).toBe(409);
    await eventually(read, (h) => h.run?.status === "completed");
    expect(choice).toBe("allow");
  } finally { await c.app.close(); rmSync(c.dataDir, { recursive: true, force: true }); }
});

test("an unfinished persisted run becomes interrupted on restart without invoking the agent again", async () => {
  const c = await setup(async () => ({ text: "已保存的半段内容", sessionId: "saved-session" }));
  try {
    await c.app.inject({ method: "POST", url: `${c.base}/runs`, headers, payload: { profileId: "claude-current", content: "起草" } });
    const read = async () => (await c.app.inject({ url: `${c.base}?profileId=claude-current` })).json();
    const finished = await eventually(read, (h) => h.run?.status === "completed");
    await c.app.close();
    // Reproduce the durable row left by a process crash, without starting another worker.
    const db = openDatabase(c.dataDir);
    const abandoned = { ...finished.run, status: "running", activity: "正在写作" };
    db.prepare("UPDATE agent_runs SET status = 'running', state_json = ? WHERE id = ?").run(JSON.stringify(abandoned), abandoned.id);
    db.close();
    let calls = 0;
    const restarted = createApp({ dataDir: c.dataDir, agentOptions: { claudePath: "/fake/claude", environment: {}, runner: async () => { calls++; return { text: "不应执行", sessionId: "wrong" }; } } });
    try {
      const h = (await restarted.inject({ url: `${c.base}?profileId=claude-current` })).json();
      expect(h.run).toMatchObject({ status: "interrupted", text: "已保存的半段内容", errorCode: "AGENT_SERVICE_RESTARTED", permissions: [] });
      expect(h.messages.at(-1).content).toBe("已保存的半段内容");
      expect(calls).toBe(0);
    } finally { await restarted.close(); }
  } finally { await c.app.close(); rmSync(c.dataDir, { recursive: true, force: true }); }
});

test("multiple simultaneous permission requests retain independent choices", async () => {
  let choices: string[] = [];
  const c = await setup(async (input) => {
    choices = await Promise.all(["read", "write"].map((id) => input.onPermission!({ id, title: id, options: [{ optionId: `${id}-once`, name: "允许一次", kind: "allow_once" }] })));
    return { text: "操作已处理", sessionId: "parallel-permissions" };
  });
  try {
    const run = (await c.app.inject({ method: "POST", url: `${c.base}/runs`, headers, payload: { profileId: "claude-current", content: "处理素材" } })).json();
    const read = async () => (await c.app.inject({ url: `${c.base}?profileId=claude-current` })).json();
    await eventually(read, (h) => h.run?.permissions.length === 2);
    const url = `${c.base}/runs/${run.id}/permission`;
    await c.app.inject({ method: "POST", url, headers, payload: { requestId: "write", optionId: "write-once" } });
    const remaining = await read();
    expect(remaining.run.status).toBe("waiting_permission");
    expect(remaining.run.permissions.map((p: { id: string }) => p.id)).toEqual(["read"]);
    await c.app.inject({ method: "POST", url, headers, payload: { requestId: "read", optionId: "read-once" } });
    await eventually(read, (h) => h.run?.status === "completed");
    expect(choices).toEqual(["read-once", "write-once"]);
  } finally { await c.app.close(); rmSync(c.dataDir, { recursive: true, force: true }); }
});

test("SSE emits an active snapshot before the final persisted answer and closes on completion", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const c = await setup(async (input) => { input.onEvent?.({ type: "text", text: "部分文字" }); await gate; return { text: "完整文字", sessionId: "sse-session" }; });
  try {
    const run = (await c.app.inject({ method: "POST", url: `${c.base}/runs`, headers, payload: { profileId: "claude-current", content: "写文章" } })).json();
    await eventually(async () => (await c.app.inject({ url: `${c.base}?profileId=claude-current` })).json(), (h) => h.run?.text === "部分文字");
    const stream = c.app.inject({ url: `${c.base}/runs/${run.id}/events` }).then((response) => response);
    // Allow the 100ms snapshot interval to publish while the external runner is held.
    await new Promise((resolve) => setTimeout(resolve, 150));
    release();
    const response = await stream;
    expect(response.headers["content-type"]).toContain("text/event-stream");
    const snapshots = response.body.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
    expect(snapshots[0]).toMatchObject({ status: "running", text: "部分文字" });
    expect(snapshots.at(-1)).toMatchObject({ status: "completed", text: "完整文字" });
  } finally { release(); await c.app.close(); rmSync(c.dataDir, { recursive: true, force: true }); }
});

test("an open SSE stream ends safely when its completed article is purged before the next snapshot", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const c = await setup(async () => { await gate; return { text: "已完成", sessionId: "deleted-stream" }; });
  let response: Awaited<ReturnType<typeof c.app.inject>> | undefined;
  try {
    const run = (await c.app.inject({ method: "POST", url: `${c.base}/runs`, headers,
      payload: { profileId: "claude-current", content: "开始写作" } })).json();
    response = await c.app.inject({ url: `${c.base}/runs/${run.id}/events`, payloadAsStream: true });
    const stream = response.stream();
    let ended = false;
    stream.on("end", () => { ended = true; }); stream.resume();
    release();
    await eventually(async () => (await c.app.inject({ url: `${c.base}?profileId=claude-current` })).json(), (history) => history.run?.status === "completed");
    await c.app.inject({ method: "POST", url: "/api/v1/articles/actions", headers,
      payload: { action: "trash", items: [{ id: run.articleId, expectedRevision: 0 }] } });
    const item = (await c.app.inject({ url: "/api/v1/articles?includeTrashed=true" })).json().items[0];
    const cleared = await c.app.inject({ method: "POST", url: "/api/v1/articles/trash/empty", headers,
      payload: { confirmed: true, items: [{ id: item.id, expectedRevision: item.revision, expectedTrashedAt: item.trashedAt }] } });
    expect(cleared.statusCode).toBe(200);
    expect(() => vi.advanceTimersByTime(100)).not.toThrow();
    await expect.poll(() => ended).toBe(true);
    expect((await c.app.inject({ url: "/api/v1/health" })).statusCode).toBe(200);
  } finally { release(); response?.raw.res.destroy(); vi.useRealTimers(); await c.app.close(); rmSync(c.dataDir, { recursive: true, force: true }); }
});

test("failed output and native session survive and only an explicit new message retries", async () => {
  const inputs: AgentRunInput[] = [];
  const c = await setup(async (input) => {
    inputs.push(input);
    if (inputs.length === 1) {
      input.onEvent?.({ type: "session", sessionId: "retained-native" });
      input.onEvent?.({ type: "text", text: "失败前已生成" });
      throw new Error("AGENT_RUN_FAILED");
    }
    return { text: "重新生成的完整结果", sessionId: "retained-native" };
  });
  try {
    const send = () => c.app.inject({ method: "POST", url: `${c.base}/runs`, headers, payload: { profileId: "claude-current", content: "请起草" } });
    const read = async () => (await c.app.inject({ url: `${c.base}?profileId=claude-current` })).json();
    await send();
    const failed = await eventually(read, (h) => h.run?.status === "failed");
    expect(failed.run).toMatchObject({ text: "失败前已生成", errorCode: "AGENT_RUN_FAILED" });
    expect(failed.messages.at(-1).content).toBe("失败前已生成");
    expect(inputs).toHaveLength(1);
    await send();
    const done = await eventually(read, (h) => h.run?.status === "completed");
    expect(inputs[1].nativeSessionId).toBe("retained-native");
    expect(done.runs.map((r: { status: string }) => r.status)).toEqual(["completed", "failed"]);
    expect(done.messages.map((m: { content: string }) => m.content)).toEqual(["请起草", "失败前已生成", "请起草", "重新生成的完整结果"]);
  } finally { await c.app.close(); rmSync(c.dataDir, { recursive: true, force: true }); }
});
