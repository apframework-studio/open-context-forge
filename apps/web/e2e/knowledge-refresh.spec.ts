import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test as base, type Page } from "@playwright/test";

const test = base.extend<{ refreshVault: { id: string; path: string } }>({
  refreshVault: async ({ page }, use) => {
    const path = mkdtempSync(join(tmpdir(), "ocf-knowledge-refresh-"));
    const id = `refresh-${Date.now().toString(36)}`;
    for (let index = 0; index < 48; index++) {
      writeFileSync(join(path, `Note-${String(index).padStart(2, "0")}.md`),
        `# Reading material ${index}\n\n${"Keep the current reading position while checking for updates.\n\n".repeat(90)}`);
    }
    const connected = await page.request.post("/api/v1/vaults", {
      headers: { "x-ocf-client": "1" }, data: { id, path, adopt: true },
    });
    expect(connected.status()).toBe(201);
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto("/");
      await page.getByRole("button", { name: "知识库", exact: true }).click();
      await page.getByRole("combobox", { name: "选择知识库" }).click();
      await page.getByRole("option", { name: id, exact: true }).click();
      await page.getByRole("tab", { name: "浏览", exact: true }).click();
      await expect(page.locator(".knowledge-item")).toHaveCount(30);
      await use({ id, path });
    } finally {
      await page.request.delete(`/api/v1/vaults/${id}`, { headers: { "x-ocf-client": "1" } });
      rmSync(path, { recursive: true, force: true });
    }
  },
});

async function beginReading(page: Page) {
  await page.locator(".knowledge-item").first().click();
  await expect(page.locator(".knowledge-markdown")).toContainText("Keep the current reading position");
  await page.locator(".knowledge-item-list").evaluate((element) => { element.scrollTop = 450; });
  await page.getByLabel("内容详情", { exact: true }).evaluate((element) => { element.scrollTop = 380; });
}

async function expectReadingPosition(page: Page) {
  await expect.poll(() => page.locator(".knowledge-item-list").evaluate((element) => element.scrollTop)).toBe(450);
  await expect.poll(() => page.getByLabel("内容详情", { exact: true }).evaluate((element) => element.scrollTop)).toBe(380);
}

async function rescan(page: Page) {
  await page.getByRole("button", { name: "更多操作", exact: true }).click();
  await page.getByRole("button", { name: "重新索引", exact: true }).click();
}

test("automatic refresh keeps existing rows, selection, pagination and both scroll positions", async ({ page, refreshVault }) => {
  test.setTimeout(40_000);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.locator(".knowledge-item")).toHaveCount(18);
  await beginReading(page);
  const selected = await page.locator(".knowledge-item.active").elementHandle();
  let release!: () => void;
  const heldResponse = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/v1/knowledge/items?*", async (route) => {
    const response = await route.fetch();
    await heldResponse;
    await route.fulfill({ response });
  });
  try {
    const pending = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/v1/knowledge/items", { timeout: 15_000 });
    await pending;
    await expect(page.locator(".knowledge-item")).toHaveCount(18);
    await expect(page.locator(".knowledge-results .source-pagination")).toContainText("第 2 / 2 页");
    await expectReadingPosition(page);
    const finished = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/knowledge/items");
    release();
    await finished;
    await expect(page.locator(".knowledge-item.active")).toHaveCount(1);
    await expect(page.locator(".knowledge-results .source-pagination")).toContainText("第 2 / 2 页");
    expect(await selected!.evaluate((element) => element.isConnected)).toBe(true);
    await expectReadingPosition(page);
  } finally { release(); }
});

test("newly indexed notes merge without resetting the current reading position", async ({ page, refreshVault }) => {
  await beginReading(page);
  const selected = await page.locator(".knowledge-item.active").elementHandle();
  const readerTitle = await page.locator(".knowledge-detail-header h2").innerText();
  writeFileSync(join(refreshVault.path, "New.md"), "# New arrival\n\nNewly indexed material.\n");
  await rescan(page);
  await expect(page.locator(".knowledge-results-top")).toContainText("49 项");
  await expect(page.locator(".knowledge-item").first()).toContainText("New arrival");
  await expect(page.locator(".knowledge-detail-header h2")).toHaveText(readerTitle);
  expect(await selected!.evaluate((element) => element.isConnected)).toBe(true);
  await expectReadingPosition(page);
});

test("failed background requests retain the list, directory and reading position", async ({ page, refreshVault }) => {
  await beginReading(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/v1/knowledge/items?*", (route) => route.fulfill({ status: 503, json: { error: "TEMPORARILY_UNAVAILABLE" } }));
  await page.route("**/api/v1/knowledge/folders?*", (route) => route.fulfill({ status: 503, json: { error: "TEMPORARILY_UNAVAILABLE" } }));
  const failedList = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/knowledge/items");
  const failedFolders = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/knowledge/folders");
  await rescan(page);
  await Promise.all([failedList, failedFolders]);
  await expect(page.locator(".knowledge-item")).toHaveCount(30);
  await expect(page.getByRole("button", { name: `${refreshVault.id} / 根目录`, exact: true })).toBeVisible();
  await expect(page.getByText("内容读取中…", { exact: true })).toBeHidden();
  await expectReadingPosition(page);
  expect(errors).toEqual([]);
});

test("a delayed background response cannot overwrite a newer search", async ({ page, refreshVault }) => {
  await beginReading(page);
  let release!: () => void;
  const heldResponse = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/v1/knowledge/items?*", async (route) => {
    const response = await route.fetch();
    if (!new URL(route.request().url()).searchParams.has("q")) {
      await heldResponse;
      await route.fulfill({ response });
    } else await route.fulfill({ response });
  });
  try {
    const pending = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/v1/knowledge/items");
    await rescan(page);
    await pending;
    await page.getByLabel("搜索知识库", { exact: true }).fill("Reading material 17");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await expect(page.locator(".knowledge-item")).toHaveCount(1);
    await expect(page.locator(".knowledge-item")).toContainText("Reading material 17");
    const oldResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/api/v1/knowledge/items" && !url.searchParams.has("q");
    });
    release();
    await (await oldResponse).finished();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await expect(page.locator(".knowledge-item")).toHaveCount(1);
  } finally { release(); }
});
