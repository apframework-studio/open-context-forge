import { expect, test } from "@playwright/test";
import { resolve } from "node:path";

test("the language setting updates the workspace and survives a reload", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/#settings");
  await page.getByRole("button", { name: "English", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Import rules" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);

  await page.reload();
  await expect(page.getByRole("button", { name: "English", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "中文", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.getByRole("heading", { name: "设置", level: 1 })).toBeVisible();
});

test("switching the workspace language keeps the current article and its writing state", async ({ page }) => {
  await page.goto("/#articles");
  await page.getByRole("button", { name: "新建文章", exact: true }).click();
  await expect(page).toHaveURL(/#articles\/[^/]+$/);
  const articleUrl = page.url();
  const title = "A bilingual article";
  await page.getByLabel("文章标题", { exact: true }).fill(title);
  await page.getByLabel("向智能体提问").fill("Keep this unsent message.");
  await page.getByRole("button", { name: "切换到英语", exact: true }).click();
  await expect(page).toHaveURL(articleUrl);
  await expect(page.getByLabel("Article title", { exact: true })).toHaveValue(title);
  await expect(page.getByRole("button", { name: "Read article", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Ask the assistant" })).toHaveValue("Keep this unsent message.");
  await page.getByRole("button", { name: "Build an outline", exact: true }).click();
  await expect(page.getByRole("group", { name: "Suggested prompt" })).toContainText("Create a reviewable outline");
});

test("two English walkthrough sources become an English article and offline HTML", async ({ page, request }) => {
  const policy = await request.put(`http://127.0.0.1:${process.env.OCF_E2E_SERVER_PORT}/api/v1/imports/policy`, {
    headers: { "x-ocf-client": "1" }, data: { mode: "auto-file", vaultId: "default" },
  });
  expect(policy.ok()).toBe(true);

  await page.goto("/#sources");
  await page.getByRole("button", { name: "切换到英语", exact: true }).click();
  await page.getByRole("button", { name: "Import sources", exact: true }).click();
  const examples = resolve(import.meta.dirname, "../../../docs/examples/walkthrough/en");
  await page.getByLabel("Choose files").setInputFiles([
    resolve(examples, "library-lending.md"),
    resolve(examples, "library-handover.md"),
  ]);
  await expect(page.getByRole("tab", { name: /All sources/ })).toHaveAttribute("aria-selected", "true");
  const titles = ["The Neighborhood Library's Lending Log", "A Volunteer Handover at the Neighborhood Library"];
  for (const title of titles) {
    const row = page.locator(".source-row").filter({ hasText: title });
    await expect(row.getByText("Filed", { exact: true })).toBeVisible();
    await row.getByRole("checkbox", { name: `Select ${title}` }).check();
  }
  await page.getByRole("button", { name: "Write article from selected sources", exact: true }).click();
  await expect(page).toHaveURL(/#articles\/[^/]+$/);
  const articleId = new URL(page.url()).hash.split("/")[1];
  const title = "Keep Library Handovers on Track";
  const articleText = "Record each loan and check the shelf at handover so the next shift can follow up on outstanding returns.";
  const attached = page.getByLabel("Sources for this message");
  for (const source of titles) await expect(attached).toContainText(source);
  await page.getByLabel("Article title", { exact: true }).fill(title);
  await page.route(`**/api/v1/articles/${articleId}/agent/runs`, async (route) => {
    expect(route.request().postDataJSON().selections).toEqual([{ materialId: "S1" }, { materialId: "S2" }]);
    const now = new Date().toISOString();
    await route.fulfill({ status: 202, json: { id: "locale-export-run", articleId, profileId: "claude-current", assistantMessageId: "assistant",
      status: "completed", text: articleText, finalAnswer: articleText, tools: [], permissions: [], seq: 1,
      activity: "已完成", errorCode: null, createdAt: now, updatedAt: now } });
  });
  await page.getByRole("textbox", { name: "Ask the assistant" }).fill("Write an English article using both selected sources.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.getByRole("button", { name: "Use as article text", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Adopt assistant draft" });
  await expect(review).toContainText(articleText);
  await review.getByRole("button", { name: "Replace article text", exact: true }).click();
  await page.getByRole("button", { name: "Finalize", exact: true }).click();
  await page.getByRole("button", { name: "Go to export", exact: true }).click();

  const preview = page.getByRole("region", { name: "Export preview" });
  await expect(preview.getByRole("heading", { name: title, level: 1 })).toBeVisible();
  await expect(preview).toContainText(articleText);
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.getByRole("button", { name: "Save as PDF", exact: true })).toBeInViewport();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download HTML", exact: true }).click();
  const file = await downloaded;
  expect(file.suggestedFilename()).toBe(`${title}.html`);
  const stream = await file.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const html = Buffer.concat(chunks).toString();
  expect(html).toContain('<html lang="en">');
  expect(html).toContain(articleText);
  expect(html).not.toMatch(/\p{Script=Han}/u);
});
