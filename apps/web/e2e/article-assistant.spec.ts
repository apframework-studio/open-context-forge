import { expect, test, type Page } from "@playwright/test";
import type { AgentProfile, AgentRun } from "../src/api";

const claude: AgentProfile = { id: "claude-current", label: "Claude CLI · 当前登录", description: "使用本机 Claude CLI", available: true };
const codex: AgentProfile = { id: "codex-current", label: "Codex · 本机登录", description: "使用本机 Codex", available: true };
const missingClaude: AgentProfile = { ...claude, available: false, reason: "未发现 Claude CLI" };
const missingCodex: AgentProfile = { ...codex, available: false, reason: "未发现 Codex" };

async function newArticle(page: Page, title?: string) {
  await page.getByRole("button", { name: "新建文章", exact: true }).click();
  if (!title) return;
  await page.getByLabel("文章标题").fill(title);
  await expect(page.locator(".article-save-line")).toContainText(/草稿已保存|已自动保存/);
}

function completedRun(articleId: string, profileId: string, id: string): AgentRun {
  const now = new Date().toISOString();
  return { id, articleId, profileId, assistantMessageId: `assistant-${id}`, status: "completed", text: "已收到。",
    activity: "已完成", tools: [], permissions: [], errorCode: null, seq: 1, createdAt: now, updatedAt: now };
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/articles/*/agent?*", (route) => {
    const profileId = new URL(route.request().url()).searchParams.get("profileId");
    return route.fulfill({ json: { profileId, messages: [], run: null, runs: [] } });
  });
  await page.route("**/api/v1/articles/*/agent/runs", () => {
    throw new Error("Unexpected agent execution");
  });
});

test("first-run detection selects the available local agent and awaits an explicit send", async ({ page }) => {
  let releaseDetection!: () => void;
  const heldDetection = new Promise<void>((resolve) => { releaseDetection = resolve; });
  await page.route("**/api/v1/agents/profiles", async (route) => {
    await heldDetection;
    await route.fulfill({ json: { profiles: [missingClaude, codex] } });
  });
  const requestedProfiles: (string | null)[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith("/agent")) requestedProfiles.push(url.searchParams.get("profileId"));
  });
  await page.goto("/#articles");
  await newArticle(page);
  const selector = page.getByRole("combobox", { name: "选择智能体方案" });
  const input = page.getByLabel("向智能体提问");
  const send = page.getByRole("button", { name: "发送消息" });
  await expect(selector).toContainText("正在检测");
  await expect(input).toBeEditable();
  await input.fill("等检测完成后再发送");
  await expect(send).toBeDisabled();
  expect(requestedProfiles).toEqual([]);
  releaseDetection();
  await expect(selector).toContainText("Codex");
  await expect(send).toBeEnabled();
  expect(requestedProfiles).toEqual(["codex-current"]);
  await expect(page.getByRole("log")).not.toContainText("等检测完成后再发送");
});

test("unavailable profiles leave the composer open for drafting without allowing a send", async ({ page }) => {
  await page.route("**/api/v1/agents/profiles", (route) => route.fulfill({ json: { profiles: [missingClaude, missingCodex] } }));
  await page.goto("/#articles");
  await newArticle(page);
  await expect(page.getByText("未检测到可用智能体")).toBeVisible();
  const input = page.getByLabel("向智能体提问");
  await input.fill("先记下这个想法");
  await expect(page.getByRole("button", { name: "发送消息" })).toBeDisabled();
});

test("article drafts and the selected available profile survive switching and reload", async ({ page }) => {
  await page.route("**/api/v1/agents/profiles", (route) => route.fulfill({ json: { profiles: [claude, codex] } }));
  await page.goto("/#articles");
  await newArticle(page, "保留提问的文章");
  const input = page.getByLabel("向智能体提问");
  const selector = page.getByRole("combobox", { name: "选择智能体方案" });
  await input.fill("第一篇尚未发送的想法");
  await selector.click();
  await page.getByRole("option", { name: /Codex/ }).click();
  await expect(input).toHaveValue("第一篇尚未发送的想法");

  const back = page.getByRole("button", { name: "返回文章列表" });
  await back.click();
  await newArticle(page, "另一篇独立文章");
  await expect(input).toHaveValue("");
  await input.fill("第二篇的独立草稿");
  await page.reload();
  await expect(input).toHaveValue("第二篇的独立草稿");
  await expect(selector).toContainText("Codex");
  await back.click();
  await page.getByRole("button", { name: "保留提问的文章", exact: true }).click();
  await expect(input).toHaveValue("第一篇尚未发送的想法");
});

