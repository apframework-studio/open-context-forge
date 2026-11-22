import { expect, test, type Page } from "@playwright/test";

async function seedDraft(page: Page, markdown: string) {
  await expect(page.getByLabel("文章标题")).toBeVisible();
  await expect(page).toHaveURL(/#articles\/[a-f0-9-]+$/);
  const id = new URL(page.url()).hash.split("/")[1];
  const article = await (await page.request.get(`/api/v1/articles/${id}`)).json();
  const response = await page.request.put(`/api/v1/articles/${id}/draft`, { headers: { "x-ocf-client": "1" },
    data: { markdown, title: article.title, summary: article.summary, date: article.date, expectedRevision: article.revision } });
  expect(response.ok()).toBe(true);
  await page.reload();
  await page.getByRole("button", { name: /文章工作台/ }).click();
}

test("blank articles are created immediately and remain separate across switching and reload", async ({ page }) => {
  const startingCount = (await (await page.request.get("/api/v1/articles")).json()).items.length as number;
  await page.goto("/");
  await page.getByRole("button", { name: /文章工作台/ }).click();
  await expect(page.getByLabel("文章列表")).toBeVisible();
  await expect(page.locator(".article-list-item")).toHaveCount(Math.min(12, startingCount));
  await page.getByRole("button", { name: "新建文章" }).click();
  await expect(page.getByLabel("文章标题")).toHaveValue("");
  await expect(page.getByRole("region", { name: "文章正文" })).toHaveCount(0);
  const firstTitle = `空稿隔离 ${Date.now()}`;
  await page.getByLabel("文章标题").fill(firstTitle);
  await expect(page.getByRole("region", { name: "文章列表", exact: true })).toHaveCount(0);
  await expect(page.locator(".article-save-line").getByRole("status")).toContainText("草稿已保存");
  await seedDraft(page, "# 第一篇\n\n先写内容，标题以后再定。");
  await page.getByRole("button", { name: "返回文章列表" }).click();
  await expect(page.locator(".article-list-item").filter({ has: page.getByRole("button", { name: firstTitle, exact: true }) }).getByText("写作中", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "新建文章" }).click();
  await expect(page.getByRole("region", { name: "文章正文" })).toHaveCount(0);
  await page.getByRole("button", { name: "返回文章列表" }).click();
  await expect(page.locator(".article-list-item")).toHaveCount(Math.min(12, startingCount + 2));
  await page.getByRole("button", { name: firstTitle, exact: true }).click();
  await expect(page.getByRole("region", { name: "文章正文" })).toContainText("先写内容，标题以后再定。");
  const articleId = await page.evaluate(() => localStorage.getItem("ocf-last-article"));
  await expect(page).toHaveURL(new RegExp(`#articles/${articleId}`));
  await page.reload();
  await expect(page.getByRole("button", { name: "文章工作台", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("region", { name: "文章正文" })).toContainText("先写内容，标题以后再定。");
});

test("finalization asks for a title and saves a draft with no summary or selected date", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /文章工作台/ }).click();
  await page.getByRole("button", { name: "新建文章" }).click();
  await seedDraft(page, "# 初稿\n\n有完整正文。");
  await page.getByRole("button", { name: "定稿", exact: true }).click();
  await expect(page.locator(".article-save-line").getByRole("status")).toContainText("定稿前请填写文章标题");
  await expect(page.getByRole("textbox", { name: "文章标题" })).toBeFocused();

  await page.getByLabel("文章标题").fill("正式文章");
  await page.getByRole("button", { name: "定稿", exact: true }).click();
  await expect(page.locator(".article-save-line").getByRole("status")).toHaveText("已定稿");
  await page.getByRole("button", { name: "文章信息", exact: true }).click();
  await expect(page.getByLabel("文章摘要")).toHaveValue("");
  await expect(page.getByLabel("文章日期")).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
  await page.getByRole("button", { name: "完成设置" }).click();
  await expect(page.getByRole("button", { name: "保存草稿" })).toBeDisabled();
  await page.getByRole("button", { name: "返回文章列表" }).click();
  await expect(page.getByLabel("文章列表").getByText("已定稿", { exact: true })).toBeVisible();
});

test("a draft stays in the workbench and a finalized article opens export for the same article", async ({ page }) => {
  const title = `工作台发布衔接检查 ${crypto.randomUUID()}`;
  const summary = "验证工作台到导出文章的衔接";
  const date = "2026-11-08";
  await page.goto("/#articles");
  await page.getByRole("button", { name: "新建文章" }).click();
  await page.getByLabel("文章标题").fill(title);
  await expect(page.locator(".article-save-line").getByRole("status")).toContainText("草稿已保存");
  await page.getByRole("button", { name: "返回文章列表" }).click();
  const row = page.locator(".article-list-item").filter({ has: page.getByRole("button", { name: title, exact: true }) });
  await expect(row.getByRole("button", { name: "前往导出", exact: true })).toHaveCount(0);
  await row.getByRole("button", { name: "继续写作" }).click();
  await expect(page.getByRole("textbox", { name: "文章标题" })).toHaveValue(title);
  await expect(page.getByRole("region", { name: "定稿准备" })).toContainText("先在 AI 写作中起草正文");

  await seedDraft(page, `# ${title}\n\n这是一篇可以定稿的测试正文。`);
  const path = `/api/v1/articles/${new URL(page.url()).hash.split("/")[1]}`;
  await page.getByRole("button", { name: "文章信息", exact: true }).click();
  await page.getByLabel("文章摘要").fill(summary);
  await page.getByLabel("文章日期").fill(date);
  await page.getByRole("button", { name: "完成设置" }).click();
  await expect.poll(async () => {
    const persisted = await (await page.request.get(path)).json();
    return { summary: persisted.summary, date: persisted.date };
  }).toEqual({ summary, date });
  await page.getByRole("button", { name: "定稿", exact: true }).click();
  await expect(page.getByRole("button", { name: "前往导出" })).toBeVisible();
  await page.getByRole("button", { name: "前往导出" }).click();
  await expect(page.getByRole("region", { name: "导出预览" })).toContainText(title);
  await expect(page.getByRole("button", { name: "另存为 PDF" })).toBeVisible();
  await expect(page.getByRole("button", { name: "下载 HTML" })).toBeVisible();
});

