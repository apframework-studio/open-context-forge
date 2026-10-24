import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

test("knowledge browsing keeps a long article beside a smaller list inside the viewport", async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), "ocf-reading-layout-"));
  const vault = join(root, "notes");
  mkdirSync(vault);
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
    await page.setViewportSize({ width: 936, height: 800 });
    await page.getByLabel("选择知识库").selectOption("reading-layout");
    await page.getByRole("tab", { name: "浏览" }).click();
    await page.locator(".knowledge-item-list").getByRole("button", { name: /Long Read/ }).click();
    await expect(page.locator(".knowledge-markdown")).toContainText("A paragraph to read");

    const layout = await page.evaluate(() => {
      const browser = document.querySelector(".knowledge-browser")!.getBoundingClientRect();
      const results = document.querySelector(".knowledge-results")!.getBoundingClientRect();
      const detail = document.querySelector(".knowledge-detail")!;
      const reader = detail.getBoundingClientRect();
      return {
        browserWidth: browser.width, resultsWidth: results.width, readerWidth: reader.width,
        aligned: Math.abs(results.top - reader.top) < 2,
        pageHeight: document.documentElement.scrollHeight,
        readerScrolls: detail.scrollHeight > detail.clientHeight,
      };
    });
    expect(layout.aligned).toBe(true);
    expect(layout.readerWidth).toBeGreaterThan(layout.resultsWidth);
    expect(layout.readerWidth).toBeGreaterThan(layout.browserWidth * 0.55);
    expect(layout.pageHeight).toBeLessThanOrEqual(801);
    expect(layout.readerScrolls).toBe(true);

    const filtersTop = (await page.locator(".knowledge-filter-row").boundingBox())!.y;
    await page.locator(".knowledge-item-list").hover();
    await page.mouse.wheel(0, 500);
    await expect.poll(() => page.locator(".knowledge-item-list").evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    expect((await page.locator(".knowledge-filter-row").boundingBox())!.y).toBe(filtersTop);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
