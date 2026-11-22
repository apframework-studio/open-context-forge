import { expect, test, type Page } from "@playwright/test";

const clientHeaders = { "x-ocf-client": "1" };

async function createArticle(page: Page, title: string, finalize = false) {
  const created = await page.request.post("/api/v1/articles", { headers: clientHeaders, data: { title } });
  expect(created.ok(), await created.text()).toBe(true);
  const { id, revision } = await created.json();
  if (finalize) {
    const saved = await page.request.put(`/api/v1/articles/${id}/draft`, {
      headers: clientHeaders,
      data: { title, markdown: `# ${title}\n\n这段正文用于确认导出预览有足够的阅读宽度。`, expectedRevision: revision },
    });
    expect(saved.ok(), await saved.text()).toBe(true);
    const completed = await page.request.post(`/api/v1/articles/${id}/finalize`, {
      headers: clientHeaders,
      data: { expectedRevision: (await saved.json()).revision },
    });
    expect(completed.ok(), await completed.text()).toBe(true);
  }
}

test("article titles stay readable beside the expanded sidebar on tablets", async ({ page }) => {
  const title = "Tablet reading layout for long article titles";
  await createArticle(page, title);
  await page.setViewportSize({ width: 768, height: 812 });
  await page.goto("/#articles");
  const titleButton = page.getByRole("button", { name: title, exact: true });
  const row = page.locator(".article-list-item").filter({ has: titleButton });
  const continueWriting = row.getByRole("button", { name: "继续写作" });
  await expect(page.getByRole("button", { name: "收起导航" })).toBeVisible();
  await expect(titleButton).toBeVisible();
  expect((await titleButton.boundingBox())!.width).toBeGreaterThan((await row.boundingBox())!.width * 0.65);
  await expect(continueWriting).toBeInViewport({ ratio: 1 });
  await continueWriting.click();
  await expect(page.getByLabel("文章标题")).toHaveValue(title);
});

test("knowledge search and browse filters fit on tablets", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 812 });
  await page.goto("/");
  await page.getByRole("button", { name: "知识库", exact: true }).click();
  await page.getByRole("tab", { name: "浏览" }).click();
  const search = page.getByLabel("搜索知识库");
  const searchButton = page.getByRole("button", { name: "搜索", exact: true });
  for (const width of [768, 820]) {
    await page.setViewportSize({ width, height: 812 });
    await expect(search).toBeInViewport({ ratio: 1 });
    await expect(searchButton).toBeInViewport({ ratio: 1 });
    expect((await search.boundingBox())!.width).toBeGreaterThan(110);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    for (const filter of ["内容类型", "排序"]) {
      await expect(page.getByRole("combobox", { name: filter })).toBeInViewport({ ratio: 1 });
    }
  }
  await search.fill("tablet layout");
  await searchButton.click();
  await expect(page.locator(".knowledge-list-meta")).toContainText("tablet layout");
});

test("branding upload fits inside the mobile settings panel", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const upload = page.getByLabel("替换图标");
  const preview = page.getByAltText("当前图标预览");
  const panel = page.locator("#appearance-settings");
  await expect(upload).toBeVisible();
  for (const width of [375, 412]) {
    await page.setViewportSize({ width, height: 812 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    const uploadBox = (await upload.boundingBox())!;
    const panelBox = (await panel.boundingBox())!;
    const previewBox = (await preview.boundingBox())!;
    expect(uploadBox.x + uploadBox.width).toBeLessThan(panelBox.x + panelBox.width);
    expect(uploadBox.y).toBeGreaterThan(previewBox.y + previewBox.height);
  }
});

test("mobile writing leaves room for the conversation above the composer", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/#articles");
  await page.getByRole("button", { name: "新建文章", exact: true }).click();
  const conversation = page.getByRole("log", { name: "文章讨论记录" });
  const composer = page.getByLabel("向智能体提问");
  await expect(composer).toBeVisible();
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 812 });
    await expect.poll(async () => (await conversation.boundingBox())?.height ?? 0, { message: `${width}px viewport` }).toBeGreaterThanOrEqual(200);
    await expect(composer).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  }
  await page.getByRole("tab", { name: "文章正文", exact: true }).click();
  await expect(page.getByRole("region", { name: "文章文稿" })).toBeVisible();
  await page.getByRole("tab", { name: "AI 写作", exact: true }).click();
  await expect(conversation).toBeVisible();
});

test("export preview keeps the reading width on tablets and comes first on phones", async ({ page }) => {
  const title = "移动设备的文章导出预览";
  await createArticle(page, title, true);
  await page.setViewportSize({ width: 768, height: 812 });
  await page.goto("/");
  await page.getByRole("button", { name: "导出文章", exact: true }).click();
  await page.getByRole("button", { name: title, exact: true }).click();
  const preview = page.getByRole("region", { name: "导出预览" });
  const images = page.getByRole("complementary", { name: "导出插图" });
  await expect(preview).toContainText(title);
  expect((await preview.boundingBox())!.width).toBeGreaterThan(340);
  for (const width of [768, 375]) {
    await page.setViewportSize({ width, height: 812 });
    const previewBox = (await preview.boundingBox())!;
    expect((await images.boundingBox())!.y).toBeGreaterThanOrEqual(previewBox.y + previewBox.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  }
  await images.getByRole("button", { name: "管理图片" }).click();
  await expect(page.getByRole("button", { name: "图片素材", exact: true })).toHaveAttribute("aria-pressed", "true");
});
