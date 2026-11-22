import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import { fixtureZip } from "./fixtures";

test("automatic filing leads from two uploaded files to an article with both sources", async ({ page, request }) => {
  const policy = await request.put(`http://127.0.0.1:${process.env.OCF_E2E_SERVER_PORT}/api/v1/imports/policy`, {
    headers: { "x-ocf-client": "1" }, data: { mode: "auto-file", vaultId: "default" },
  });
  expect(policy.ok()).toBe(true);
  await page.goto("/");
  await page.getByRole("button", { name: "导入资料" }).click();
  const titles = ["试用资料甲", "试用资料乙"];
  await page.getByLabel("选择文件").setInputFiles(titles.map((title, index) => ({
    name: `trial-${index}.md`, mimeType: "text/markdown", buffer: Buffer.from(`# ${title}\n\n用于写作的来源内容。`),
  })));
  await expect(page.getByRole("tab", { name: /全部资料/ })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "查看已入库资料" }).click();
  for (const title of titles) {
    const row = page.locator(".source-row").filter({ hasText: title });
    await expect(row).toContainText("已入库");
    await row.getByRole("checkbox", { name: `选择 ${title}` }).check();
  }
  await page.getByRole("button", { name: "用所选资料写文章" }).click();
  await expect(page).toHaveURL(/#articles\/[\w-]+$/);
  for (const title of titles) await expect(page.getByLabel("本轮引用资料")).toContainText(title);
  await page.reload();
  for (const title of titles) await expect(page.getByLabel("本轮引用资料")).toContainText(title);
});

test("one source reaches a shareable HTML and PDF document with an illustration", async ({ page, request }) => {
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
    await page.getByRole("button", { name: "文章信息", exact: true }).click();
    await page.getByLabel("文章摘要").fill("一篇有来源的文章");
    await page.getByLabel("文章日期").fill("2026-10-22");
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
    await page.getByRole("button", { name: "选择创作资料", exact: true }).click();
    const materials = page.getByRole("dialog", { name: "选择创作资料" });
    await materials.getByLabel("选择知识库 research").check();
    await materials.getByLabel("选用 来源文章 A").check();
    await materials.getByRole("button", { name: "带入对话（1）" }).click();
    await expect(page.getByLabel("本轮引用资料")).toContainText("来源文章 A");
    await page.waitForURL(/#articles\/[\w-]+$/);
    const articleId = new URL(page.url()).hash.split("/")[1];
    await page.route(`**/api/v1/articles/${articleId}/agent/runs`, async (route) => {
      expect(route.request().postDataJSON().selections).toEqual([{ materialId: "S1" }]);
      const now = new Date().toISOString();
      await route.fulfill({ status: 202, json: { id: "export-flow-run", articleId, profileId: "claude-current", assistantMessageId: "assistant",
        status: "completed", text: "# 处理过程\n\n我会先核对资料。\n\n文章的引言。\n\n# 我的文章\n\n这是经过审稿的判断。",
        finalAnswer: "文章的引言。\n\n# 我的文章\n\n这是经过审稿的判断。", tools: [], permissions: [], seq: 1,
        activity: "已完成", errorCode: null, createdAt: now, updatedAt: now } });
    });
    await page.getByLabel("向智能体提问").fill("根据导入的资料写一篇短文。");
    await page.getByRole("button", { name: "发送消息" }).click();
    await page.getByRole("button", { name: "用作正文", exact: true }).click();
    const review = page.getByRole("dialog", { name: "采用智能体正文" });
    await expect(review).not.toContainText("我会先核对资料。");
    await expect(review).toContainText("文章的引言。");
    await review.getByRole("button", { name: "替换正文" }).click();
    await expect(page.getByRole("region", { name: "文章正文" })).toContainText("经过审稿的判断");
    await expect(page.getByText("草稿已保存", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "阅读文章", exact: true }).click();
    await expect(page.getByRole("heading", { name: "我的文章", level: 1 })).toBeVisible();
    await page.getByRole("button", { name: "定稿" }).click();
    await expect(page.getByRole("status")).toHaveText("已定稿");

    await page.getByRole("button", { name: "前往导出", exact: true }).click();
    await expect(page.getByLabel("向智能体提问")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "导出预览" })).toContainText("这是经过审稿的判断。");
    await expect(page.getByRole("region", { name: "导出预览" }).getByRole("heading", { name: "我的文章", level: 1 })).toHaveCount(1);
    await expect(page.getByRole("region", { name: "导出预览" })).toContainText("文章的引言。");
    await expect(page.getByText(/微博|即刻|博客|渠道/)).toHaveCount(0);
    await page.getByRole("button", { name: "图片素材", exact: true }).click();
    await page.getByLabel("上传本地图片").setInputFiles(resolve(import.meta.dirname, "../public/favicon-32x32.png"));
    await expect(page.getByRole("status")).toContainText("已上传 1 张图片");
    await page.getByRole("button", { name: "导出预览", exact: true }).click();
    await page.getByRole("checkbox", { name: "favicon-32x32.png" }).check();
    await expect(page.getByRole("region", { name: "导出预览" }).getByRole("img", { name: "favicon-32x32.png" })).toBeVisible();
    await page.setViewportSize({ width: 375, height: 812 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole("group", { name: "界面配色" }).getByRole("button", { name: "深色" }).click();
    await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
    await expect(page.getByRole("region", { name: "导出预览" })).toHaveCSS("background-color", "rgb(255, 255, 255)");

    const downloadStarted = page.waitForEvent("download");
    await page.getByRole("button", { name: "下载 HTML" }).click();
    const download = await downloadStarted;
    expect(download.suggestedFilename()).toBe("我的文章.html");
    const htmlPath = join(external, "offline-export.html");
    await download.saveAs(htmlPath);
    const offline = await page.context().newPage();
    try {
      await offline.goto(pathToFileURL(htmlPath).href);
      await expect(offline.getByRole("heading", { name: "我的文章", level: 1 })).toHaveCount(1);
      await expect(offline.getByText("这是经过审稿的判断。")).toBeVisible();
      await expect(offline.getByRole("img")).toHaveAttribute("src", /^data:image\/png;base64,/);
      await expect.poll(() => offline.getByRole("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
      const pdf = await offline.pdf({ preferCSSPageSize: true });
      expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
      expect(pdf.includes(Buffer.from("/Subtype /Image"))).toBe(true);
    } finally { await offline.close(); }

    await page.evaluate(() => {
      document.addEventListener("load", (event) => {
        if (event.target instanceof HTMLIFrameElement && event.target.title === "PDF 打印文档" && event.target.contentWindow) {
          event.target.contentWindow.print = () => { document.body.dataset.printInvoked = "true"; };
        }
      }, { capture: true });
    });
    await page.getByRole("button", { name: "另存为 PDF" }).click();
    const print = page.frameLocator('iframe[title="PDF 打印文档"]');
    await expect(print.getByRole("heading", { name: "我的文章", level: 1 })).toHaveCount(1);
    await expect(print.getByRole("img")).toHaveAttribute("src", /^data:image\/png;base64,/);
    await expect(page.locator("body")).toHaveAttribute("data-print-invoked", "true");
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