test("article list and editor stay within mobile and medium viewports", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  await page.getByRole("button", { name: /文章工作台/ }).click();
  await page.getByRole("button", { name: "新建文章" }).click();
  await page.getByRole("tab", { name: "文章正文", exact: true }).click();
  await expect(page.getByRole("region", { name: "文章文稿" })).toBeVisible();
  await expect(page.getByRole("region", { name: "文章正文" })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await page.setViewportSize({ width: 1024, height: 768 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1024);
});

test("writing gives chat and manuscript room while reading focuses on the article", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: /文章工作台/ }).click();
  await page.getByRole("button", { name: "新建文章" }).click();
  const conversation = page.getByLabel("当前文章对话");
  const manuscript = page.getByRole("region", { name: "文章文稿" });
  await expect(conversation).toBeVisible();
  const chatBox = (await conversation.boundingBox())!;
  const manuscriptBox = (await manuscript.boundingBox())!;
  expect(chatBox.width).toBeGreaterThan(450);
  expect(manuscriptBox.width).toBeGreaterThan(400);
  expect(Math.abs(chatBox.y - manuscriptBox.y)).toBeLessThanOrEqual(2);
  expect(manuscriptBox.x + manuscriptBox.width).toBeLessThanOrEqual(chatBox.x);
  const materialButton = (await page.getByRole("button", { name: "选择创作资料", exact: true }).boundingBox())!;
  expect(Math.abs(materialButton.x - manuscriptBox.x)).toBeLessThanOrEqual(2);
  await page.screenshot({ path: "/private/tmp/ocf-article-layout-swapped.png" });
  await page.getByRole("button", { name: "专注对话" }).click();
  await expect(manuscript).toBeHidden();
  expect((await conversation.boundingBox())!.width).toBeGreaterThan(chatBox.width * 1.5);
  await page.getByRole("button", { name: "恢复双栏" }).click();
  await seedDraft(page, "# 阅读中的文章\n\n正文阅读区域应该充分展开。");
  await page.getByRole("button", { name: "阅读文章", exact: true }).click();
  await expect(conversation).toBeHidden();
  const reader = page.getByRole("region", { name: "文章阅读" });
  await expect(reader).toContainText("正文阅读区域应该充分展开");
  expect((await reader.boundingBox())!.width).toBeGreaterThan(manuscriptBox.width * 1.5);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(901);
});

test("chat saves current text before sending and a reviewed reply can become the manuscript", async ({ page }) => {
  await page.route("**/api/v1/agents/profiles", (route) => route.fulfill({ json: { profiles: [
    { id: "claude-current", label: "Claude CLI", available: true, reason: "", description: "本机写作" },
  ] } }));
  await page.route("**/api/v1/articles/*/writing-proposals", (route) => route.fulfill({ json: {
    outline: null, draft: { markdown: "# 尚未自动保存的初稿", sha256: "before-send-draft", turnId: "before-send", updatedAt: new Date().toISOString() },
  } }));
  let savedText = "";
  await page.route("**/api/v1/articles/*/agent/runs", async (route) => {
    const articleUrl = route.request().url().replace(/\/agent\/runs$/, "");
    savedText = (await (await page.request.get(articleUrl)).json()).markdown;
    await route.fulfill({ json: { id: "completed-run", articleId: articleUrl.split("/").at(-1), profileId: "claude-current", assistantMessageId: "assistant",
      status: "completed", text: "我会先读取试用资料。\n\n# 改写后的文章\n\n这是经过讨论的新正文。", tools: [], permissions: [], seq: 1,
      activity: "已完成", errorCode: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /文章工作台/ }).click();
  await page.getByRole("button", { name: "新建文章" }).click();
  await page.getByRole("button", { name: "审阅正文草稿" }).click();
  await page.getByRole("dialog", { name: "采用智能体正文" }).getByRole("button", { name: "替换正文" }).click();
  await page.getByLabel("向智能体提问").fill("改写这篇文章");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(page.getByRole("log", { name: "文章讨论记录" })).toContainText("改写后的文章");
  expect(savedText).toBe("# 尚未自动保存的初稿");
  await page.getByRole("button", { name: "用作正文" }).click();
  const confirm = page.getByRole("dialog", { name: "采用智能体正文" });
  await expect(confirm).toContainText("这是经过讨论的新正文");
  await expect(confirm).not.toContainText("我会先读取试用资料");
  await confirm.getByRole("button", { name: "替换正文" }).click();
  await expect(page.getByRole("region", { name: "文章正文" })).toContainText("这是经过讨论的新正文。");
  await expect(page.getByRole("log", { name: "文章讨论记录" })).toContainText("我会先读取试用资料");
  await expect(page.getByLabel("文章标题")).toHaveValue("尚未自动保存的初稿");
  await page.getByRole("button", { name: "用作大纲" }).click();
  await page.getByRole("dialog", { name: "采用大纲草案" }).getByRole("button", { name: "采用大纲" }).click();
  await expect(page.getByRole("tab", { name: "大纲", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("region", { name: "文章大纲" })).toContainText("这是经过讨论的新正文。");
});
