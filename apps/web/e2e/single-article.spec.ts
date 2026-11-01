import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { fixtureZip } from "./fixtures";

test("one source reaches a reviewed blog package through the workflow", async ({ page, request }) => {
  const policy = await request.put(`http://127.0.0.1:${process.env.OCF_E2E_SERVER_PORT}/api/v1/imports/policy`, {
    headers: { "x-ocf-client": "1" }, data: { mode: "manual" },
  });
  expect(policy.ok()).toBe(true);
  const external = mkdtempSync(join(tmpdir(), "ocf-e2e-external-"));
  writeFileSync(join(external, "Existing note.md"), "# Existing note\n");
  try {
    await page.goto("/");
    await expect(page.getByRole("region", { name: "资料列表" })).toBeVisible();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByLabel("知识库 ID").fill("research");
    await page.getByLabel("外部 vault 路径").fill(external);
    await page.getByRole("button", { name: "连接知识库", exact: true }).click();
    await expect(page.getByText("采用前预览")).toBeVisible();
    await page.getByRole("button", { name: "确认连接此目录" }).click();
    await expect(page.locator(".vault-row").getByText("research", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: /资料与分析/ }).click();
    await page.getByRole("button", { name: "导入资料" }).click();
    await page.getByLabel("选择文件").setInputFiles({ name: "clipper.zip", mimeType: "application/zip", buffer: fixtureZip });
    await expect(page.getByText("来源文章 A")).toBeVisible();
    const fileButton = page.locator(".source-row").filter({ hasText: "来源文章 A" }).getByRole("button", { name: "入库" });
    await expect(fileButton).toBeEnabled();
    await fileButton.click();
    const vaultDialog = page.getByRole("dialog", { name: "添加到知识库" });
    await vaultDialog.getByRole("checkbox", { name: /research/ }).check();
    await vaultDialog.getByRole("button", { name: "确认入库" }).click();
    await expect(page.getByRole("status")).toContainText("已加入 1 个知识库入库队列");
    await page.reload();
    await page.getByRole("tab", { name: /最近处理/ }).click();
    await expect(page.getByText("来源文章 A")).toBeVisible();
    await expect(page.locator(".source-row").filter({ hasText: "来源文章 A" }).getByText("已入库", { exact: true })).toBeVisible();
    await expect(page.locator(".source-row").filter({ hasText: "来源文章 A" }).getByRole("button", { name: "生成智能摘要" })).toBeVisible();

    await page.getByRole("button", { name: /文章工作台/ }).click();
    await page.getByRole("button", { name: "新建文章" }).click();
    await page.getByLabel("文章标题").fill("我的文章");
    await page.getByRole("button", { name: "发布信息", exact: true }).click();
    await page.getByLabel("公开摘要").fill("一篇有来源的文章");
    await page.getByLabel("发布日期").fill("2026-10-22");
    await page.getByRole("button", { name: "完成设置" }).click();
    await expect(page.getByRole("status")).toContainText("草稿已保存");
    const conversation = page.getByLabel("当前文章对话");
    await expect(conversation).toBeVisible();
    await expect(page.getByLabel("向智能体提问")).toBeEnabled();
    await page.getByRole("button", { name: "专注对话" }).click();
    await expect(page.getByRole("region", { name: "文章文稿" })).toBeHidden();
    await page.getByRole("button", { name: "知识库", exact: true }).click();
    await expect(page.getByLabel("向智能体提问")).toHaveCount(0);
    await page.getByRole("button", { name: /文章工作台/ }).click();
    await expect(conversation).toBeVisible();
    const articleId = await page.evaluate(() => localStorage.getItem("ocf-last-article"));
    const article = await (await page.request.get(`/api/v1/articles/${articleId}`)).json();
    const prepared = await page.request.put(`/api/v1/articles/${articleId}/draft`, { headers: { "x-ocf-client": "1" },
      data: { markdown: "# 我的文章\n\n这是经过审稿的判断。", title: article.title,
        summary: article.summary, date: article.date, expectedRevision: article.revision } });
    expect(prepared.ok()).toBe(true);
    await page.reload();
    await page.getByRole("button", { name: /文章工作台/ }).click();
    await expect(page.getByRole("region", { name: "文章正文" })).toContainText("经过审稿的判断");
    await expect(page.getByLabel("向智能体提问")).toBeEnabled();
    await expect(page.getByRole("status")).toContainText("已自动保存");
    await expect(page.getByLabel("向智能体提问")).toBeEnabled();
    await page.getByRole("button", { name: "阅读文章", exact: true }).click();
    await expect(page.getByRole("heading", { name: "我的文章", level: 1 })).toBeVisible();
    await page.getByRole("button", { name: "定稿" }).click();
    await expect(page.getByRole("status")).toHaveText("已定稿");

    await page.getByRole("button", { name: /预览与发布/ }).click();
    await expect(page.getByLabel("向智能体提问")).toHaveCount(0);
    await page.getByLabel("文章 slug").fill("my-article");
    await page.getByRole("button", { name: "生成本地发布包" }).click();
    await expect(page.getByRole("status").getByText("本地包已准备")).toBeVisible();
    await page.getByRole("button", { name: "打开发布确认" }).click();
    await expect(page.getByRole("dialog", { name: "发布确认" }).getByText("data/blog/essay/2026-10-22-my-article.mdx")).toBeVisible();
    await expect(page.getByRole("button", { name: "确认写入并推送" })).toBeVisible();
  } finally { rmSync(external, { recursive: true, force: true }); }
});

test("mobile workspace keeps navigation and vault controls inside the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  await expect(page.getByRole("button", { name: /资料与分析/ })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: /资料与分析/ })).toBeFocused();
  await page.getByRole("button", { name: "知识库", exact: true }).click();
  await expect(page.getByRole("heading", { name: "全部知识库" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await page.setViewportSize({ width: 1024, height: 768 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1024);
});
