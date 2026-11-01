import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

test("knowledge browsing keeps a long article beside a smaller list inside the viewport", async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), "ocf-reading-layout-"));
  const vault = join(root, "notes");
  mkdirSync(vault);
  const longFolder = "a-long-directory-for-knowledge-source-summaries";
  mkdirSync(join(vault, longFolder));
  writeFileSync(join(vault, longFolder, "Nested.md"), "# Nested\nNested note.");
  writeFileSync(join(vault, "Long Read.md"), `# Long Read\n\n${"A paragraph to read without losing the item list.\n\n".repeat(120)}`);
  for (let index = 0; index < 8; index++) writeFileSync(join(vault, `Note ${index}.md`), `# Note ${index}\n\nA short note.`);
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByLabel("知识库 ID").fill("reading-layout");
    await page.getByLabel("外部 vault 路径").fill(vault);
    await page.getByRole("button", { name: "连接知识库", exact: true }).click();
    await page.getByRole("button", { name: "确认连接此目录" }).click();
    await page.getByRole("button", { name: "知识库", exact: true }).click();
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.getByRole("combobox", { name: "选择知识库" }).click();
    await page.getByRole("option", { name: "reading-layout" }).click();
    await page.getByRole("tab", { name: "浏览" }).click();
    const directory = page.getByLabel("知识库目录", { exact: true });
    await expect.poll(async () => (await directory.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(200);
    const initialFolderWidth = (await directory.boundingBox())!.width;
    const folderHandle = page.getByRole("separator", { name: "调整目录宽度" });
    const handle = (await folderHandle.boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + 100);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 + 70, handle.y + 100, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => (await directory.boundingBox())!.width).toBeGreaterThan(initialFolderWidth + 60);
    const resizedFolderWidth = (await directory.boundingBox())!.width;
    await page.reload();
    await page.getByRole("button", { name: "知识库", exact: true }).click();
    await page.getByRole("combobox", { name: "选择知识库" }).click();
    await page.getByRole("option", { name: "reading-layout" }).click();
    await page.getByRole("tab", { name: "浏览" }).click();
    await expect.poll(async () => (await directory.boundingBox())!.width).toBeCloseTo(resizedFolderWidth, 0);
    const folderLabel = page.locator(".knowledge-folder-name").filter({ hasText: longFolder });
    await expect(folderLabel).toBeVisible();
    expect((await folderLabel.boundingBox())!.height).toBeLessThan(24);
    await expect(folderLabel.locator("..")).toHaveAttribute("title", `reading-layout / ${longFolder}`);
    await folderHandle.focus();
    await page.keyboard.press("ArrowLeft");
    await expect.poll(async () => (await directory.boundingBox())!.width).toBeCloseTo(resizedFolderWidth - 10, 0);
    await folderHandle.dblclick();
    await expect.poll(async () => (await directory.boundingBox())!.width).toBeCloseTo(initialFolderWidth, 0);
    await page.locator(".knowledge-item-list").getByRole("button", { name: /Long Read/ }).click();
    await expect(page.locator(".knowledge-markdown")).toContainText("A paragraph to read");
    const listHandle = page.getByRole("separator", { name: "调整列表宽度" });
    await listHandle.focus();
    await page.keyboard.press("End");
    expect((await page.getByLabel("内容详情").boundingBox())!.width).toBeGreaterThanOrEqual(419);
    await listHandle.dblclick();
    await page.getByRole("button", { name: "收起目录", exact: true }).click();
    await expect(directory).toBeHidden();
    await page.getByRole("button", { name: "显示目录", exact: true }).click();
    await expect(directory).toBeVisible();
    await page.screenshot({ path: "/private/tmp/ocf-knowledge-panes-wide.png" });
    await page.getByRole("button", { name: "收起列表", exact: true }).click();
    await expect(page.locator(".knowledge-results")).toBeHidden();
    await page.getByRole("button", { name: "显示列表", exact: true }).click();
    await expect(page.locator(".knowledge-results")).toBeVisible();
    await page.setViewportSize({ width: 936, height: 800 });
    await expect(directory).toBeHidden();
    await page.getByRole("button", { name: "显示目录", exact: true }).first().click();
    await expect(directory).toBeVisible();
    expect((await directory.boundingBox())!.width).toBeGreaterThanOrEqual(240);
    await page.screenshot({ path: "/private/tmp/ocf-knowledge-panes-drawer.png" });
    await page.getByRole("button", { name: "关闭目录", exact: true }).click();
    await expect(directory).toBeHidden();

    const layout = await page.evaluate(() => {
      const browser = document.querySelector(".knowledge-browser")!.getBoundingClientRect();
      const results = document.querySelector(".knowledge-results")!.getBoundingClientRect();
      const detail = document.querySelector(".knowledge-detail")!;
      const reader = detail.getBoundingClientRect();
      return {
        browserWidth: browser.width, browserBottom: browser.bottom, resultsWidth: results.width, readerWidth: reader.width,
        aligned: Math.abs(results.top - reader.top) < 2,
        pageHeight: document.documentElement.scrollHeight,
        readerScrolls: detail.scrollHeight > detail.clientHeight,
      };
    });
    expect(layout.aligned).toBe(true);
    expect(layout.readerWidth).toBeGreaterThan(layout.resultsWidth);
    expect(layout.readerWidth).toBeGreaterThan(layout.browserWidth * 0.55);
    expect(layout.pageHeight).toBeLessThanOrEqual(801);
    expect(layout.browserBottom).toBeGreaterThan(770);
    expect(layout.readerScrolls).toBe(true);

    const filtersTop = (await page.locator(".knowledge-filter-row").boundingBox())!.y;
    await page.locator(".knowledge-item-list").hover();
    await page.mouse.wheel(0, 500);
    await expect.poll(() => page.locator(".knowledge-item-list").evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    expect((await page.locator(".knowledge-filter-row").boundingBox())!.y).toBe(filtersTop);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
