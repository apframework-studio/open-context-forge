import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

test("the settings entry uses the same rounded navigation icon at both sidebar widths", async ({ page }) => {
  await page.goto("/");
  const settings = page.getByRole("button", { name: "设置", exact: true });
  const settingsIcon = settings.locator("svg");
  await expect(settingsIcon).toBeVisible({ timeout: 2000 });
  const articleIcon = page.getByRole("button", { name: "文章工作台", exact: true }).locator("svg");
  for (const attribute of ["width", "height", "stroke-width", "stroke-linecap", "stroke-linejoin"]) {
    await expect(settingsIcon).toHaveAttribute(attribute, (await articleIcon.getAttribute(attribute))!);
  }
  await page.getByRole("button", { name: "收起导航" }).click();
  await expect(settingsIcon).toBeVisible();
  await settings.click();
  await expect(page.getByRole("heading", { name: "外观", exact: true })).toBeVisible();
});

test("Chinese brand and custom icon persist until restored", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("文脉引擎");
  await expect(page.locator(".brand-copy")).toContainText("文脉引擎");
  await expect(page.locator(".brand-image")).toHaveAttribute("src", "/app-icon-192.png?v=2");
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", "/favicon-32x32.png?v=2");
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("href", "/apple-touch-icon.png?v=2");

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByLabel("替换图标").setInputFiles(fileURLToPath(new URL("../public/favicon-32x32.png", import.meta.url)));
  await page.getByRole("button", { name: "保存图标" }).click();
  await expect(page.getByRole("status")).toContainText("图标已更新");
  await expect(page.locator(".brand-image")).toHaveAttribute("src", /\/api\/v1\/branding\/icon\?v=/);
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", /\/api\/v1\/branding\/icon\?v=/);
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("href", /\/api\/v1\/branding\/icon\?v=/);

  await page.reload();
  await expect(page.locator(".brand-image")).toHaveAttribute("src", /\/api\/v1\/branding\/icon\?v=/);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "恢复默认" }).click();
  await expect(page.locator(".brand-image")).toHaveAttribute("src", "/app-icon-192.png?v=2");
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", "/favicon-32x32.png?v=2");
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("href", "/apple-touch-icon.png?v=2");
});
