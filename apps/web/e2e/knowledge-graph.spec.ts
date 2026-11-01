import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

test("graph highlights a neighborhood and can hide isolated notes", async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), "ocf-graph-ui-"));
  const vault = join(root, "notes");
  mkdirSync(vault);
  writeFileSync(join(vault, "Alpha.md"), "# Alpha\n[[Beta]]\n");
  writeFileSync(join(vault, "Beta.md"), "# Beta\n");
  writeFileSync(join(vault, "Orphan.md"), "# Orphan\n");
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByLabel("知识库 ID").fill("graph-ui");
    await page.getByLabel("外部 vault 路径").fill(vault);
    await page.getByRole("button", { name: "连接知识库", exact: true }).click();
    await page.getByRole("button", { name: "确认连接此目录" }).click();
    await page.getByRole("button", { name: "知识库", exact: true }).click();
    await page.getByRole("combobox", { name: "选择知识库" }).click();
    await page.getByRole("option", { name: "graph-ui" }).click();
    await page.getByRole("tab", { name: "图谱" }).click();

    const canvas = page.locator(".knowledge-graph-canvas");
    await expect(canvas.locator(".knowledge-graph-node")).toHaveCount(3);
    const alphaLabel = canvas.locator(".knowledge-graph-label").filter({ hasText: "Alpha" });
    const initialLabelHeight = await alphaLabel.evaluate((element) => element.getBoundingClientRect().height);
    for (let index = 0; index < 5; index++) await page.getByRole("button", { name: "放大" }).click();
    const zoomedLabelHeight = await alphaLabel.evaluate((element) => element.getBoundingClientRect().height);
    expect(zoomedLabelHeight).toBeLessThan(initialLabelHeight * 1.3);
    await page.getByRole("button", { name: "重置视野" }).click();
    await canvas.getByRole("button", { name: "Alpha" }).hover();
    await expect(canvas.locator(".knowledge-graph-node.is-dimmed")).toHaveCount(1);
    await page.getByRole("button", { name: "隐藏孤立节点" }).click();
    await expect(canvas.locator(".knowledge-graph-node")).toHaveCount(2);
    await expect(page.getByText("2/3 个节点 · 1 条可验证关系")).toBeVisible();
    await expect(page.locator(".knowledge-graph-node-list").getByRole("button", { name: "Orphan" })).toHaveCount(0);
    await page.getByRole("button", { name: "显示孤立节点" }).click();
    await expect(canvas.locator(".knowledge-graph-node")).toHaveCount(3);
    await expect(page.locator(".knowledge-graph-node-list").getByRole("button", { name: "Orphan", exact: true })).toBeVisible();

    await page.getByLabel("定位图谱节点").fill("Alpha");
    await page.getByRole("button", { name: "定位", exact: true }).click();
    await page.getByRole("tab", { name: "浏览" }).click();
    await expect(page.locator(".knowledge-results-top span")).toHaveText("3 项");
    await page.getByRole("tab", { name: "图谱" }).click();
    await page.getByRole("button", { name: "清除", exact: true }).click();
    await expect(canvas.locator(".knowledge-graph-node")).toHaveCount(3);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("button", { name: "图谱工具" })).toBeVisible();
    await expect(page.locator(".knowledge-graph-sidebar")).toBeHidden();
    await page.getByRole("button", { name: "图谱工具" }).click();
    await expect(page.locator(".knowledge-graph-sidebar")).toBeVisible();
    await expect(canvas).toBeVisible();
    await page.getByRole("button", { name: "关闭图谱工具" }).click();
    await expect(page.locator(".knowledge-graph-sidebar")).toBeHidden();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("graph keeps a dense vault readable without printing every title", async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), "ocf-graph-dense-"));
  const vault = join(root, "notes");
  mkdirSync(vault);
  const title = (index: number) => `Node ${String(index + 1).padStart(3, "0")}`;
  for (let index = 0; index < 206; index++) {
    const targets = [(index + 1) % 206, (index + 11) % 206];
    if (index < 140) targets.push((index + 37) % 206);
    writeFileSync(join(vault, `${title(index)}.md`), `# ${title(index)}\n${targets.map((target) => `[[${title(target)}]]`).join("\n")}\n`);
  }
  try {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto("/");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByLabel("知识库 ID").fill("graph-dense");
    await page.getByLabel("外部 vault 路径").fill(vault);
    await page.getByRole("button", { name: "连接知识库", exact: true }).click();
    await page.getByRole("button", { name: "确认连接此目录" }).click();
    await page.getByRole("button", { name: "知识库", exact: true }).click();
    await page.getByRole("combobox", { name: "选择知识库" }).click();
    await page.getByRole("option", { name: "graph-dense" }).click();
    await page.getByRole("tab", { name: "图谱" }).click();

    const canvas = page.locator(".knowledge-graph-canvas");
    await expect(page.getByText("206 个节点 · 552 条可验证关系")).toBeVisible();
    await expect(canvas.locator(".knowledge-graph-node")).toHaveCount(206);
    await expect(page.locator(".page-knowledge > h1")).toHaveCount(0);
    const tabBounds = await page.getByRole("tab", { name: "图谱" }).boundingBox();
    const vaultBounds = await page.getByRole("combobox", { name: "选择知识库" }).boundingBox();
    const searchBounds = await page.getByLabel("搜索知识库").boundingBox();
    expect(Math.abs(tabBounds!.y - vaultBounds!.y)).toBeLessThan(24);
    expect(Math.abs(tabBounds!.y - searchBounds!.y)).toBeLessThan(24);
    const canvasBounds = await canvas.boundingBox();
    const sidebar = page.locator(".knowledge-graph-sidebar");
    const sidebarBounds = await sidebar.boundingBox();
    expect(canvasBounds!.width).toBeGreaterThan(sidebarBounds!.width * 2.5);
    expect(canvasBounds!.height).toBeGreaterThan(600);
    expect(sidebarBounds!.x).toBeGreaterThan(canvasBounds!.x + canvasBounds!.width - 10);
    await expect(sidebar.getByRole("combobox", { name: "图谱节点类型" })).toBeVisible();
    await expect(sidebar.getByLabel("定位图谱节点")).toBeVisible();
    await expect(sidebar.getByRole("heading", { name: "节点" })).toBeVisible();
    expect(await canvas.locator(".knowledge-graph-label").count()).toBeLessThan(20);
    for (let index = 0; index < 5; index++) await page.getByRole("button", { name: "放大" }).click();
    const bounds = await canvas.boundingBox();
    await page.mouse.move(bounds!.x + 12, bounds!.y + 12);
    expect(await canvas.locator(".knowledge-graph-label").count()).toBeLessThan(20);
    await page.getByRole("button", { name: "重置视野" }).click();
    await canvas.getByRole("button", { name: "Node 001" }).hover();
    await expect(canvas.locator(".knowledge-graph-label").filter({ hasText: "Node 001" })).toBeVisible();
    await canvas.getByRole("button", { name: "Node 001" }).click();
    await expect(page.getByLabel("内容详情")).toContainText("Node 001");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("switching graph vaults hides old nodes while loading and after a failed request", async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), "ocf-graph-switch-"));
  const first = join(root, "first"), second = join(root, "second");
  mkdirSync(first); mkdirSync(second);
  writeFileSync(join(first, "Alpha.md"), "# Alpha\n");
  writeFileSync(join(second, "Gamma.md"), "# Gamma\n");
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    for (const [id, path] of [["graph-first", first], ["graph-second", second]]) {
      await page.getByLabel("知识库 ID").fill(id);
      await page.getByLabel("外部 vault 路径").fill(path);
      await page.getByRole("button", { name: "连接知识库", exact: true }).click();
      await page.getByRole("button", { name: "确认连接此目录" }).click();
      await expect(page.locator(".knowledge-connection").filter({ hasText: id })).toBeVisible();
    }
    await page.getByRole("button", { name: "知识库", exact: true }).click();
    await page.getByRole("combobox", { name: "选择知识库" }).click();
    await page.getByRole("option", { name: "graph-first" }).click();
    await page.getByRole("tab", { name: "图谱" }).click();
    const canvas = page.locator(".knowledge-graph-canvas");
    await expect(canvas.getByRole("button", { name: "Alpha" })).toHaveCount(1);

    let releaseRequest = () => undefined;
    let requestBlocked = () => undefined;
    const heldRequest = new Promise<void>((resolve) => { releaseRequest = resolve; });
    const blocked = new Promise<void>((resolve) => { requestBlocked = resolve; });
    await page.route("**/api/v1/knowledge/graph/**", async (route) => {
      if (!new URL(route.request().url()).pathname.endsWith("/graph/graph-second")) return route.continue();
      requestBlocked();
      await heldRequest;
      await route.continue();
    });
    await page.getByRole("combobox", { name: "选择知识库" }).click();
    await page.getByRole("option", { name: "graph-second" }).click();
    await blocked;
    await expect(page.getByText("graph-second 关系图谱")).toBeVisible();
    try { await expect(canvas.getByRole("button", { name: "Alpha" })).toHaveCount(0, { timeout: 600 }); }
    finally { releaseRequest(); }
    await expect(canvas.getByRole("button", { name: "Gamma" })).toHaveCount(1);

    await page.route("**/api/v1/knowledge/graph/**", async (route) => {
      if (new URL(route.request().url()).pathname.endsWith("/graph/graph-first")) await route.abort();
      else await route.continue();
    });
    await page.getByRole("combobox", { name: "选择知识库" }).click();
    await page.getByRole("option", { name: "graph-first" }).click();
    await expect(canvas.getByRole("button", { name: "Gamma" })).toHaveCount(0);
    await expect(page.locator(".knowledge-graph-placeholder")).toContainText("图谱读取失败");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
