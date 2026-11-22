import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { fixtureZipFor } from "./fixtures";

test.beforeEach(async ({ request }) => {
  const port = process.env.OCF_E2E_SERVER_PORT;
  const response = await request.put(`http://127.0.0.1:${port}/api/v1/imports/policy`, {
    headers: { "x-ocf-client": "1" }, data: { mode: "manual" },
  });
  expect(response.ok()).toBe(true);
});

test("source row shows compact origin, opens body, and adds vault membership", async ({ page }) => {
  const id = `multi-ui-${randomUUID().slice(0, 8)}`;
  const title = `多库资料 ${id}`;
  await page.goto("/");
  await page.getByRole("button", { name: "导入资料" }).click();
  await page.getByLabel("选择文件").setInputFiles({ name: "source.zip", mimeType: "application/zip",
    buffer: fixtureZipFor(id, title) });
  const row = page.locator(".source-row").filter({ hasText: title });
  await expect(row.getByRole("link", { name: "原文链接" })).toHaveAttribute("href", `https://example.org/${id}`);
  await expect(row.locator(".source-origin span")).toHaveText("example.org");
  await expect(row.locator(".source-analysis-state")).toHaveClass(/tag/);
  await expect(row.getByRole("button", { name: "生成智能摘要" })).toBeVisible();
  await row.getByRole("button", { name: title }).click();
  await expect(row.getByRole("region", { name: `${title} 资料正文` })).toContainText(title);
  await expect(row.getByText("查看资料正文")).toHaveCount(0);
  await expect(row.getByLabel(`入库目标 ${title}`)).toHaveCount(0);
  await row.getByRole("button", { name: "入库" }).click();
  const dialog = page.getByRole("dialog", { name: "添加到知识库" });
  const defaultVault = dialog.getByRole("checkbox", { name: /default/ });
  await expect(defaultVault).toBeVisible();
  await defaultVault.check();
  await dialog.getByRole("button", { name: "确认入库" }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("tab", { name: /全部资料/ }).click();
  const filed = page.locator(".source-row").filter({ hasText: title });
  await expect(filed.locator(".tag.success")).toContainText("已入库");
  await filed.getByRole("button", { name: "添加到知识库" }).click();
  const filedDialog = page.getByRole("dialog", { name: "添加到知识库" });
  await expect(filedDialog.getByRole("checkbox", { name: /default/ })).toBeChecked();
  await expect(filedDialog.getByRole("checkbox", { name: /default/ })).toBeDisabled();
  await expect(filedDialog).toContainText("后续删除将在知识库中统一处理文件和索引");
  await expect(filedDialog.getByRole("button", { name: "确认入库" })).toBeDisabled();
});

test("analysis remains a background job and its completed card reappears after navigation", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  let analyzedEver = false;
  let submissions = 0;
  let job: { id: string; batchId: string; captureId: string; status: string; errorCode: string | null;
    createdAt: string; updatedAt: string } | null = null;
  await page.route("**/api/v1/analysis/jobs", async (route) => {
    if (route.request().method() === "POST") {
      submissions++;
      const item = JSON.parse(route.request().postData() ?? "{}").items[0];
      job = { id: "test-job", ...item, status: "queued", errorCode: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ jobs: [job] }) });
    } else {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobs: job ? [job] : [] }) });
    }
  });
  await page.route("**/api/v1/imports/items?*", async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    if (analyzedEver) {
      payload.items = payload.items.map((item: { captureId: string }) =>
        item.captureId === job?.captureId ? { ...item, analysisStatus: "proposed" } : item);
    }
    await route.fulfill({ response, body: JSON.stringify(payload) });
  });
  await page.route("**/api/v1/imports/*/items/*/analysis", async (route) => {
    if (submissions > 1 && job?.status !== "completed") {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "TEMPORARY" }) });
      return;
    }
    if (!analyzedEver) { await route.continue(); return; }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      vaultId: "", snapshot: `inbox/${job.batchId}/${job.captureId}`, fingerprint: "test-fingerprint",
      status: "proposed", authorship: "third_party", author: null,
      summary: submissions > 2 ? "再次分析后的摘要" : "后台分析完成的摘要", mainPoints: [{ claim: "有证据的主张", kind: "article_statement",
        evidence: [{ startLine: 1, endLine: 1, excerpt: "原文" }] }],
      limitations: [], recommendation: "defer", reason: "待核对",
    }) });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "导入资料" }).click();
  await page.getByLabel("选择文件").setInputFiles({ name: "clipper.zip", mimeType: "application/zip",
    buffer: fixtureZipFor("background-analysis", "后台分析资料") });
  const analyzedRow = page.locator(".source-row").filter({ hasText: "后台分析资料" });
  await analyzedRow.getByRole("button", { name: "后台分析资料" }).click();
  await analyzedRow.getByRole("button", { name: "生成智能摘要" }).click();
  await expect(page.locator(".source-row").filter({ hasText: "后台分析资料" }).locator(".source-analysis-state")).toHaveText("生成中");
  await page.getByRole("button", { name: "知识库", exact: true }).click();
  await page.getByRole("button", { name: /资料与分析/ }).click();
  await expect(page.locator(".source-row").filter({ hasText: "后台分析资料" }).locator(".source-analysis-state")).toHaveText("生成中");
  job!.status = "completed";
  analyzedEver = true;
  const card = page.getByLabel("后台分析资料 智能摘要");
  await expect(card).toContainText("后台分析完成的摘要", { timeout: 7000 });
  await expect(page.locator(".source-row").filter({ hasText: "后台分析资料" }).locator(".source-analysis-state")).toHaveText("已生成");
  const detail = page.locator(".source-row").filter({ hasText: "后台分析资料" }).locator(".source-detail");
  const original = detail.getByRole("region", { name: "后台分析资料 资料正文" });
  const originalBox = await original.boundingBox();
  const cardBox = await card.boundingBox();
  expect(originalBox).not.toBeNull();
  expect(cardBox).not.toBeNull();
  expect(originalBox!.x + originalBox!.width).toBeLessThanOrEqual(cardBox!.x + 2);
  expect(originalBox!.width).toBeGreaterThan(cardBox!.width);
  await page.setViewportSize({ width: 900, height: 900 });
  await expect(detail.getByRole("tab", { name: "资料正文" })).toBeVisible();
  await detail.getByRole("tab", { name: "智能摘要" }).click();
  await expect(original).toBeHidden();
  await expect(card).toBeVisible();
  await detail.getByRole("tab", { name: "资料正文" }).click();
  await expect(original).toBeVisible();
  await expect(card).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(card.getByRole("button", { name: "确认智能摘要" })).toHaveCount(0);
  await card.getByRole("button", { name: "重新分析" }).click();
  await expect(card).toContainText("后台分析完成的摘要");
  job!.status = "failed"; job!.errorCode = "UNEXPECTED_ERROR";
  await expect(page.locator(".source-row").filter({ hasText: "后台分析资料" }).getByText(/分析任务失败/)).toBeVisible({ timeout: 7000 });
  await expect(card).toContainText("后台分析完成的摘要", { timeout: 7000 });
  await card.getByRole("button", { name: "重新分析" }).click();
  job!.status = "completed"; job!.errorCode = null;
  await expect(card).toContainText("再次分析后的摘要", { timeout: 7000 });
});

