import { expect, test } from "@playwright/test";

test("blank articles are created immediately and remain separate across switching and reload", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /文章工作台/ }).click();
  await expect(page.getByLabel("文章列表")).toBeVisible();
  const startingCount = await page.locator(".article-list-item").count();
  await page.getByRole("button", { name: "新建文章" }).click();
  await expect(page.getByLabel("文章标题")).toHaveValue("");
  await expect(page.getByLabel("文章正文")).toHaveValue("");
  await expect(page.getByLabel("文章列表").getByText("新建", { exact: true })).toBeVisible();
  await page.getByLabel("文章正文").fill("# 第一篇\n\n先写内容，标题以后再定。");
  await expect(page.getByRole("status")).toContainText("草稿已保存");
  await expect(page.getByLabel("文章列表").getByText("写作中", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "新建文章" }).click();
  await expect(page.getByLabel("文章正文")).toHaveValue("");
  await expect(page.locator(".article-list-item")).toHaveCount(startingCount + 2);
  await page.locator(".article-list-item").nth(1).click();
  await expect(page.getByLabel("文章正文")).toHaveValue("# 第一篇\n\n先写内容，标题以后再定。");
  await page.reload();
  await page.getByRole("button", { name: /文章工作台/ }).click();
  await expect(page.locator(".article-list-item")).toHaveCount(startingCount + 2);
  await expect(page.getByLabel("文章正文")).toHaveValue("# 第一篇\n\n先写内容，标题以后再定。");
});

test("public metadata is filled after writing and completion appears in the article list", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /文章工作台/ }).click();
  await page.getByRole("button", { name: "新建文章" }).click();
  await page.getByLabel("文章正文").fill("# 初稿\n\n有完整正文。");
  await expect(page.getByRole("status")).toContainText("草稿已保存");
  await page.getByRole("button", { name: "定稿", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("定稿前请填写标题、公开摘要和发布日期");

  await page.getByLabel("文章标题").fill("正式文章");
  await page.locator("summary").filter({ hasText: "发布信息" }).click();
  await page.getByLabel("公开摘要").fill("给读者看的摘要");
  await page.getByLabel("发布日期").fill("2026-10-24");
  await expect(page.getByRole("status")).toContainText("草稿已保存");
  await page.getByRole("button", { name: "定稿", exact: true }).click();
  await expect(page.getByLabel("文章列表").getByText("已完成", { exact: true })).toBeVisible();
});

test("article list and editor stay within mobile and medium viewports", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  await page.getByRole("button", { name: /文章工作台/ }).click();
  await page.getByRole("button", { name: "新建文章" }).click();
  await expect(page.getByLabel("文章正文")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await page.setViewportSize({ width: 1024, height: 768 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1024);
});
