import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

test("outline and body are reviewed on the left and revised through discussion", async ({ page }) => {
  await page.route("**/api/v1/articles/*/writing-proposals", (route) => route.fulfill({ json: {
    outline: { markdown: "# 讨论后的大纲\n\n- 第一节", sha256: "readonly-outline", turnId: "readonly-turn", updatedAt: new Date().toISOString() },
    draft: { markdown: "# 讨论后的正文\n\n正文内容。", sha256: "readonly-draft", turnId: "readonly-turn", updatedAt: new Date().toISOString() },
  } }));
  await page.goto("/");
  await page.getByRole("button", { name: "文章工作台", exact: true }).click();
  await page.getByRole("button", { name: "新建文章" }).click();

  await page.getByRole("tab", { name: "大纲", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "文章大纲" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "文章大纲" })).toHaveCount(0);
  const outlinePanel = page.locator(".article-outline-panel");
  const outlineCandidate = page.getByLabel("待采用大纲预览");
  await expect(outlineCandidate).toBeVisible();
  expect((await outlineCandidate.boundingBox())!.height).toBeGreaterThan((await outlinePanel.boundingBox())!.height * 0.6);
  await page.getByRole("button", { name: "讨论修改大纲" }).click();
  await expect(page.getByLabel("向智能体提问")).toHaveValue(/修改大纲/);
  await page.getByRole("button", { name: "审阅大纲草案" }).click();
  await page.getByRole("dialog", { name: "采用大纲草案" }).getByRole("button", { name: "采用大纲" }).click();
  await expect(page.getByRole("region", { name: "文章大纲" })).toContainText("讨论后的大纲");

  await page.getByRole("tab", { name: "正文", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "文章正文" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "文章正文" })).toHaveCount(0);
  const bodyPanel = page.locator(".article-manuscript > .article-right-panel").last();
  const bodyCandidate = page.getByLabel("待采用正文预览");
  await expect(bodyCandidate).toBeVisible();
  expect((await bodyCandidate.boundingBox())!.height).toBeGreaterThan((await bodyPanel.boundingBox())!.height * 0.6);
  await page.getByRole("button", { name: "讨论修改正文" }).click();
  await expect(page.getByLabel("向智能体提问")).toHaveValue(/修改正文/);
  await page.getByRole("button", { name: "审阅正文草稿" }).click();
  await page.getByRole("dialog", { name: "采用智能体正文" }).getByRole("button", { name: "替换正文" }).click();
  await expect(page.getByRole("region", { name: "文章正文" })).toContainText("讨论后的正文");
});

