import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

test("overview shows a remembered item count and useful metadata without file paths", async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), "ocf-overview-"));
  const vault = join(root, "notes");
  mkdirSync(vault);
  for (let index = 1; index <= 12; index++) {
    writeFileSync(join(vault, `Entry ${String(index).padStart(2, "0")}.md`), `# Entry ${index}\nContent ${index}\n`);
  }
  try {
    await page.addInitScript(() => localStorage.setItem("ocf-knowledge-overview-limit", "8"));
    await page.goto("/");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByLabel("知识库 ID").fill("overview-count");
    await page.getByLabel("外部 vault 路径").fill(vault);
    await page.getByRole("button", { name: "连接知识库", exact: true }).click();
    await page.getByRole("button", { name: "确认连接此目录" }).click();
    await page.getByRole("button", { name: "知识库", exact: true }).click();
    await page.getByRole("combobox", { name: "选择知识库" }).click();
    await page.getByRole("option", { name: "overview-count" }).click();

    const notes = page.locator(".knowledge-overview section").filter({ has: page.getByRole("heading", { name: "最近修改笔记" }) });
    await expect(page.getByRole("combobox", { name: "每组显示" })).toContainText("10 条");
    await expect(notes.locator(".knowledge-recent-item")).toHaveCount(10);
    await page.getByRole("combobox", { name: "每组显示" }).click();
    await page.getByRole("option", { name: "20 条" }).click();
    await expect(notes.locator(".knowledge-recent-item")).toHaveCount(12);
    const first = notes.locator(".knowledge-recent-item").first();
    await expect(first).toContainText("overview-count");
    await expect(first).toContainText("修改于");
    expect(await first.innerText()).not.toContain(".md");
    await page.getByRole("button", { name: /资料与分析/ }).click();
    await page.getByRole("button", { name: "知识库", exact: true }).click();
    await page.getByRole("combobox", { name: "选择知识库" }).click();
    await page.getByRole("option", { name: "overview-count" }).click();
    await expect(page.getByRole("combobox", { name: "每组显示" })).toContainText("20 条");
    await expect(notes.locator(".knowledge-recent-item")).toHaveCount(12);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
