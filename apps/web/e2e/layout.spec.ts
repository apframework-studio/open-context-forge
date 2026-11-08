import { expect, test } from "@playwright/test";

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
  for (const name of ["知识库", "设置", "发布中心"]) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.getByLabel("向智能体提问")).toHaveCount(0);
  }
  await page.getByRole("button", { name: "展开导航" }).click();
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeGreaterThan(200);
});