test("multi-vault selections, reading, per-turn attachments and outline stay with their article", async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), "ocf-writing-context-"));
  const suffix = Date.now().toString(36);
  const ids = [`writing-a-${suffix}`, `writing-b-${suffix}`];
  let sends = 0;
  let sentSnapshot: object | null = null;
  try {
    for (const [index, id] of ids.entries()) {
      const path = join(root, id); mkdirSync(path);
      writeFileSync(join(path, "note.md"), `# ${index ? "对照来源乙" : "主题来源甲"}\n\n这是${index ? "乙" : "甲"}的证据原文。\n\n下一段材料。`);
      const result = await page.request.post("/api/v1/vaults", { headers: { "x-ocf-client": "1" }, data: { id, path, adopt: true } });
      expect(result.status()).toBe(201);
    }
    await page.route("**/api/v1/agents/profiles", (route) => route.fulfill({ json: { profiles: [{ id: "claude-current", label: "Claude CLI", available: true }] } }));
    await page.route("**/api/v1/articles/*/agent/runs", async (route) => {
      sends++;
      const data = route.request().postDataJSON();
      expect(data.selections).toHaveLength(1);
      expect(data.selections[0]).toMatchObject({ materialId: "S2", startLine: 3, endLine: 3 });
      const articleId = new URL(route.request().url()).pathname.split("/").at(-3)!;
      const c = (await (await page.request.get(`/api/v1/articles/${articleId}/context`)).json());
      sentSnapshot = await (await page.request.get(`/api/v1/articles/${articleId}/materials/S2`)).json();
      const context = { id: "test-turn", createdAt: new Date().toISOString(), sources: [c.materials[1]], vaultIds: ids, skillRequested: false, outlineRevision: null };
      await route.fulfill({ status: 202, json: { id: "test-run", articleId, profileId: "claude-current", assistantMessageId: "assistant",
        status: "completed", text: "综合结论见 [S2]。", tools: [], permissions: [], seq: 1, context,
        activity: "已完成", errorCode: null, createdAt: context.createdAt, updatedAt: context.createdAt } });
    });
    await page.route("**/api/v1/articles/*/materials/S2?turnId=test-turn", (route) => route.fulfill({ json: sentSnapshot }));
    await page.goto("/");
    await page.evaluate(() => localStorage.setItem("ocf-last-source", JSON.stringify({ vaultId: "default", snapshot: "raw/sources/stale.md" })));
    await page.reload();
    await page.getByRole("button", { name: "文章工作台", exact: true }).click();
    await page.getByRole("button", { name: "新建文章" }).click();
    await expect(page.getByLabel("文章标题")).toBeVisible();
    const articleId = await page.evaluate(() => localStorage.getItem("ocf-last-article"));
    // The drawer previews and commits references without starting a native run.
    await page.getByRole("button", { name: "选择创作资料", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "选择创作资料" });
    for (const id of ids) await drawer.getByLabel(`选择知识库 ${id}`).check();
    await drawer.getByRole("button", { name: /主题来源甲/ }).click();
    await expect(drawer.getByLabel("选材正文预览")).toContainText("这是甲的证据原文");
    await expect(drawer.getByLabel("选用 主题来源甲")).not.toBeChecked();
    await drawer.getByLabel("选用 主题来源甲").check();
    await drawer.getByLabel("选用 对照来源乙").check();
    await drawer.getByRole("button", { name: "带入对话（2）" }).click();
    expect(sends).toBe(0);
    await expect(page.getByLabel("本轮引用资料")).toContainText("S1");
    await page.getByRole("tab", { name: "资料阅读", exact: true }).click();
    await page.getByRole("button", { name: "对照阅读", exact: true }).click();
    await expect(page.getByLabel("创作资料阅读")).toContainText("这是甲的证据原文");
    await expect(page.getByLabel("创作资料阅读")).toContainText("这是乙的证据原文");
    await page.getByRole("button", { name: "单篇阅读", exact: true }).click();
    await page.getByRole("combobox", { name: "选择阅读资料" }).click();
    await page.getByRole("option", { name: "S2 对照来源乙" }).click();
    await page.getByRole("button", { name: "引用选段", exact: true }).click();
    await page.getByLabel("引用开始行").fill("3");
    await page.getByLabel("引用结束行").fill("3");
    await page.getByRole("button", { name: "引用此选段" }).click();
    await expect(page.getByLabel("本轮引用资料")).toContainText("L3–3");
    const outline = await (await page.request.get(`/api/v1/articles/${articleId}/outline`)).json();
    const saved = await page.request.put(`/api/v1/articles/${articleId}/outline`, { headers: { "x-ocf-client": "1" },
      data: { markdown: "# 主题大纲\n\n- 甲乙对照\n- 证据与结论", expectedRevision: outline.revision } });
    expect(saved.ok()).toBe(true);
    const approved = await page.request.post(`/api/v1/articles/${articleId}/outline/approve`, { headers: { "x-ocf-client": "1" },
      data: { expectedRevision: (await saved.json()).revision } });
    expect(approved.ok()).toBe(true);
    await page.reload();
    await page.getByRole("button", { name: "文章工作台", exact: true }).click();
    await page.getByRole("tab", { name: "大纲", exact: true }).click();
    await expect(page.getByLabel("大纲状态")).toContainText("已确认");
    await page.getByRole("button", { name: "本轮移除 S1", exact: true }).click();
    await page.getByLabel("向智能体提问").fill("综合阅读乙的证据");
    await page.getByRole("button", { name: "发送消息" }).click();
    await expect(page.getByRole("log")).toContainText("综合结论见");
    await expect(page.getByRole("log").getByRole("button", { name: /S2.*对照来源乙/ })).toBeVisible();
    writeFileSync(join(root, ids[1], "note.md"), "# 乙已经修改\n\n新证据内容。");
    await page.getByRole("button", { name: "[S2]", exact: true }).click();
    await expect(page.getByLabel("创作资料阅读")).toContainText("历史快照");
    await expect(page.getByLabel("创作资料阅读")).toContainText("这是乙的证据原文");
    await page.screenshot({ path: "/private/tmp/ocf-writing-workspace-selected.png" });
    await page.reload();
    await page.getByRole("button", { name: "文章工作台", exact: true }).click();
    await expect(page.getByLabel("本轮引用资料")).not.toContainText("主题来源甲");
    await expect(page.getByLabel("本轮引用资料")).toContainText("对照来源乙");
    await page.getByRole("button", { name: "返回文章列表" }).click();
    await page.getByRole("button", { name: "新建文章" }).click();
    await expect(page.getByLabel("本轮引用资料")).toContainText("未附资料");
    expect(articleId).toBeTruthy();
    expect((await (await page.request.get(`/api/v1/articles/${articleId}`)).json()).sourceRef).toBeNull();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "选择创作资料", exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: "/private/tmp/ocf-writing-drawer-mobile.png" });
    await page.getByRole("button", { name: "关闭选材窗口" }).click();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: "/private/tmp/ocf-writing-workspace.png" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("staged outline and body require review and adoption, context changes revoke outline approval", async ({ page }) => {
  await page.route("**/api/v1/articles/*/writing-proposals", (route) => route.fulfill({ json: {
    outline: { markdown: "# 候选大纲\n\n- 证据\n- 观点", sha256: "outline-hash", turnId: "staged", updatedAt: new Date().toISOString() },
    draft: { markdown: "# 智能体候选正文\n\n经过审阅才进入正式正文。", sha256: "draft-hash", turnId: "staged", updatedAt: new Date().toISOString() },
  } }));
  await page.goto("/");
  await page.getByRole("button", { name: "文章工作台", exact: true }).click();
  await page.getByRole("button", { name: "新建文章" }).click();
  await page.getByRole("button", { name: "审阅正文草稿" }).click();
  const review = page.getByRole("dialog", { name: "采用智能体正文" });
  await expect(review).toContainText("经过审阅才进入正式正文");
  await expect(page.getByRole("region", { name: "文章正文" })).toHaveCount(0);
  await expect(page.getByLabel("文章标题")).toHaveValue("");
  await review.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "审阅正文草稿" }).click();
  await review.getByRole("button", { name: "替换正文", exact: true }).click();
  await expect(page.getByRole("region", { name: "文章正文" })).toContainText("智能体候选正文");
  await expect(page.getByLabel("文章标题")).toHaveValue("智能体候选正文");
  await page.getByLabel("文章标题").fill("手动设置标题");
  await page.getByRole("tab", { name: "大纲", exact: true }).click();
  await page.getByRole("button", { name: "审阅大纲草案" }).click();
  const outline = page.getByRole("dialog", { name: "采用大纲草案" });
  await expect(page.getByRole("region", { name: "文章大纲" })).toHaveCount(0);
  await outline.getByRole("button", { name: "采用大纲", exact: true }).click();
  await expect(page.getByRole("region", { name: "文章大纲" })).toContainText("候选大纲");
  await page.getByRole("button", { name: "确认大纲", exact: true }).click();
  await expect(page.getByLabel("大纲状态")).toContainText("已确认");
  await expect(page.getByLabel("向智能体提问")).toHaveValue(/按本轮已确认的大纲起草文章/);
  await expect(page.getByRole("button", { name: "按大纲起草正文" })).toHaveCount(0);
  await page.getByRole("button", { name: "选择创作资料", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "选择创作资料" });
  await drawer.getByLabel("选择知识库 default", { exact: true }).check();
  await drawer.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByLabel("大纲状态")).toContainText("已确认");
  await page.getByRole("button", { name: "选择创作资料", exact: true }).click();
  await expect(drawer.getByLabel("选择知识库 default", { exact: true })).not.toBeChecked();
  await drawer.getByLabel("选择知识库 default", { exact: true }).check();
  await drawer.getByRole("button", { name: "带入对话（0）" }).click();
  await page.getByRole("tab", { name: "大纲", exact: true }).click();
  await expect(page.getByLabel("大纲状态")).toContainText("待审阅");
  await expect(page.locator(".article-save-line")).toContainText(/草稿已保存|已自动保存/);
  await page.reload();
  await page.getByRole("button", { name: "文章工作台", exact: true }).click();
  await expect(page.getByRole("region", { name: "文章正文" })).toContainText("智能体候选正文");
  await expect(page.getByLabel("文章标题")).toHaveValue("手动设置标题");
  await page.getByRole("tab", { name: "大纲", exact: true }).click();
  await expect(page.getByRole("region", { name: "文章大纲" })).toContainText("候选大纲");
  await expect(page.getByLabel("待采用大纲预览")).toHaveCount(0);
  await expect(page.getByLabel("待采用正文预览")).toHaveCount(0);
  await page.screenshot({ path: "/private/tmp/ocf-writing-outline.png" });
});