test("source workbench keeps a cross-batch pending list and allows shelving", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("region", { name: "资料列表" })).toBeVisible();
  await page.getByRole("button", { name: "导入资料" }).click();
  await page.getByLabel("选择文件").setInputFiles({ name: "clipper.zip", mimeType: "application/zip", buffer: fixtureZipFor("capture-workbench", "工作台资料") });
  await expect(page.getByRole("tab", { name: /待整理/ })).toBeVisible();
  await expect(page.getByText("工作台资料")).toBeVisible();
  await page.locator(".source-row").filter({ hasText: "工作台资料" }).getByRole("button", { name: "搁置" }).click();
  await expect(page.getByText("工作台资料")).toHaveCount(0);
  await page.getByRole("tab", { name: /全部资料/ }).click();
  await expect(page.getByText("工作台资料")).toBeVisible();
});

test("the empty pending view leads to existing sources without showing unused table controls", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.route("**/api/v1/imports/items?view=pending&*", (route) => route.fulfill({
    json: { total: 0, page: 1, pageSize: 20, counts: { all: 1, pending: 0, recent: 1, trash: 0, autoQueued: 0 }, items: [] },
  }));
  await page.goto("/");
  const board = page.getByRole("region", { name: "资料列表" });
  await expect(page.getByRole("heading", { name: "资料与分析" })).toBeVisible();
  await expect(board.getByRole("heading", { name: "没有待整理的资料" })).toBeVisible();
  await expect(board.getByRole("textbox", { name: "搜索资料" })).toHaveCount(0);
  await expect(board.getByRole("checkbox", { name: "选择当前页" })).toHaveCount(0);
  await expect(board.getByRole("button", { name: "下一页" })).toHaveCount(0);
  expect((await board.boundingBox())!.height).toBeLessThan(360);
  await board.getByRole("button", { name: "查看全部资料" }).click();
  await expect(board.getByRole("tab", { name: /全部资料/ })).toHaveAttribute("aria-selected", "true");
});

