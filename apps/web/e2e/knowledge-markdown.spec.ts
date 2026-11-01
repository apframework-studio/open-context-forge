import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

test("knowledge reader renders Obsidian properties and links with room to read", async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), "ocf-knowledge-markdown-"));
  const vault = join(root, "notes");
  mkdirSync(vault);
  const original = "---\ntype: knowledge_map\ntopic: 文脉引擎\nsources:\n  - Foundation.md\nlast_reviewed: 2026-05-14\n---\n# Knowledge Map\n\n这张地图用于理解知识资产。\n\n核心主线是 [[Foundation#核心判断|系统基础]]。\n\n[[Missing|尚未形成的概念]]\n\n`[[Foundation]]`\n\n| 类型 | 数量 |\n| --- | --- |\n| 概念 | 35 |\n\n" + "阅读正文，保持周边导航稳定。\n\n".repeat(60);
  writeFileSync(join(vault, "Map.md"), original);
  writeFileSync(join(vault, "Foundation.md"), `# Foundation\n\n${"背景段落\n\n".repeat(30)}## 核心判断\n\n将来源编译为知识资产。\n\n[[Map|返回知识地图]]\n\n${"补充资料\n\n".repeat(30)}`);
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByLabel("知识库 ID").fill("markdown-reader");
    await page.getByLabel("外部 vault 路径").fill(vault);
    await page.getByRole("button", { name: "连接知识库", exact: true }).click();
    await page.getByRole("button", { name: "确认连接此目录" }).click();
    await page.getByRole("button", { name: "知识库", exact: true }).click();
    await page.getByRole("combobox", { name: "选择知识库" }).click();
    await page.getByRole("option", { name: "markdown-reader" }).click();
    await page.getByRole("tab", { name: "浏览" }).click();
    await page.locator(".knowledge-item-list").getByRole("button", { name: /Knowledge Map/ }).click();
    const reader = page.getByLabel("内容详情");
    await expect(reader.locator(".knowledge-markdown")).toContainText("这张地图");
    await expect(reader.getByRole("link", { name: "系统基础", exact: true })).toBeVisible();
    await expect(reader.locator(".knowledge-properties")).not.toHaveAttribute("open", "");
    await expect(reader.locator(".knowledge-markdown")).not.toContainText("knowledge_map");
    await expect(reader.locator(".knowledge-markdown h1")).toHaveCount(0);
    await expect(reader.locator(".knowledge-note-unresolved")).toHaveAttribute("title", /目标不存在/);
    await expect(reader.locator(".knowledge-markdown code")).toHaveText("[[Foundation]]");
    await expect(reader.getByRole("table")).toContainText("35");
    await reader.locator(".knowledge-properties summary").click();
    await expect(reader.locator(".knowledge-properties")).toContainText("2026-05-14");
    await reader.locator(".knowledge-properties summary").click();

    const previousWidth = (await reader.boundingBox())!.width;
    await reader.getByRole("button", { name: "专注阅读", exact: true }).click();
    await expect(page.locator(".knowledge-results")).toBeHidden();
    expect((await reader.boundingBox())!.width).toBeGreaterThan(previousWidth + 200);
    await reader.getByRole("link", { name: "系统基础", exact: true }).click();
    await expect(reader.getByRole("heading", { name: "Foundation", exact: true })).toBeVisible();
    await expect(reader.getByRole("heading", { name: "核心判断", exact: true })).toBeInViewport();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await reader.getByRole("link", { name: "返回知识地图", exact: true }).click();
    await expect(reader.getByRole("heading", { name: "Knowledge Map", exact: true })).toBeVisible();
    await reader.getByRole("button", { name: "查看 Markdown", exact: true }).click();
    await expect(reader.locator(".knowledge-document-source")).toContainText("[[Foundation#核心判断|系统基础]]");
    await reader.getByRole("button", { name: "阅读正文", exact: true }).click();
    await page.screenshot({ path: "/private/tmp/ocf-knowledge-reader-desktop.png" });
    await reader.getByRole("button", { name: "退出专注", exact: true }).click();
    await expect(page.locator(".knowledge-results")).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.locator(".shell").evaluate((element) => getComputedStyle(element).paddingLeft)).toBe("0px");
    await expect(reader.getByRole("link", { name: "系统基础", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: "/private/tmp/ocf-knowledge-reader-mobile.png" });
    expect(readFileSync(join(vault, "Map.md"), "utf8")).toBe(original);

    // A file may disappear in Obsidian between indexing and following its link.
    await page.setViewportSize({ width: 1440, height: 900 });
    await reader.getByRole("button", { name: "专注阅读", exact: true }).click();
    rmSync(join(vault, "Foundation.md"));
    await reader.getByRole("link", { name: "系统基础", exact: true }).click();
    await expect(page.locator(".knowledge-results")).toBeVisible();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
