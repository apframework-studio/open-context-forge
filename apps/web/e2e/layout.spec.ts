import { expect, test } from "@playwright/test";

test("workspace navigation renders with its bundled Chinese font", async ({ page }) => {
  await page.goto("/");
  const label = page.getByRole("button", { name: "资料与分析", exact: true }).locator(".nav-text");
  await expect(label).toHaveCSS("font-family", /^"Source Han Sans CN"/, { timeout: 2000 });
  const loaded = await label.evaluate(async (element) => {
    const style = getComputedStyle(element);
    const faces = await document.fonts.load(`${style.fontWeight} ${style.fontSize} ${style.fontFamily}`, element.textContent ?? "");
    return faces.some((face) => face.family.replaceAll('"', "") === "Source Han Sans CN" && face.status === "loaded");
  });
  expect(loaded).toBe(true);
});

test("primary screens and writing controls stay on the four-size typography scale", async ({ page }) => {
  async function checkTypography(view: string) {
    const unexpected = await page.evaluate(() => {
      const allowed = new Set(["12px", "14px", "16px", "24px", "0px"]);
      const result = new Map<string, string>();
      for (const element of document.querySelectorAll<HTMLElement>("#root *")) {
        if (!(element instanceof HTMLElement) || element.closest(".sr-only, .article-export-paper") ||
          !element.checkVisibility({ opacityProperty: true, visibilityProperty: true }) || !element.getBoundingClientRect().width) continue;
        if (element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type)) continue;
        const label = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
          ? element.placeholder || element.value
          : Array.from(element.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join("").trim();
        const size = getComputedStyle(element).fontSize;
        if (label && !allowed.has(size) && !result.has(size)) result.set(size, label.slice(0, 32));
      }
      return Array.from(result);
    });
    expect(unexpected, view).toEqual([]);
  }

  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "资料与分析" })).toBeVisible();
  await checkTypography("资料与分析");
  await page.getByRole("button", { name: "导入资料", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "导入资料" })).toBeVisible();
  await checkTypography("导入资料");
  await page.keyboard.press("Escape");

  for (const name of ["知识库", "设置", "导出文章", "文章工作台"]) {
    await page.getByRole("button", { name, exact: true }).click();
    await checkTypography(name);
  }
  await page.getByRole("button", { name: "新建文章", exact: true }).click();
  await expect(page.getByLabel("向智能体提问")).toBeVisible();
  await expect(page.getByLabel("向智能体提问")).toHaveCSS("font-size", "16px");
  await checkTypography("协作写作");
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.getByLabel("向智能体提问")).toHaveCSS("font-size", "16px");
  await checkTypography("手机协作写作");
});

test("workspace theme defaults to light and keeps a dark choice across pages and reloads", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  const themes = page.getByRole("group", { name: "界面配色" });
  const light = themes.getByRole("button", { name: "浅色" });
  const dark = themes.getByRole("button", { name: "深色" });
  await expect(light).toHaveAttribute("aria-pressed", "true", { timeout: 2000 });
  await expect(page.locator("html")).toHaveCSS("color-scheme", "light");
  const workspace = page.locator(".workspace");
  await expect(workspace).toHaveCSS("background-image", /linear-gradient/);
  await expect(workspace).toHaveCSS("background-color", "rgb(243, 246, 252)");
  await expect(page.locator(".topbar")).toHaveCSS("box-shadow", "none");
  const lightSurface = await workspace.evaluate((element) => getComputedStyle(element).backgroundColor);

  await dark.press("Enter");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  await expect(workspace).not.toHaveCSS("background-color", lightSurface);
  await expect(workspace).toHaveCSS("background-image", /linear-gradient/);
  await page.getByRole("button", { name: "文章工作台", exact: true }).click();
  await expect(page).toHaveURL(/#articles/);
  await page.reload();
  await expect(dark).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
  await light.click();
  await expect(workspace).toHaveCSS("background-color", lightSurface);
});