test("agent output links open in article review and proposals appear beside the draft", async ({ page }) => {
  const turnId = "turn-123";
  let articleId = "";
  await page.route("**/api/v1/articles/*/writing-proposals", (route) => route.fulfill({ json: {
    outline: { markdown: "# 输出提纲\n\n- 第一节", sha256: "outline-123", turnId, updatedAt: new Date().toISOString() },
    draft: { markdown: "# 输出正文\n\n正文段落。", sha256: "draft-123", turnId, updatedAt: new Date().toISOString() },
  } }));
  await page.goto("/");
  await page.getByRole("button", { name: "文章工作台", exact: true }).click();
  await page.getByRole("button", { name: "新建文章" }).click();
  await expect(page.getByLabel("文章标题")).toBeVisible();
  articleId = (await page.evaluate(() => localStorage.getItem("ocf-last-article")))!;
  await page.getByLabel("文章标题").fill("输出链接文章");
  await expect(page.getByRole("status")).toContainText("草稿已保存");
  const root = `http://127.0.0.1:5173/Users/demo/agent-workspaces/${articleId}/outputs/${turnId}`;
  await page.route("**/api/v1/articles/*/agent?*", (route) => route.fulfill({ json: {
    profileId: "claude-current", run: null, runs: [], messages: [{ id: "assistant-output", role: "assistant",
      content: `[提纲 outline.md](${root}/outline.md)\n\n[文章 article.md](${root}/article.md)`,
      createdAt: new Date().toISOString() }],
  } }));
  await page.reload();
  await page.getByRole("button", { name: "文章工作台", exact: true }).click();
  const articleRow = page.getByRole("button", { name: "输出链接文章", exact: true });
  const outlineTab = page.getByRole("tab", { name: "大纲", exact: true });
  await expect(articleRow.or(outlineTab)).toBeVisible();
  if (await articleRow.isVisible()) await articleRow.click();
  await page.getByRole("tab", { name: "大纲", exact: true }).click();
  await expect(page.getByLabel("待采用大纲预览")).toContainText("输出提纲");
  await page.getByRole("tab", { name: "正文", exact: true }).click();
  await expect(page.getByLabel("待采用正文预览")).toContainText("输出正文");
  const before = page.url();
  await page.getByRole("button", { name: "提纲 outline.md" }).click();
  await expect(page.getByRole("dialog", { name: "采用大纲草案" })).toContainText("输出提纲");
  expect(page.url()).toBe(before);
  expect(page.context().pages()).toHaveLength(1);
  await page.getByRole("dialog", { name: "采用大纲草案" }).getByRole("button", { name: "采用大纲" }).click();
  await expect(page.getByRole("region", { name: "文章大纲" })).toContainText("输出提纲");
  await page.getByRole("button", { name: "文章 article.md" }).click();
  await expect(page.getByRole("dialog", { name: "采用智能体正文" })).toContainText("输出正文");
  await page.getByRole("dialog", { name: "采用智能体正文" }).getByRole("button", { name: "替换正文" }).click();
  await expect(page.getByRole("region", { name: "文章正文" })).toContainText("输出正文");
});

