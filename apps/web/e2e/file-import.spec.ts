import { strToU8, zipSync } from "fflate";
import { expect, test } from "@playwright/test";

test("import dialog accepts multiple local files and keeps source filenames visible", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "导入资料" }).click();
  await expect(page.getByRole("dialog", { name: "导入资料" })).toBeVisible();
  await expect(page.getByText("拖拽文件到这里")).toBeVisible();
  await page.getByLabel("选择文件").setInputFiles([
    { name: "research.md", mimeType: "text/markdown", buffer: Buffer.from("# 本地研究\n\n可检索正文") },
    { name: "report.html", mimeType: "text/html", buffer: Buffer.from("<title>离线报告</title><main><p>报告内容</p></main>") },
  ]);
  await expect(page.getByRole("dialog", { name: "导入资料" })).toHaveCount(0);
  await expect(page.getByText("本地研究")).toBeVisible();
  await expect(page.getByText("离线报告")).toBeVisible();
  await expect(page.getByText("本地文件 · research.md")).toBeVisible();
  await expect(page.getByRole("status")).toContainText("已导入 2 篇");
});

test("dropping a ZIP imports its supported documents and reports skipped files", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "导入资料" }).click();
  const bytes = zipSync({
    "docs/a.md": strToU8("# ZIP 第一篇\n\n正文"),
    "docs/b.txt": strToU8("ZIP 第二篇"),
    "docs/image.png": Uint8Array.from([137, 80, 78, 71]),
  });
  await page.evaluate((data) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(data)], "docs.zip", { type: "application/zip" }));
    document.querySelector(".import-dropzone")!.dispatchEvent(new DragEvent("drop", {
      bubbles: true, cancelable: true, dataTransfer: transfer,
    }));
  }, Array.from(bytes));
  await expect(page.getByText("ZIP 第一篇")).toBeVisible();
  await expect(page.getByText("b", { exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("跳过 1 个");
});

test("an unsupported ZIP keeps the dialog open with an actionable error", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "导入资料" }).click();
  await page.getByLabel("选择文件").setInputFiles({ name: "images.zip", mimeType: "application/zip",
    buffer: Buffer.from(zipSync({ "image.png": Uint8Array.from([137, 80, 78, 71]) })) });
  await expect(page.getByRole("dialog", { name: "导入资料" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("ZIP 中没有可识别的 Markdown、HTML 或纯文本文件");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "导入资料" })).toHaveCount(0);
});