test("shortcuts preserve existing input until the suggested text is inserted", async ({ page }) => {
  await page.route("**/api/v1/agents/profiles", (route) => route.fulfill({ json: { profiles: [claude] } }));
  await page.goto("/#articles");
  await newArticle(page);
  const input = page.getByLabel("向智能体提问");
  const starter = page.getByRole("button", { name: "一起梳理这篇文章的提纲" });
  await starter.click();
  await expect(input).toHaveValue("一起梳理这篇文章的提纲");
  await input.fill("我自己的问题");

  await page.getByRole("button", { name: "主题阅读", exact: true }).click();
  const suggestion = page.getByRole("group", { name: "建议提示词" });
  await expect(suggestion).toContainText("请围绕共同主题阅读");
  await expect(input).toHaveValue("我自己的问题");
  await suggestion.getByRole("button", { name: "忽略" }).click();
  await expect(suggestion).toBeHidden();

  await starter.click();
  await expect(input).toHaveValue("我自己的问题");
  await expect(suggestion).toContainText("一起梳理这篇文章的提纲");
  await suggestion.getByRole("button", { name: "插入建议" }).click();
  await expect(input).toHaveValue("我自己的问题\n\n一起梳理这篇文章的提纲");
});

test("an accepted send clears its article draft even when the user navigates during the request", async ({ page }) => {
  await page.route("**/api/v1/agents/profiles", (route) => route.fulfill({ json: { profiles: [claude] } }));
  let releaseSend!: () => void;
  const heldSend = new Promise<void>((resolve) => { releaseSend = resolve; });
  let accepted: { run: AgentRun; content: string } | undefined;
  await page.route("**/api/v1/articles/*/agent?*", (route) => {
    const articleId = new URL(route.request().url()).pathname.split("/").at(-2);
    const value = accepted?.run.articleId === articleId ? accepted : undefined;
    return route.fulfill({ json: { profileId: claude.id, run: value?.run ?? null, runs: value ? [value.run] : [], messages: value
      ? [{ id: "user", role: "user", content: value.content, createdAt: value.run.createdAt }] : [] } });
  });
  await page.route("**/api/v1/articles/*/agent/runs", async (route) => {
    const articleId = new URL(route.request().url()).pathname.split("/").at(-3)!;
    const { content, profileId } = route.request().postDataJSON();
    await heldSend;
    accepted = { run: completedRun(articleId, profileId, "accepted"), content };
    await route.fulfill({ status: 202, json: accepted.run });
  });

  await page.goto("/#articles");
  await newArticle(page, "延迟提交的文章");
  const input = page.getByLabel("向智能体提问");
  const send = page.getByRole("button", { name: "发送消息" });
  await input.fill("正在提交的草稿");
  const requested = page.waitForRequest("**/api/v1/articles/*/agent/runs");
  await send.click();
  await requested;
  const back = page.getByRole("button", { name: "返回文章列表" });
  await back.click();
  await newArticle(page, "提交过程中打开的文章");
  await input.fill("保留另一篇的草稿");
  await back.click();
  await page.getByRole("button", { name: "延迟提交的文章", exact: true }).click();
  await expect(input).toHaveValue("正在提交的草稿");
  const response = page.waitForResponse("**/api/v1/articles/*/agent/runs");
  releaseSend();
  await response;
  await expect(page.getByRole("log")).toContainText("正在提交的草稿");
  await expect(input).toHaveValue("");

  await input.fill("再次提交");
  await send.click();
  await expect(page.getByRole("log")).toContainText("再次提交");
  await expect(input).toHaveValue("");

  await back.click();
  await page.getByRole("button", { name: "提交过程中打开的文章", exact: true }).click();
  await expect(input).toHaveValue("保留另一篇的草稿");
});

test("authentication failure offers switching and a manual retry without clearing a new draft", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ocf-agent-profile", "codex-current"));
  await page.route("**/api/v1/agents/profiles", (route) => route.fulfill({ json: { profiles: [claude, codex] } }));
  let sends = 0;
  await page.route("**/api/v1/articles/*/agent/runs", (route) => {
    const articleId = new URL(route.request().url()).pathname.split("/").at(-3)!;
    const { content, profileId } = route.request().postDataJSON();
    expect(profileId).toBe("codex-current");
    expect(content).toBe("需要重新认证的请求");
    const run = completedRun(articleId, profileId, `run-${++sends}`);
    return route.fulfill({ status: 202, json: sends === 1
      ? { ...run, status: "failed", text: "", errorCode: "AGENT_AUTH_REQUIRED" } : run });
  });

  await page.goto("/#articles");
  await newArticle(page);
  const picker = page.getByRole("combobox", { name: "选择智能体方案" });
  await expect(picker).toContainText("Codex");
  const input = page.getByLabel("向智能体提问");
  await input.fill("需要重新认证的请求");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(page.getByText(/重新登录后重试.*切换智能体方案/)).toBeVisible();
  await expect(input).toHaveValue("");
  await input.fill("需要重新认证的请求");
  await page.getByRole("button", { name: "重新发送上一条" }).click();
  await expect(page.getByRole("log")).toContainText("已收到。");
  await expect(input).toHaveValue("需要重新认证的请求");
  expect(sends).toBe(2);
});
