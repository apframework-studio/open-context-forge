import { expect, test } from "@playwright/test";

const proposal = { outline: null, draft: {
  markdown: "# 体验文章\n\n这是一段用于检查保存状态的正文。\n", sha256: "trailing-newline-draft", turnId: "ux-repair", updatedAt: "2026-11-07T00:00:00Z",
} };

async function createWithProposal(page: import("@playwright/test").Page) {
  await page.setViewportSize({ width: 1440, height: 810 });
  await page.route("**/api/v1/articles/*/writing-proposals", (route) => route.fulfill({ json: proposal }));
  await page.goto("/");
  await page.getByRole("button", { name: "文章工作台", exact: true }).click();
  await page.getByRole("button", { name: "新建文章" }).click();
  await expect(page.getByLabel("文章标题")).toBeVisible();
}

test("adopted body can finish saving without a reload when its candidate ends in a newline", async ({ page }) => {
  await createWithProposal(page);
  await page.getByRole("button", { name: "审阅正文草稿" }).click();
  await page.getByRole("dialog", { name: "采用智能体正文" }).getByRole("button", { name: "替换正文" }).click();
  await page.getByRole("button", { name: "文章信息", exact: true }).click();
  await page.getByLabel("文章摘要").fill("一段测试摘要");
  await page.getByLabel("文章日期").fill("2026-11-07");
  await page.getByRole("button", { name: "完成设置" }).click();
  await expect(page.getByRole("button", { name: "定稿", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "保存草稿" })).toBeDisabled();
  await expect(page.locator(".article-save-line [role=status]")).toContainText(/已自动保存|草稿已保存/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1440);
});

test("saved candidate does not return as pending after refresh when only terminal whitespace differs", async ({ page }) => {
  await createWithProposal(page);
  const articleId = await page.evaluate(() => localStorage.getItem("ocf-last-article"));
  const article = await (await page.request.get(`/api/v1/articles/${articleId}`)).json();
  const saved = await page.request.put(`/api/v1/articles/${articleId}/draft`, { headers: { "x-ocf-client": "1" }, data: {
    markdown: "# 体验文章\n\n这是一段用于检查保存状态的正文。", title: "体验文章", expectedRevision: article.revision,
  } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.reload();
  await expect(page.getByRole("region", { name: "文章正文" })).toContainText("检查保存状态");
  await expect(page.getByLabel("待采用正文预览")).toHaveCount(0);
});

test("the body count follows visible Markdown text and excludes the repeated article title", async ({ page }) => {
  await createWithProposal(page);
  const articleId = await page.evaluate(() => localStorage.getItem("ocf-last-article"));
  const saved = await page.request.put(`/api/v1/articles/${articleId}/draft`, { headers: { "x-ocf-client": "1" }, data: {
    markdown: "# **文章标题**\n\n## 小节\n\n- [x] **你好** [链接](https://example.com) 🎉\n\n| 甲 | 乙 |\n| --- | --- |\n| 丙 | 丁 |\n\n<!-- hidden -->",
    title: "文章标题", expectedRevision: 0,
  } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.reload();
  await expect(page.locator(".article-save-line")).toContainText("11 字");
});

test("finalization prompts for the title and body while a pending proposal remains separate", async ({ page }) => {
  await createWithProposal(page);
  const finalize = page.getByRole("button", { name: "定稿", exact: true });
  const guide = page.getByRole("region", { name: "定稿准备" });
  await expect(guide).toContainText("填写文章标题");
  await expect(guide).toContainText("正文");
  await finalize.click();
  await expect(page.getByLabel("文章标题")).toBeFocused();

  await page.getByLabel("文章标题").fill("正式文章");
  await finalize.click();
  await expect(page.locator(".article-save-line [role=status]")).toHaveText("定稿前请采用文章正文");
  await expect(guide.getByRole("button", { name: "审阅并采用正文" })).toBeVisible();
});

test("a completed save does not claim newer edits are saved", async ({ page }) => {
  await createWithProposal(page);
  let started: () => void = () => undefined;
  let release: () => void = () => undefined;
  const firstStarted = new Promise<void>((resolve) => { started = resolve; });
  const firstHeld = new Promise<void>((resolve) => { release = resolve; });
  let saves = 0;
  await page.route("**/api/v1/articles/*/draft", async (route) => {
    saves += 1;
    if (saves === 1) { started(); await firstHeld; }
    await route.continue();
  });
  await page.getByLabel("文章标题").fill("第一版标题");
  await firstStarted;
  await page.getByLabel("文章标题").fill("第二版标题");
  release();
  await expect(page.getByRole("button", { name: "保存草稿" })).toBeEnabled();
  await expect(page.locator(".article-save-line [role=status]")).toHaveText("有未保存的修改");
});
