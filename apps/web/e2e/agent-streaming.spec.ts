import { createServer, type ServerResponse } from "node:http";
import { expect, test } from "@playwright/test";
import type { AgentHistory, AgentRun } from "../src/api";

test("streamed text, tool approval, reload, article isolation and cancellation remain consistent", async ({ page }) => {
  let run: AgentRun | null = null;
  let articleId = "", question = "", sends = 0;
  let acceptDelayed: (() => void) | undefined;
  const initialItems = (await (await page.request.get("/api/v1/articles")).json()).items as { id: string }[];
  const initialIds = new Set(initialItems.map((item) => item.id));
  const clients = new Set<ServerResponse>();
  const broadcast = () => { for (const client of clients) client.write(`event: snapshot\ndata: ${JSON.stringify(run)}\n\n`); };
  const server = createServer((_, response) => {
    response.writeHead(200, { "content-type": "text/event-stream", "access-control-allow-origin": "*", "cache-control": "no-cache" });
    response.write(`event: snapshot\ndata: ${JSON.stringify(run)}\n\n`);
    clients.add(response); response.once("close", () => clients.delete(response));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const history = (id: string): AgentHistory => ({ profileId: "claude-current", run: id === articleId ? run : null, runs: id === articleId && run ? [run] : [],
    messages: id === articleId && run ? [{ id: "user", role: "user", content: question, createdAt: run.createdAt },
      { id: run.assistantMessageId, role: "assistant", content: run.text, createdAt: run.createdAt }] : [] });
  await page.route("**/api/v1/agents/profiles", (route) => route.fulfill({ json: { profiles: [{ id: "claude-current", label: "Claude · 本机", available: true }] } }));
  await page.route("**/api/v1/articles/*/agent?*", (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-2)!;
    return route.fulfill({ json: history(id) });
  });
  await page.route("**/api/v1/articles/*/agent/runs", async (route) => {
    if (route.request().postDataJSON().content === "延迟提交测试") await new Promise<void>((resolve) => { acceptDelayed = resolve; });
    sends += 1; articleId = new URL(route.request().url()).pathname.split("/").at(-3)!;
    question = route.request().postDataJSON().content;
    const now = new Date().toISOString();
    run = { id: `run-${sends}`, articleId, profileId: "claude-current", assistantMessageId: `assistant-${sends}`, status: "running",
      text: "", activity: "正在连接本机智能体…", tools: [], permissions: [], errorCode: null, seq: 0, createdAt: now, updatedAt: now };
    return route.fulfill({ status: 202, json: run });
  });
  await page.route("**/api/v1/articles/*/agent/runs/*/events", (route) => route.fulfill({ status: 307, headers: { location: `http://127.0.0.1:${port}/events` } }));
  await page.route("**/api/v1/articles/*/agent/runs/*/permission", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ requestId: "permission", optionId: "once" });
    run = { ...run!, seq: run!.seq + 1, status: "running", permissions: [], tools: [{ id: "read", title: "读取当前素材", status: "completed" }] };
    await route.fulfill({ json: run }); broadcast();
  });
  await page.route("**/api/v1/articles/*/agent/runs/*/cancel", async (route) => {
    run = { ...run!, seq: run!.seq + 1, status: "cancelled", activity: "已停止，保留已有输出" };
    await route.fulfill({ json: run }); broadcast();
  });
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "文章工作台", exact: true }).click();
    await page.getByRole("button", { name: "新建文章" }).click();
    const title = `流式文章 ${Date.now()}`;
    await page.getByLabel("文章标题").fill(title);
    await page.getByLabel("向智能体提问").fill("请开始写文章");
    await page.getByRole("button", { name: "发送消息" }).click();
    await expect.poll(() => clients.size).toBeGreaterThan(0);
    run = { ...run!, text: "第一段正在逐步生成。", seq: 1, activity: "正在起草正文", tools: [{ id: "read", title: "读取当前素材", status: "in_progress" }] };
    broadcast();
    const log = page.getByRole("log", { name: "文章讨论记录" });
    await expect(log).toContainText("第一段正在逐步生成");
    await expect(log).toContainText("读取当前素材");
    await expect(page.getByRole("button", { name: "用作正文" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /停止生成/ })).toBeVisible();
    run = { ...run!, seq: 2, status: "waiting_permission", permissions: [{ id: "permission", title: "读取来源文件", options: [{ optionId: "once", name: "允许一次", kind: "allow_once" }] }] };
    broadcast();
    await page.getByRole("button", { name: "允许一次" }).click();
    await expect(page.getByRole("group", { name: "智能体操作确认" })).toHaveCount(0);
    await page.reload();
    await page.getByRole("button", { name: "文章工作台", exact: true }).click();
    await expect(log).toContainText("第一段正在逐步生成");
    await expect(page.getByRole("button", { name: /停止生成/ })).toBeVisible();
    await page.getByRole("button", { name: "返回文章列表" }).click();
    await page.getByRole("button", { name: "新建文章" }).click();
    await expect(log).not.toContainText("第一段正在逐步生成");
    run = { ...run!, seq: 4, status: "completed", text: "# 流式成稿\n\n这是最终正文。", activity: "已完成" };
    broadcast();
    await expect(log).not.toContainText("这是最终正文");
    await page.getByRole("button", { name: "返回文章列表" }).click();
    await page.getByRole("button", { name: title, exact: true }).click();
    await expect(log).toContainText("这是最终正文");
    await expect(page.getByRole("button", { name: "用作正文" })).toBeVisible();
    await page.getByLabel("向智能体提问").fill("再写一个版本");
    await page.getByRole("button", { name: "发送消息" }).click();
    await expect.poll(() => clients.size).toBeGreaterThan(0);
    run = { ...run!, text: "保留的第二版片段", seq: 1 }; broadcast();
    await expect(log).toContainText("保留的第二版片段");
    await page.getByRole("button", { name: /停止生成/ }).click();
    await expect(log).toContainText("以下为未完成的部分输出");
    await expect(page.getByRole("button", { name: "重新发送上一条" })).toBeVisible();
    await page.getByLabel("向智能体提问").fill("延迟提交测试");
    await page.getByRole("button", { name: "发送消息" }).click();
    await expect.poll(() => !!acceptDelayed).toBe(true);
    await page.getByRole("button", { name: "返回文章列表" }).click();
    await page.getByRole("button", { name: "新建文章" }).click();
    await expect(page.getByRole("heading", { name: "把想法聊成文章" })).toBeVisible();
    await page.getByRole("button", { name: "返回文章列表" }).click();
    await page.getByRole("button", { name: title, exact: true }).click();
    await expect(page.getByRole("button", { name: "重新发送上一条" })).toBeVisible();
    acceptDelayed!();
    await expect(page.getByRole("button", { name: /停止生成/ })).toBeVisible();
    await expect(log).toContainText("延迟提交测试");
    await page.getByRole("button", { name: /停止生成/ }).click();
    await expect(page.getByRole("button", { name: "重新发送上一条" })).toBeVisible();
    await page.screenshot({ path: "/private/tmp/ocf-agent-stream-desktop.png" });
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(page.locator(".shell")).toHaveCSS("padding-left", "0px");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    await page.screenshot({ path: "/private/tmp/ocf-agent-stream-mobile.png" });
    await page.getByLabel("向智能体提问").fill("测试跨窗口清空");
    await page.getByRole("button", { name: "发送消息" }).click();
    await expect.poll(() => clients.size).toBeGreaterThan(0);
    for (const client of clients) { client.write('event: removed\ndata: {"error":"ARTICLE_NOT_FOUND"}\n\n'); client.end(); }
    await expect(page.getByRole("alert")).toHaveText("文章已被永久删除，请返回文章列表。");
    await expect(page.getByRole("button", { name: /停止生成/ })).toHaveCount(0);
    await expect.poll(() => clients.size).toBe(0);
  } finally {
    await page.goto("about:blank");
    for (const client of clients) client.end();
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    const items = (await (await page.request.get("/api/v1/articles")).json()).items as { id: string; revision: number }[];
    const created = items.filter((item) => !initialIds.has(item.id));
    if (created.length) await page.request.post("/api/v1/articles/actions", { headers: { "x-ocf-client": "1" },
      data: { action: "trash", items: created.map((item) => ({ id: item.id, expectedRevision: item.revision })) } });
  }
});
