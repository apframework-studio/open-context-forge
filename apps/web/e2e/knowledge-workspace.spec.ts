import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

test("connect, browse, search, graph, rescan and disconnect an existing vault", async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), "ocf-e2e-vault-"));
  const vault = join(root, "obsidian");
  mkdirSync(vault);
  writeFileSync(join(vault, "Alpha.md"), "# Alpha\n旧笔记正文\n[[Beta]]\n");
  writeFileSync(join(vault, "Beta.md"), "# Beta\n另一篇原有笔记\n");
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByLabel("知识库 ID").fill("e2e-notes");
    await page.getByLabel("外部 vault 路径").fill(vault);
    await page.getByRole("button", { name: "连接知识库", exact: true }).click();
    await expect(page.getByText("采用前预览")).toBeVisible();
    await page.getByRole("button", { name: "确认连接此目录" }).click();
    await expect(page.getByText("知识库已连接，原有笔记可在知识库中浏览")).toBeVisible();

    await page.getByRole("button", { name: "知识库", exact: true }).click();
    await expect(page.getByRole("heading", { name: "最近修改笔记" })).toBeVisible();
    await page.getByRole("combobox", { name: "选择知识库" }).click();
    await page.getByRole("option", { name: "e2e-notes" }).click();
    await expect(page.getByRole("button", { name: /Alpha/ }).first()).toBeVisible();
    await page.getByRole("tab", { name: "浏览" }).click();
    await page.getByRole("button", { name: /Alpha/ }).first().click();
    await expect(page.getByLabel("内容详情")).toContainText("旧笔记正文");
    await expect(page.getByLabel("内容详情")).toContainText("反向链接");
    await page.getByRole("tab", { name: "图谱" }).click();
    await expect(page.getByText("2 个节点 · 1 条可验证关系")).toBeVisible();

    writeFileSync(join(vault, "Beta.md"), "# Beta\n已在 Obsidian 更新\n");
    await page.getByRole("button", { name: "更多操作" }).click();
    await page.getByRole("button", { name: "重新索引" }).first().click();
    await page.getByLabel("搜索知识库").fill("已在 Obsidian 更新");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await expect(page.locator(".knowledge-list-meta")).toContainText("1 项");

    await page.setViewportSize({ width: 375, height: 812 });
    await page.locator(".knowledge-item-list").getByRole("button", { name: /Beta\.md/ }).click();
    await expect(page.getByLabel("内容详情")).toContainText("已在 Obsidian 更新");
    await expect(page.locator(".knowledge-results")).toBeHidden();
    await page.getByRole("button", { name: "列表", exact: true }).click();
    await expect(page.locator(".knowledge-results")).toBeVisible();

    await page.getByRole("button", { name: "更多操作" }).click();
    await page.getByRole("button", { name: "知识库连接设置" }).click();
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator(".knowledge-connection").filter({ hasText: "e2e-notes" }).getByRole("button", { name: "断开连接" }).click();
    await expect(page.getByText("e2e-notes 已断开，原文件保留")).toBeVisible();
    expect(readFileSync(join(vault, "Alpha.md"), "utf8")).toContain("旧笔记正文");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("automatic maintenance can be enabled for one vault and survives reload", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const toggle = page.getByRole("checkbox", { name: "default 入库后自动维护" });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(page.getByText("default 已启用入库后自动维护")).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "default 入库后自动维护" })).toBeChecked();
});