test("long article titles leave room for controls and the visible writing panes", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  await page.getByRole("button", { name: "文章工作台", exact: true }).click();
  await page.getByRole("button", { name: "新建文章", exact: true }).click();
  const title = page.getByLabel("文章标题", { exact: true });
  const longTitle = "在保留完整上下文的同时阅读及编辑一篇很长的文章".repeat(3);
  await title.fill(longTitle);
  await expect(title).toHaveValue(longTitle);
  const manuscript = page.getByRole("region", { name: "文章文稿" });
  const conversation = page.getByLabel("当前文章对话");
  const layout = page.locator(".article-writing-layout");

  for (const width of [375, 768]) {
    await page.setViewportSize({ width, height: 812 });
    await expect(page.getByRole("button", { name: "阅读文章", exact: true })).toBeInViewport();
    await expect(page.getByRole("button", { name: "文章信息", exact: true })).toBeInViewport();
    await page.getByRole("tab", { name: "文章正文", exact: true }).click();
    await expect(manuscript).toBeVisible();
    await expect.poll(async () => (await manuscript.boundingBox())!.width).toBeGreaterThan((await layout.boundingBox())!.width - 5);
    await expect(conversation).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  }

  await page.setViewportSize({ width: 1280, height: 812 });
  await expect(manuscript).toBeVisible();
  await expect(conversation).toBeVisible();
  expect((await manuscript.boundingBox())!.width).toBeGreaterThan(450);
  expect((await conversation.boundingBox())!.width).toBeGreaterThan(450);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1280);
});

test("desktop navigation does not move or pass wheel motion to the page", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.goto("/");
  await page.evaluate(() => { document.querySelector<HTMLElement>(".page")!.style.minHeight = "2400px"; });
  const sidebar = page.locator(".sidebar");

  await page.mouse.move(100, 300);
  await page.mouse.wheel(0, 700);
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect((await sidebar.boundingBox())!.y).toBe(0);

  await page.mouse.move(600, 300);
  await page.mouse.wheel(0, 700);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  expect((await sidebar.boundingBox())!.y).toBe(0);
});

test("workspace header stays fixed above scrolling content across sidebar widths", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.goto("/");
  await page.evaluate(() => { document.querySelector<HTMLElement>(".page")!.style.minHeight = "2400px"; });

  const header = page.locator(".topbar");
  const sidebar = page.locator(".sidebar");
  await expect(header).toHaveCSS("position", "fixed");
  await page.mouse.move(600, 300);
  await page.mouse.wheel(0, 600);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  expect((await header.boundingBox())!.y).toBe(0);
  await expect.poll(async () => (await header.boundingBox())!.x).toBe((await sidebar.boundingBox())!.width);

  await page.getByRole("button", { name: "收起导航" }).click();
  await expect.poll(async () => (await header.boundingBox())!.x).toBe((await sidebar.boundingBox())!.width);
  expect((await header.boundingBox())!.y).toBe(0);

  await page.getByRole("button", { name: "展开导航" }).click();
  await page.setViewportSize({ width: 936, height: 800 });
  await expect.poll(async () => (await header.boundingBox())!.x).toBe((await sidebar.boundingBox())!.width);
  expect((await header.boundingBox())!.y).toBe(0);

  await page.setViewportSize({ width: 375, height: 812 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expect(header).toHaveCSS("position", "fixed");
  expect((await header.boundingBox())!.y).toBe(0);
  await expect.poll(async () => (await sidebar.boundingBox())!.y).toBe((await header.boundingBox())!.height);
});

test("mobile navigation keeps its full width when desktop collapse was saved", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.addInitScript(() => localStorage.setItem("ocf-nav-collapsed", "1"));
  await page.goto("/");
  expect((await page.locator(".sidebar").boundingBox())!.width).toBe(375);
  await expect(page.getByRole("button", { name: "知识库", exact: true })).toBeVisible();
});

test("navigation remembers its layout and non-writing pages have no conversation", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.goto("/");

  const sidebar = page.locator(".sidebar");
  const workspace = page.locator(".workspace");
  const initialWorkspaceWidth = (await workspace.boundingBox())!.width;
  expect(initialWorkspaceWidth).toBeGreaterThan(1100);
  await expect(page.getByRole("button", { name: /智能体协作/ })).toHaveCount(0);
  await expect(page.getByLabel("向智能体提问")).toHaveCount(0);

  await page.getByRole("button", { name: "收起导航" }).click();
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeLessThan(100);
  await expect(page.getByRole("button", { name: "知识库", exact: true })).toBeVisible();
  await expect.poll(async () => (await workspace.boundingBox())!.width).toBeGreaterThan(initialWorkspaceWidth);

  await page.reload();
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeLessThan(100);
  for (const name of ["知识库", "设置", "导出文章"]) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.getByLabel("向智能体提问")).toHaveCount(0);
  }
  await page.getByRole("button", { name: "展开导航" }).click();
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeGreaterThan(200);
});