test("source workbench keeps the compact controls inside a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "导入资料" })).toBeVisible();
  await expect(page.getByRole("tab", { name: /待整理/ })).toBeVisible();
  await expect(page.getByRole("region", { name: "资料列表" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});

test("source selection stays with batch actions while the footer only pages", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "导入资料" }).click();
  await page.getByLabel("选择文件").setInputFiles([
    { name: "first.zip", mimeType: "application/zip", buffer: fixtureZipFor("select-first", "批选验证-第一篇资料") },
    { name: "second.zip", mimeType: "application/zip", buffer: fixtureZipFor("select-second", "批选验证-第二篇资料") },
  ]);
  await expect(page.locator(".intake-toolbar [role='status']")).toContainText("已导入 2 篇");
  const board = page.getByRole("region", { name: "资料列表" });
  await board.getByRole("textbox", { name: "搜索资料" }).fill("批选验证-");
  await board.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(board.getByText("批选验证-第一篇资料")).toBeVisible();
  await expect(board.getByText("批选验证-第二篇资料")).toBeVisible();
  const footer = board.locator(".source-pagination");
  await expect(footer.getByRole("button", { name: /选择当前页|取消当前页|选择全部筛选结果/ })).toHaveCount(0);

  await board.getByRole("checkbox", { name: "选择 批选验证-第一篇资料" }).check();
  const toolbar = page.getByRole("toolbar", { name: "批量资料操作" });
  await expect(toolbar.getByRole("button", { name: /选择全部筛选结果/ })).toBeVisible();
  await toolbar.getByRole("button", { name: /选择全部筛选结果/ }).click();
  await expect(toolbar).toContainText("已选择 2 篇");
  await expect(toolbar.getByRole("button", { name: /选择全部筛选结果/ })).toHaveCount(0);

  await page.setViewportSize({ width: 375, height: 812 });
  await expect(board.getByRole("checkbox", { name: "选择当前页" })).toBeVisible();
});

test("selecting a source does not move the list, filters, or pagination", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "导入资料" }).click();
  await page.getByLabel("选择文件").setInputFiles({ name: "row.zip", mimeType: "application/zip",
    buffer: fixtureZipFor("stable-selection", "固定批量操作验证资料") });
  const row = page.locator(".source-row").filter({ hasText: "固定批量操作验证资料" });
  const filters = page.locator(".source-filters");
  const footer = page.getByRole("region", { name: "资料列表" }).locator(".source-pagination");
  const before = { row: (await row.boundingBox())!.y, filters: (await filters.boundingBox())!.y,
    footer: (await footer.boundingBox())!.y };
  await row.getByRole("checkbox", { name: "选择 固定批量操作验证资料" }).check();
  const toolbar = page.getByRole("toolbar", { name: "批量资料操作" });
  await expect(toolbar).toBeVisible();
  expect(Math.abs((await row.boundingBox())!.y - before.row)).toBeLessThanOrEqual(1);
  expect(Math.abs((await filters.boundingBox())!.y - before.filters)).toBeLessThanOrEqual(1);
  expect(Math.abs((await footer.boundingBox())!.y - before.footer)).toBeLessThanOrEqual(1);
  const barBox = (await toolbar.boundingBox())!;
  const footerBox = (await footer.boundingBox())!;
  expect(barBox.y + barBox.height).toBeLessThanOrEqual(footerBox.y);
  await page.setViewportSize({ width: 375, height: 812 });
  const mobileBar = (await toolbar.boundingBox())!;
  expect(mobileBar.x).toBeGreaterThanOrEqual(0);
  expect(mobileBar.x + mobileBar.width).toBeLessThanOrEqual(375);
});

