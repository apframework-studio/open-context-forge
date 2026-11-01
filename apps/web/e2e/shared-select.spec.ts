import { expect, test } from "@playwright/test";

test("knowledge, settings and article selectors share the accessible styled menu", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "知识库", exact: true }).click();
  const vault = page.getByRole("combobox", { name: "选择知识库" });
  await vault.click();
  await expect(page.getByRole("listbox", { name: "选择知识库选项" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "浏览" }).click();
  await page.getByRole("combobox", { name: "内容类型" }).click();
  await expect(page.getByRole("listbox", { name: "内容类型选项" })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "设置", exact: true }).click();
  const capture = page.getByRole("combobox", { name: "采集后如何处理" });
  await capture.click();
  await expect(page.getByRole("listbox", { name: "采集后如何处理选项" })).toBeVisible();
  await page.getByRole("option", { name: "自动直接入库" }).click();
  const target = page.getByRole("combobox", { name: "自动入库目标" });
  await target.click();
  await expect(page.getByRole("listbox", { name: "自动入库目标选项" })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: /文章工作台/ }).click();
  await page.getByRole("combobox", { name: "文章状态" }).click();
  await expect(page.getByRole("listbox", { name: "文章状态选项" })).toBeVisible();
});
