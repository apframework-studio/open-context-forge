import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { createApp } from "../app.js";
import type { AgentRunner } from "./runner.js";

const maintainerRoot = resolve(process.cwd(), "../../../open-context-forge-vault-maintainer");
const writerRoot = resolve(process.cwd(), "../../../open-context-forge-tech-article-writer");

async function setup(runner: AgentRunner, environment: NodeJS.ProcessEnv = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-agent-"));
  const app = createApp({ dataDir, maintainerRoot, writerRoot,
    agentOptions: { runner, environment, claudePath: "/fake/claude" } });
  await app.inject({ method: "GET", url: "/api/v1/vaults" });
  const sourceRef = { vaultId: "default", snapshot: "raw/sources/source.md" };
  writeFileSync(join(dataDir, "vaults", "default", sourceRef.snapshot), "# 资料来源\n\n可核对的事实。\n");
  const created = await app.inject({ method: "POST", url: "/api/v1/articles", headers: { "x-ocf-client": "1" },
    payload: { title: "验证文章", summary: "摘要", date: "2026-10-23", sourceRef } });
  return { app, dataDir, articleId: created.json().id as string };
}

test("profiles expose local Claude and keep API-key variants unavailable without keys", async () => {
  const context = await setup(async () => ({ text: "ok", sessionId: "native-1" }));
  try {
    const response = await context.app.inject({ method: "GET", url: "/api/v1/agents/profiles" });
    expect(response.statusCode).toBe(200);
    expect(response.json().profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "claude-current", available: true }),
      expect.objectContaining({ id: "claude-deepseek", available: false }),
      expect.objectContaining({ id: "claude-api", available: false }),
    ]));
    expect(response.json().profiles.every((item: Record<string, unknown>) => !Object.hasOwn(item, "key"))).toBe(true);
  } finally { await context.app.close(); rmSync(context.dataDir, { recursive: true, force: true }); }
});

test("article conversation persists messages and resumes the native Claude session", async () => {
  const calls: Parameters<AgentRunner>[0][] = [];
  const context = await setup(async (input) => {
    calls.push(input);
    return { text: `建议 ${calls.length}`, sessionId: "native-1" };
  });
  try {
    const url = `/api/v1/articles/${context.articleId}/agent/messages`;
    for (const content of ["帮我分析证据", "再核对结论"]) {
      const response = await context.app.inject({ method: "POST", url,
        headers: { "x-ocf-client": "1" }, payload: { profileId: "claude-current", content } });
      expect(response.statusCode).toBe(201);
    }
    expect(calls).toHaveLength(2);
    expect(calls[0].nativeSessionId).toBeNull();
    expect(calls[0].prompt).toContain("可核对的事实");
    expect(calls[1].nativeSessionId).toBe("native-1");
    const history = await context.app.inject({ method: "GET",
      url: `/api/v1/articles/${context.articleId}/agent?profileId=claude-current` });
    expect(history.json().messages.map((item: { content: string }) => item.content))
      .toEqual(["帮我分析证据", "建议 1", "再核对结论", "建议 2"]);
  } finally { await context.app.close(); rmSync(context.dataDir, { recursive: true, force: true }); }
});

test("a new blank article can discuss a topic before any source is attached", async () => {
  let prompt = "";
  const context = await setup(async (input) => { prompt = input.prompt; return { text: "先列出问题", sessionId: "native-blank" }; });
  try {
    const blank = await context.app.inject({ method: "POST", url: "/api/v1/articles",
      headers: { "x-ocf-client": "1" }, payload: {} });
    const response = await context.app.inject({ method: "POST", url: `/api/v1/articles/${blank.json().id}/agent/messages`,
      headers: { "x-ocf-client": "1" }, payload: { profileId: "claude-current", content: "帮我列一个提纲" } });
    expect(response.statusCode).toBe(201);
    expect(prompt).toContain("暂无关联来源");
    expect(prompt).toContain("帮我列一个提纲");
  } finally { await context.app.close(); rmSync(context.dataDir, { recursive: true, force: true }); }
});

test("rejects unavailable profiles and invalid messages before invoking CLI", async () => {
  let calls = 0;
  const context = await setup(async () => { calls += 1; return { text: "ok", sessionId: "x" }; });
  try {
    const url = `/api/v1/articles/${context.articleId}/agent/messages`;
    const unavailable = await context.app.inject({ method: "POST", url,
      headers: { "x-ocf-client": "1" }, payload: { profileId: "claude-deepseek", content: "hello" } });
    expect(unavailable.statusCode).toBe(409);
    const invalid = await context.app.inject({ method: "POST", url,
      headers: { "x-ocf-client": "1" }, payload: { profileId: "claude-current", content: "   " } });
    expect(invalid.statusCode).toBe(422);
    expect(calls).toBe(0);
  } finally { await context.app.close(); rmSync(context.dataDir, { recursive: true, force: true }); }
});

test("provider key stays on the server and runner failure leaves history unchanged", async () => {
  const secret = "test-secret-do-not-return";
  const context = await setup(async () => { throw new Error("AGENT_AUTH_REQUIRED"); }, { OCF_DEEPSEEK_API_KEY: secret });
  try {
    const profiles = await context.app.inject({ method: "GET", url: "/api/v1/agents/profiles" });
    expect(profiles.json().profiles.find((item: { id: string }) => item.id === "claude-deepseek").available).toBe(true);
    expect(profiles.body).not.toContain(secret);
    const result = await context.app.inject({ method: "POST", url: `/api/v1/articles/${context.articleId}/agent/messages`,
      headers: { "x-ocf-client": "1" }, payload: { profileId: "claude-current", content: "分析证据" } });
    expect(result.statusCode).toBe(502);
    expect(result.json()).toEqual({ error: "AGENT_AUTH_REQUIRED" });
    const history = await context.app.inject({ method: "GET", url: `/api/v1/articles/${context.articleId}/agent?profileId=claude-current` });
    expect(history.json().messages).toEqual([]);
  } finally { await context.app.close(); rmSync(context.dataDir, { recursive: true, force: true }); }
});