test("selecting several sources preserves list and row geometry", async ({ page }) => {
  const runId = randomUUID().slice(0, 8);
  await page.setViewportSize({ width: 1440, height: 650 });
  await page.goto("/");
  await page.getByRole("button", { name: "导入资料" }).click();
  await page.getByLabel("选择文件").setInputFiles(Array.from({ length: 4 }, (_, index) => ({
    name: `width-${runId}-${index}.zip`, mimeType: "application/zip",
    buffer: fixtureZipFor(`width-${runId}-${index}`, `宽度变化诊断资料 ${runId}-${index}：从工程师到全员，从个体到组织，关于企业生产力实践的长标题`),
  })));
  await expect(page.locator(".intake-toolbar [role='status']")).toContainText("已导入 4 篇");
  const board = page.getByRole("region", { name: "资料列表" });
  await board.getByRole("textbox", { name: "搜索资料" }).fill(runId);
  await board.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(board.locator(".source-row")).toHaveCount(4);
  const measure = () => page.evaluate(() => {
    const selectors = [".source-list-panel", ".source-list-head", ".source-rows", ".source-row",
      ".source-row-main", ".source-name", ".source-title"];
    return Object.fromEntries(selectors.map((selector) => {
      const rect = document.querySelector(selector)!.getBoundingClientRect();
      return [selector, { x: rect.x, y: rect.y, width: rect.width, height: rect.height }];
    }));
  });
  const before = await measure();
  await board.getByRole("checkbox", { name: "选择当前页" }).check();
  const after = await measure();
  for (const selector of Object.keys(before)) {
    for (const dimension of ["x", "y", "width", "height"] as const) {
      expect(Math.abs(after[selector][dimension] - before[selector][dimension]), `${selector} ${dimension}`).toBeLessThanOrEqual(1);
    }
  }
});

test("source rows expand from noninteractive space while checkboxes have a generous target", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "导入资料" }).click();
  await page.getByLabel("选择文件").setInputFiles({ name: "row.zip", mimeType: "application/zip",
    buffer: fixtureZipFor("row-hit-target", "点击区域验证资料") });
  const row = page.locator(".source-row").filter({ hasText: "点击区域验证资料" });
  const checkbox = row.getByRole("checkbox", { name: "选择 点击区域验证资料" });
  const hitTarget = checkbox.locator("xpath=..");
  expect((await hitTarget.boundingBox())!.width).toBeGreaterThanOrEqual(36);
  expect((await hitTarget.boundingBox())!.height).toBeGreaterThanOrEqual(36);
  await hitTarget.click({ position: { x: 3, y: 3 } });
  await expect(checkbox).toBeChecked();
  await expect(row.locator(".source-detail")).toHaveCount(0);
  await row.locator("time").click();
  await expect(row.locator(".source-detail")).toBeVisible();
  await row.locator(".source-row-main").click({ position: { x: 300, y: 4 } });
  await expect(row.locator(".source-detail")).toHaveCount(0);
});