test("legacy unsaved outline is readable and can be saved after the editor is removed", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "文章工作台", exact: true }).click();
  await page.getByRole("button", { name: "新建文章" }).click();
  await expect(page.getByLabel("文章标题")).toBeVisible();
  await page.getByLabel("文章标题").fill("旧草稿恢复文章");
  await expect(page.getByRole("status")).toContainText("草稿已保存");
  const articleId = await page.evaluate(() => localStorage.getItem("ocf-last-article"));
  await page.evaluate((id) => sessionStorage.setItem(`ocf-outline-draft:${id}`, "# 未保存的旧大纲\n\n- 旧内容"), articleId);
  await page.reload();
  await page.getByRole("button", { name: "文章工作台", exact: true }).click();
  const articleRow = page.getByRole("button", { name: "旧草稿恢复文章", exact: true });
  const outlineTab = page.getByRole("tab", { name: "大纲", exact: true });
  await expect(articleRow.or(outlineTab)).toBeVisible();
  if (await articleRow.isVisible()) await articleRow.click();
  await outlineTab.click();
  await expect(page.getByRole("textbox", { name: "文章大纲" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "文章大纲" })).toContainText("未保存的旧大纲");
  await expect(page.getByLabel("大纲状态")).toContainText("待保存的旧草稿");
  await page.getByRole("button", { name: "保存旧草稿" }).click();
  await expect(page.getByRole("button", { name: "保存旧草稿" })).toHaveCount(0);
  expect((await (await page.request.get(`/api/v1/articles/${articleId}/outline`)).json()).markdown).toBe("# 未保存的旧大纲\n\n- 旧内容");
  await page.reload();
  await page.getByRole("button", { name: "文章工作台", exact: true }).click();
  await expect(articleRow.or(outlineTab)).toBeVisible();
  if (await articleRow.isVisible()) await articleRow.click();
  await outlineTab.click();
  await expect(page.getByRole("region", { name: "文章大纲" })).toContainText("未保存的旧大纲");
});
