import { expect, test } from "@playwright/test";

test("attention popover closes when focus leaves or the user clicks elsewhere", async ({ page }) => {
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "待处理事项" });
  const panel = page.getByRole("region", { name: "待处理事项" });
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
