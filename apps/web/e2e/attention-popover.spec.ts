import { expect, test } from "@playwright/test";

test("attention popover closes when focus leaves or the user clicks elsewhere", async ({ page }) => {
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "需处理事项" });
  const panel = page.getByRole("region", { name: "需处理事项" });
  await trigger.click();
  await expect(panel).toBeVisible();
  await panel.getByText("目前没有需要处理的任务。").click();
  await expect(panel).toBeVisible();
  await page.getByRole("button", { name: "知识库", exact: true }).focus();
  await expect(panel).toBeHidden();
  await trigger.click();
  await expect(panel).toBeVisible();
  await page.getByRole("button", { name: "知识库", exact: true }).click();
  await expect(panel).toBeHidden();
  await trigger.click();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
});

test("navigation glass works in both themes with an opaque accessibility fallback", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference", contrast: "no-preference" });
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/");

  const header = page.locator(".topbar");
  const selected = page.getByRole("button", { name: "资料与分析", exact: true });
  const trigger = page.getByRole("button", { name: "需处理事项" });
  const panel = page.getByRole("region", { name: "需处理事项" });
  await expect(header).toHaveCSS("backdrop-filter", /blur\(/);
  await expect(selected).toHaveAttribute("aria-current", "page");
  await expect(selected).toHaveCSS("background-image", /linear-gradient/);
  await page.locator(".page").evaluate((element) => { (element as HTMLElement).style.minHeight = "2400px"; });
  await page.evaluate(() => window.scrollTo(0, 400));
  await trigger.click();
  await expect(panel).toBeInViewport();
  await expect(panel).toHaveCSS("backdrop-filter", /blur\(/);

  await page.getByRole("button", { name: "深色", exact: true }).click();
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  await page.setViewportSize({ width: 375, height: 812 });
  await trigger.click();
  await expect(panel).toBeInViewport();
  await expect(header).toHaveCSS("backdrop-filter", /blur\(/);
  await expect(panel).toHaveCSS("backdrop-filter", /blur\(/);
  const panelBox = (await panel.boundingBox())!;
  expect(panelBox.x).toBeGreaterThanOrEqual(0);
  expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(375);

  await page.emulateMedia({ reducedMotion: "reduce", contrast: "more" });
  await expect(header).toHaveCSS("backdrop-filter", "none");
  await expect(panel).toHaveCSS("backdrop-filter", "none");
  await expect(panel).toHaveCSS("animation-name", "none");
  await expect(selected).toHaveCSS("background-image", "none");
});
