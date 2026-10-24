import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

test("Chinese brand and custom icon persist until restored", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("文脉引擎");
  await expect(page.locator(".brand-copy")).toContainText("文脉引擎");
  await expect(page.locator(".brand-image")).toHaveAttribute("src", "/app-icon-192.png");
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", "/favicon-32x32.png");

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByLabel("替换图标").setInputFiles(fileURLToPath(new URL("../public/favicon-32x32.png", import.meta.url)));
  await page.getByRole("button", { name: "保存图标" }).click();
  await expect(page.getByRole("status")).toContainText("图标已更新");
  await expect(page.locator(".brand-image")).toHaveAttribute("src", /\/api\/v1\/branding\/icon\?v=/);
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", /\/api\/v1\/branding\/icon\?v=/);

  await page.reload();
  await expect(page.locator(".brand-image")).toHaveAttribute("src", /\/api\/v1\/branding\/icon\?v=/);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "恢复默认" }).click();
  await expect(page.locator(".brand-image")).toHaveAttribute("src", "/app-icon-192.png");
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", "/favicon-32x32.png");
});
