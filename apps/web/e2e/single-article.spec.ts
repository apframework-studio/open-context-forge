import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { fixtureZip } from "./fixtures";

test("one source reaches a reviewed blog package through the workflow", async ({ page }) => {
  const external = mkdtempSync(join(tmpdir(), "ocf-e2e-external-"));
  writeFileSync(join(external, "Existing note.md"), "# Existing note\n");
  try {
    await page.goto("/");
    await expect(page.getByLabel("目标知识库")).toHaveValue("default");
    await page.getByRole("button", { name: /知识库/ }).click();
    await page.getByLabel("知识库 ID").fill("research");
    await page.getByLabel("外部 vault 路径").fill(external);
    await page.getByRole("button", { name: "添加外部知识库" }).click();
    await expect(page.getByText("需要确认采用")).toBeVisible();
    await page.getByRole("button", { name: "确认采用此目录" }).click();
    await expect(page.getByText("research")).toBeVisible();

    await page.getByRole("button", { name: /资料与分析/ }).click();
    await page.getByLabel("导入 Clipper ZIP").setInputFiles({ name: "clipper.zip", mimeType: "application/zip", buffer: fixtureZip });
    await expect(page.getByText("来源文章 A")).toBeVisible();
    await page.getByLabel("目标知识库").selectOption("research");
    await page.getByRole("button", { name: "确认导入" }).click();
    await expect(page.getByText("已导入 research")).toBeVisible();
    await page.reload();
    await expect(page.getByText("来源文章 A")).toBeVisible();
    await expect(page.getByText("已导入", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: /文章工作台/ }).click();
    await page.getByLabel("文章标题").fill("我的文章");
    await page.getByLabel("公开摘要").fill("一篇有来源的文章");
    await page.getByLabel("发布日期").fill("2026-10-22");
    await page.getByRole("button", { name: "创建文章" }).click();
    await page.getByLabel("文章正文").fill("# 我的文章\n\n这是经过审稿的判断。");
    await expect(page.getByText(/草稿已保存/)).toBeVisible();
    await page.getByRole("button", { name: "本地预览" }).click();
    await expect(page.getByRole("heading", { name: "我的文章", level: 1 })).toBeVisible();
    await page.getByRole("button", { name: "定稿" }).click();
    await expect(page.getByText("已定稿", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: /预览与发布/ }).click();
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
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: /资料与分析/ })).toBeFocused();
  await page.getByRole("button", { name: /知识库/ }).click();
  await expect(page.getByRole("heading", { name: "已连接的知识库" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await page.setViewportSize({ width: 1024, height: 768 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1024);
});