test("source tabs have larger targets and pagination remains at the bottom when a row expands", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "导入资料" }).click();
  await page.getByLabel("选择文件").setInputFiles({ name: "row.zip", mimeType: "application/zip",
    buffer: fixtureZipFor("fixed-pagination", "固定分页验证资料") });
  const board = page.getByRole("region", { name: "资料列表" });
  const tab = board.getByRole("tab", { name: /全部资料/ });
  expect((await tab.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  const boardBox = (await board.boundingBox())!;
  const tabBox = (await board.getByRole("tab", { name: /待整理/ }).boundingBox())!;
  expect(tabBox.x - boardBox.x).toBeLessThanOrEqual(16);
  const footer = board.locator(".source-pagination");
  const before = (await footer.boundingBox())!;
  expect(before.y + before.height).toBeGreaterThanOrEqual(760);
  await board.getByRole("button", { name: "固定分页验证资料" }).click();
  const after = (await footer.boundingBox())!;
  expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
  await expect(footer).toBeVisible();
});

test("source search stays compact beside filters on desktop", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.goto("/");
  const board = page.getByRole("region", { name: "资料列表" });
  const search = board.getByRole("textbox", { name: "搜索资料" });
  const status = board.getByRole("combobox", { name: "资料状态" });
  const searchBox = (await search.boundingBox())!;
  const statusBox = (await status.boundingBox())!;
  expect(searchBox.width).toBeLessThanOrEqual(340);
  expect(Math.abs(searchBox.y - statusBox.y)).toBeLessThanOrEqual(2);
});

test("source status filter opens a styled menu without clipping and supports keyboard selection", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.goto("/");
  const status = page.getByRole("combobox", { name: "资料状态" });
  const triggerBox = await status.boundingBox();
  await status.click();
  const options = page.getByRole("listbox", { name: "资料状态选项" });
  await expect(options).toBeVisible();
  const menuBox = await options.boundingBox();
  expect(triggerBox).not.toBeNull();
  expect(menuBox).not.toBeNull();
  expect(menuBox!.width).toBeGreaterThanOrEqual(triggerBox!.width);
  await options.getByRole("option", { name: "已入库" }).click();
  await expect(status).toContainText("已入库");
  await status.focus();
  await page.keyboard.press("ArrowDown");
  await expect(options).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(options).toBeHidden();
  await expect(status).toBeFocused();
});

test("knowledge base editor keeps long names readable without widening the layout", async ({ page }) => {
  const longVaultId = "research-notes-and-publication-archive-2026";
  await page.route("**/api/v1/vaults", async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.vaults.push({ ...payload.vaults[0], id: longVaultId, isDefault: false });
    await route.fulfill({ response, body: JSON.stringify(payload) });
  });
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "导入资料" }).click();
  await page.getByLabel("选择文件").setInputFiles({ name: "clipper.zip", mimeType: "application/zip",
    buffer: fixtureZipFor("capture-vault-width", "知识库宽度资料") });
  const row = page.locator(".source-row").filter({ hasText: "知识库宽度资料" });
  await row.getByRole("button", { name: "入库" }).click();
  const dialog = page.getByRole("dialog", { name: "添加到知识库" });
  const initialWidth = (await dialog.boundingBox())!.width;
  expect(initialWidth).toBeGreaterThanOrEqual(400);
  expect(initialWidth).toBeLessThanOrEqual(520);
  const option = dialog.getByRole("checkbox", { name: new RegExp(longVaultId) });
  await expect(option).toBeVisible();
  await option.check();
  expect((await dialog.boundingBox())!.width).toBe(initialWidth);

  await page.setViewportSize({ width: 375, height: 812 });
  expect((await dialog.boundingBox())!.width).toBeLessThanOrEqual(375);
  await expect(option).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});

test("source workbench links to capture settings instead of showing a future feature badge", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("浏览器一键采集 · 后续接入")).toHaveCount(0);
  await page.getByRole("button", { name: "采集设置" }).click();
  await expect(page.getByRole("heading", { name: "资料导入规则" })).toBeVisible();
  await expect(page.getByLabel("采集后如何处理")).toBeVisible();
  await expect(page.getByRole("button", { name: "保存采集设置" })).toBeVisible();
  await page.getByRole("button", { name: "保存采集设置" }).click();
  await expect(page.getByRole("status")).toContainText("采集规则已保存");
});
