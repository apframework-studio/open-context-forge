import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

test("a direct draft publish link returns to that draft, not the last edited article", async ({ page }) => {
  const headers = { "x-ocf-client": "1" };
  const previous = await page.request.post("/api/v1/articles", { headers, data: { title: "之前编辑的文章" } });
  const target = await page.request.post("/api/v1/articles", { headers, data: { title: "当前准备发布的文章" } });
  const previousId = (await previous.json()).id as string;
  const targetId = (await target.json()).id as string;
  await page.goto("/");
  await page.evaluate((id) => localStorage.setItem("ocf-last-article", id), previousId);
  await page.goto(`/#publish/${targetId}`);
  await expect(page.getByText("请先在文章工作台定稿")).toBeVisible();
  await page.getByRole("button", { name: "返回此文章并定稿" }).click();
  await expect(page.getByRole("textbox", { name: "文章标题" })).toHaveValue("当前准备发布的文章");
  await expect(page).toHaveURL(new RegExp(`#articles/${targetId}`));
});

test("article-based channel suggestions preview changes before replacing a saved draft", async ({ page }) => {
  const headers = { "x-ocf-client": "1" };
  const created = await page.request.post("/api/v1/articles", { headers,
    data: { title: `渠道建议-${randomUUID().slice(0, 8)}`, summary: "把散落资料整理成可分享的主题", date: "2026-11-08", sourceRef: null } });
  const id = (await created.json()).id as string;
  await page.request.put(`/api/v1/articles/${id}/draft`, { headers,
    data: { expectedRevision: 0, markdown: "# 渠道建议\n\n先记录来源，再按主题整理。\n\n## 回顾\n\n检查遗漏。" } });
  await page.request.post(`/api/v1/articles/${id}/finalize`, { headers, data: { expectedRevision: 1 } });
  await page.setViewportSize({ width: 1440, height: 810 });
  await page.goto(`/#publish/${id}`);
  await page.locator('input[type="file"]').setInputFiles(resolve(import.meta.dirname, "../public/favicon-32x32.png"));
  await page.getByRole("button", { name: "微博发布", exact: true }).click();
  await page.getByRole("textbox", { name: "微博正文" }).fill("已保存的旧文案");
  await page.getByRole("checkbox", { name: "favicon-32x32.png" }).check();
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByRole("status")).toContainText("渠道稿已保存");
  await page.getByRole("button", { name: "从文章提取文案建议" }).click();
  const preview = page.getByRole("region", { name: "文案建议预览" });
  await expect(preview).toContainText("已保存的旧文案");
  await expect(preview).toContainText("先记录来源，再按主题整理");
  const adopt = await preview.getByRole("button", { name: "采用建议到编辑区" }).boundingBox();
  expect(adopt).not.toBeNull();
  expect(adopt!.y + adopt!.height).toBeLessThanOrEqual(810);
  await expect(page.getByRole("textbox", { name: "微博正文" })).toHaveValue("已保存的旧文案");
  expect((await (await page.request.get(`/api/v1/articles/${id}/channel-drafts/weibo`)).json()).content.text).toBe("已保存的旧文案");
  await preview.getByRole("button", { name: "采用建议到编辑区" }).click();
  await expect(page.getByRole("textbox", { name: "微博正文" })).toContainText("先记录来源，再按主题整理");
  await expect(page.getByRole("checkbox", { name: "favicon-32x32.png" })).toBeChecked();
  expect((await (await page.request.get(`/api/v1/articles/${id}/channel-drafts/weibo`)).json()).content.text).toBe("已保存的旧文案");
  await page.getByRole("button", { name: "保存草稿" }).click();
  const saved = await (await page.request.get(`/api/v1/articles/${id}/channel-drafts/weibo`)).json();
  expect(saved.content.text).toContain("先记录来源，再按主题整理");
  expect(saved.assetIds).toHaveLength(1);
  await page.getByRole("button", { name: "即刻发布", exact: true }).click();
  await page.getByRole("button", { name: "从文章提取文案建议" }).click();
  await expect(page.getByRole("region", { name: "文案建议预览" })).toContainText("回顾");
  await page.setViewportSize({ width: 375, height: 812 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await page.getByRole("button", { name: "保留当前稿" }).click();
  await expect(page.getByRole("textbox", { name: "即刻正文" })).toHaveValue("");
  await page.getByRole("button", { name: "从文章提取文案建议" }).click();
  await page.getByRole("button", { name: "采用建议到编辑区" }).click();
  await expect(page.getByRole("textbox", { name: "即刻正文" })).toContainText("把散落资料整理成可分享的主题");
  await expect(page.getByRole("textbox", { name: "讨论引导" })).toHaveValue(/回顾/);
  expect((await page.request.get(`/api/v1/articles/${id}/channel-drafts/jike`)).status()).toBe(404);
  await page.getByRole("button", { name: "保存草稿" }).click();
  expect((await page.request.get(`/api/v1/articles/${id}/channel-drafts/jike`)).status()).toBe(200);
});

test("unsaved channel edits survive a visit to another channel", async ({ page }) => {
  const headers = { "x-ocf-client": "1" };
  const created = await page.request.post("/api/v1/articles", { headers,
    data: { title: `渠道切换-${randomUUID().slice(0, 8)}`, summary: "检查编辑草稿", date: "2026-11-08", sourceRef: null } });
  const id = (await created.json()).id as string;
  await page.request.put(`/api/v1/articles/${id}/draft`, { headers,
    data: { expectedRevision: 0, markdown: "# 渠道切换\n\n文章正文。" } });
  await page.request.post(`/api/v1/articles/${id}/finalize`, { headers, data: { expectedRevision: 1 } });
  await page.setViewportSize({ width: 1440, height: 810 });
  await page.goto(`/#publish/${id}`);
  await page.locator('input[type="file"]').setInputFiles(resolve(import.meta.dirname, "../public/favicon-32x32.png"));
  await expect(page.getByRole("status")).toContainText("已上传 1 张图片");
  await page.getByRole("button", { name: "微博发布", exact: true }).click();
  await expect(page.getByText("查看定稿文章")).toBeVisible();
  await page.getByText("查看定稿文章").click();
  await expect(page.getByText("文章正文。", { exact: false })).toBeVisible();
  await page.getByText("查看定稿文章").click();
  await page.getByRole("textbox", { name: "微博正文" }).fill("还在编辑中的微博文案");
  await page.getByRole("checkbox", { name: "favicon-32x32.png" }).check();
  const save = await page.getByRole("button", { name: "保存草稿" }).boundingBox();
  expect(save).not.toBeNull();
  expect(save!.y + save!.height).toBeLessThanOrEqual(810);
  await page.getByRole("button", { name: "即刻发布", exact: true }).click();
  await page.getByRole("button", { name: "微博发布", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "微博正文" })).toHaveValue("还在编辑中的微博文案");
  await expect(page.getByRole("checkbox", { name: "favicon-32x32.png" })).toBeChecked();
  await expect(page.getByText(/未保存的修改/)).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "微博发布", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "微博正文" })).toHaveValue("还在编辑中的微博文案");
  await expect(page.getByRole("checkbox", { name: "favicon-32x32.png" })).toBeChecked();
  await page.getByRole("button", { name: "放弃未保存修改" }).click();
  await expect(page.getByRole("textbox", { name: "微博正文" })).toHaveValue("");
  await expect(page.getByRole("checkbox", { name: "favicon-32x32.png" })).not.toBeChecked();
  await page.getByRole("button", { name: "即刻发布", exact: true }).click();
  await page.getByRole("button", { name: "微博发布", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "微博正文" })).toHaveValue("");
  await page.setViewportSize({ width: 375, height: 812 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await expect(page.getByRole("button", { name: "保存草稿" })).toBeVisible();
});

test("an unfinished image prompt survives returning to the asset library", async ({ page }) => {
  const headers = { "x-ocf-client": "1" };
  const created = await page.request.post("/api/v1/articles", { headers,
    data: { title: `提示词切换-${randomUUID().slice(0, 8)}`, summary: "检查提示词草稿", date: "2026-11-08", sourceRef: null } });
  const id = (await created.json()).id as string;
  await page.request.put(`/api/v1/articles/${id}/draft`, { headers,
    data: { expectedRevision: 0, markdown: "# 提示词切换\n\n文章正文。" } });
  await page.request.post(`/api/v1/articles/${id}/finalize`, { headers, data: { expectedRevision: 1 } });
  await page.goto(`/#publish/${id}`);
  await page.getByRole("button", { name: "制作图片" }).click();
  await page.getByRole("textbox", { name: "画面提示词" }).fill("暖色调的知识地图，中心留标题区域");
  await page.getByRole("button", { name: "返回素材" }).click();
  await page.getByRole("button", { name: "制作图片" }).click();
  await expect(page.getByRole("textbox", { name: "画面提示词" })).toHaveValue("暖色调的知识地图，中心留标题区域");
  await page.reload();
  await page.getByRole("button", { name: "制作图片" }).click();
  await expect(page.getByRole("textbox", { name: "画面提示词" })).toHaveValue("暖色调的知识地图，中心留标题区域");
});

test("first-time image setup is prominent, then stays out of the daily creation path", async ({ page }) => {
  const headers = { "x-ocf-client": "1" };
  const created = await page.request.post("/api/v1/articles", { headers,
    data: { title: `图像布局-${randomUUID().slice(0, 8)}`, summary: "检查日常制作布局", date: "2026-11-08", sourceRef: null } });
  const id = (await created.json()).id as string;
  await page.request.put(`/api/v1/articles/${id}/draft`, { headers,
    data: { expectedRevision: 0, markdown: "# 图像布局\n\n日常制作封面。" } });
  await page.request.post(`/api/v1/articles/${id}/finalize`, { headers, data: { expectedRevision: 1 } });
  await page.setViewportSize({ width: 1440, height: 810 });
  await page.goto(`/#publish/${id}`);
  await page.getByRole("button", { name: "制作图片" }).click();
  await expect(page.getByRole("heading", { name: "先配置 Gemini 图像服务" })).toBeVisible();
  await page.getByRole("button", { name: "配置连接" }).click();
  await page.getByRole("textbox", { name: "Gemini API Key" }).fill("test-gemini-key-12345");
  await page.getByRole("button", { name: "保存 Key" }).click();
  await expect(page.getByRole("heading", { name: "先配置 Gemini 图像服务" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "管理连接" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Gemini API Key" })).toBeHidden();
  await expect(page.getByRole("button", { name: "生成并保存图片" })).toBeEnabled();
  const generate = await page.getByRole("button", { name: "生成并保存图片" }).boundingBox();
  expect(generate).not.toBeNull();
  expect(generate!.y + generate!.height).toBeLessThanOrEqual(810);
  await page.getByRole("button", { name: "管理连接" }).click();
  await page.getByRole("button", { name: "移除 Key" }).click();
});

test("image connection stays collapsed and an API key pasted as a model is not displayed", async ({ page }) => {
  const headers = { "x-ocf-client": "1" };
  const created = await page.request.post("/api/v1/articles", { headers,
    data: { title: `模型安全-${randomUUID().slice(0, 8)}`, summary: "检查敏感输入", date: "2026-11-08", sourceRef: null } });
  const id = (await created.json()).id as string;
  await page.request.put(`/api/v1/articles/${id}/draft`, { headers,
    data: { expectedRevision: 0, markdown: "# 模型安全\n\n验证连接配置。" } });
  await page.request.post(`/api/v1/articles/${id}/finalize`, { headers, data: { expectedRevision: 1 } });
  await page.setViewportSize({ width: 1440, height: 810 });
  await page.goto(`/#publish/${id}`);
  await page.getByRole("button", { name: "制作图片" }).click();
  await page.getByRole("combobox", { name: "图像服务" }).selectOption("openai");
  await expect(page.getByRole("textbox", { name: "GPT API Key" })).toBeHidden();
  await page.getByRole("button", { name: "配置连接" }).click();
  await expect(page.getByRole("textbox", { name: "GPT API Key" })).toBeVisible();
  await page.getByRole("button", { name: "添加自定义模型" }).click();
  const input = page.getByRole("textbox", { name: "自定义模型 ID" });
  await input.fill("sk-test-accidental-api-key-123456789");
  await expect(input).toHaveValue("");
  await expect(page.getByRole("status")).toContainText("看起来是 API Key");
  await input.fill("A7b9C2d4E6f8G1h3I5j7K9m2N4p6Q8r1S3t5U7v9W2x4");
  await expect(input).toHaveValue("");
  await expect(page.getByRole("combobox", { name: "图像模型" }).locator('option[value^="sk-"]')).toHaveCount(0);
});

test("a custom image model remains selectable after reload and can be removed", async ({ page }) => {
  const headers = { "x-ocf-client": "1" };
  const created = await page.request.post("/api/v1/articles", { headers,
    data: { title: `自定义图像模型-${randomUUID().slice(0, 8)}`, summary: "自定义模型选择", date: "2026-11-08", sourceRef: null } });
  const id = (await created.json()).id as string;
  await page.request.put(`/api/v1/articles/${id}/draft`, { headers,
    data: { expectedRevision: 0, markdown: "# 自定义模型\n\n用于验证图像生成配置。" } });
  await page.request.post(`/api/v1/articles/${id}/finalize`, { headers, data: { expectedRevision: 1 } });
  await page.setViewportSize({ width: 1440, height: 810 });
  await page.goto(`/#publish/${id}`);
  await page.getByRole("button", { name: "制作图片" }).click();
  await page.getByRole("combobox", { name: "图像服务" }).selectOption("openai");
  await page.getByRole("button", { name: "添加自定义模型" }).click();
  await page.getByRole("textbox", { name: "自定义模型 ID" }).fill("gpt-image-2.6-flare");
  await page.getByRole("button", { name: "添加模型" }).click();
  await expect(page.getByRole("combobox", { name: "图像模型" })).toHaveValue("gpt-image-2.6-flare");
  await page.reload();
  await page.getByRole("button", { name: "制作图片" }).click();
  await page.getByRole("combobox", { name: "图像服务" }).selectOption("openai");
  await page.getByRole("combobox", { name: "图像模型" }).selectOption("gpt-image-2.6-flare");
  await page.getByRole("button", { name: "移除自定义模型" }).click();
  await expect(page.getByRole("combobox", { name: "图像模型" })).toHaveValue("gpt-image-2.5-flare");
});

test("image workspace switches providers and extracts an editable prompt from the article outline", async ({ page }) => {
  const headers = { "x-ocf-client": "1" };
  const title = `图像提示词-${randomUUID().slice(0, 8)}`;
  const created = await page.request.post("/api/v1/articles", { headers,
    data: { title, summary: "把零散资料整理成清晰脉络", date: "2026-11-08", sourceRef: null } });
  const id = (await created.json()).id as string;
  await page.request.put(`/api/v1/articles/${id}/draft`, { headers,
    data: { expectedRevision: 0, markdown: `# ${title}\n## 收集材料\n\n梳理来源。` } });
  await page.request.post(`/api/v1/articles/${id}/finalize`, { headers, data: { expectedRevision: 1 } });
  await page.request.put(`/api/v1/articles/${id}/outline`, { headers,
    data: { expectedRevision: 0, markdown: "# 图片线索\n- 标注资料出处" } });
  await page.setViewportSize({ width: 1440, height: 810 });
  await page.goto(`/#publish/${id}`);
  await page.getByRole("button", { name: "制作图片" }).click();
  await page.getByRole("button", { name: "从当前文章提取并替换提示词" }).click();
  const prompt = page.getByRole("textbox", { name: "画面提示词" });
  await expect(prompt).toContainText("收集材料");
  await expect(prompt).toContainText("标注资料出处");
  await prompt.fill("用户可以继续调整画面");
  await page.getByRole("combobox", { name: "图像服务" }).selectOption("openai");
  await page.getByRole("button", { name: "配置连接" }).click();
  await expect(page.getByRole("textbox", { name: "GPT API Key" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "图像模型" })).toHaveValue("gpt-image-2.5-flare");
  await expect(page.getByRole("button", { name: "生成并保存图片" })).toBeDisabled();
  await page.getByRole("combobox", { name: "图像模型" }).selectOption("gpt-image-2");
  await page.getByRole("textbox", { name: "GPT API 地址" }).fill("https://images.example.com/v1");
  await page.getByRole("textbox", { name: "GPT API Key" }).fill("test-compatible-key-12345");
  await page.getByRole("button", { name: "保存 Key" }).click();
  await expect(page.getByRole("button", { name: "生成并保存图片" })).toBeEnabled();
  await page.getByRole("combobox", { name: "图像服务" }).selectOption("aliyun");
  await page.getByRole("button", { name: "配置连接" }).click();
  await expect(page.getByRole("combobox", { name: "千问服务地域" })).toBeVisible();
  await expect(prompt).toHaveValue("用户可以继续调整画面");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.reload();
  await page.getByRole("button", { name: "制作图片" }).click();
  await expect(page.getByRole("combobox", { name: "图像服务" })).toHaveValue("openai");
  await page.getByRole("button", { name: "管理连接" }).click();
  await page.getByRole("button", { name: "移除 Key" }).click();
});

test("a final article shares one uploaded image across saved Weibo and Jike drafts", async ({ page }) => {
  const title = `发布中心-${randomUUID().slice(0, 8)}`;
  const headers = { "x-ocf-client": "1" };
  const created = await page.request.post("/api/v1/articles", { headers,
    data: { title, summary: "检查定稿文章的渠道准备", date: "2026-11-07", sourceRef: null } });
  expect(created.status()).toBe(201);
  const articleId = (await created.json()).id as string;
  expect((await page.request.put(`/api/v1/articles/${articleId}/draft`, { headers,
    data: { expectedRevision: 0, markdown: `# ${title}\n\n这篇文章梳理了从资料整理到内容发布的具体步骤。` } })).status()).toBe(200);
  expect((await page.request.post(`/api/v1/articles/${articleId}/finalize`, { headers,
    data: { expectedRevision: 1 } })).status()).toBe(200);

  await page.setViewportSize({ width: 1440, height: 810 });
  await page.goto("/#publish");
  await expect(page.getByRole("heading", { name: "发布中心", exact: true })).toBeVisible();
  await page.getByRole("button", { name: new RegExp(title) }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles(resolve(import.meta.dirname, "../public/favicon-32x32.png"));
  await expect(page.getByRole("status")).toContainText("已上传 1 张图片");

  await page.getByRole("button", { name: "微博发布", exact: true }).click();
  await expect(page.getByRole("button", { name: "下载渠道发布包" })).toHaveCount(0);
  await page.getByRole("textbox", { name: "微博正文" }).fill("微博渠道的独立文案");
  await page.getByRole("checkbox", { name: "favicon-32x32.png" }).check();
  await page.getByRole("button", { name: "标记待发布" }).click();
  await expect(page.getByRole("status")).toContainText("渠道稿已标记待发布");
  await expect(page.getByRole("heading", { name: "发布交接 · 微博" })).toBeVisible();
  const bundleStarted = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载渠道发布包" }).click();
  expect((await bundleStarted).suggestedFilename()).toBe(`weibo-${articleId}.zip`);
  const downloadStarted = page.waitForEvent("download");
  await page.getByRole("link", { name: "下载图片 1" }).click();
  expect((await downloadStarted).suggestedFilename()).toBe("favicon-32x32.png");
  await page.getByRole("button", { name: "复制发布文案" }).click();
  await expect(page.getByRole("status")).toContainText("文案已复制");
  await page.getByRole("textbox", { name: "已发布链接（选填）" }).fill("https://weibo.com/example");
  await page.getByRole("button", { name: "确认已在平台发布" }).click();
  await expect(page.getByRole("status")).toContainText("已记录本渠道发布结果");
  await expect(page.getByText("已发布", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "即刻发布", exact: true }).click();
  await page.getByRole("textbox", { name: "即刻正文" }).fill("即刻渠道的独立文案");
  await page.getByRole("checkbox", { name: "favicon-32x32.png" }).check();
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByRole("status")).toContainText("渠道稿已保存");
  await page.getByRole("button", { name: "标记待发布" }).click();
  await expect(page.getByRole("heading", { name: "发布交接 · 即刻" })).toBeVisible();
  const jikeBundle = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载渠道发布包" }).click();
  expect((await jikeBundle).suggestedFilename()).toBe(`jike-${articleId}.zip`);
  await page.getByRole("button", { name: "确认已在平台发布" }).click();
  await expect(page.getByRole("status")).toContainText("已记录本渠道发布结果");

  await page.reload();
  await page.getByRole("button", { name: "微博发布", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "微博正文" })).toHaveValue("微博渠道的独立文案");
  await expect(page.getByRole("checkbox", { name: "favicon-32x32.png" })).toBeChecked();
  await page.getByRole("button", { name: "图片素材", exact: true }).click();
  await page.getByRole("button", { name: "删除图片" }).click();
  const dialog = page.getByRole("dialog", { name: "删除图片确认" });
  await expect(dialog).toContainText("微博、即刻");
  await dialog.getByRole("button", { name: "确认删除" }).click();
  await expect(page.getByRole("status")).toContainText("图片已删除");
  const weibo = await (await page.request.get(`/api/v1/articles/${articleId}/channel-drafts/weibo`)).json();
  const jike = await (await page.request.get(`/api/v1/articles/${articleId}/channel-drafts/jike`)).json();
  expect(weibo.assetIds).toEqual([]);
  expect(weibo.status).toBe("draft");
  expect(weibo.lastPublication.current).toBe(false);
  expect(jike.assetIds).toEqual([]);
  expect(jike.status).toBe("draft");
  expect(jike.lastPublication.current).toBe(false);
  await page.getByRole("button", { name: "制作图片" }).click();
  await page.getByRole("combobox", { name: "图像服务" }).selectOption("gemini");
  await expect(page.getByRole("button", { name: "生成并保存图片" })).toBeDisabled();
  await page.getByRole("button", { name: "配置连接" }).click();
  await page.getByRole("textbox", { name: "Gemini API Key" }).fill("test-gemini-key-12345");
  await page.getByRole("button", { name: "保存 Key" }).click();
  await expect(page.getByText("Gemini 连接已配置")).toBeVisible();
  await expect(page.getByRole("button", { name: "生成并保存图片" })).toBeEnabled();
  await page.getByRole("button", { name: "管理连接" }).click();
  await page.getByRole("button", { name: "移除 Key" }).click();
  await expect(page.getByRole("button", { name: "生成并保存图片" })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1440);
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.getByRole("button", { name: "返回素材" })).toBeVisible();
  await expect.poll(() => page.locator(".workspace").evaluate((element) => Math.round(element.getBoundingClientRect().x))).toBe(0);
  await expect.poll(() => page.locator(".workspace").evaluate((element) => Math.round(element.getBoundingClientRect().width))).toBe(375);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});

test("a revised article can be reviewed before acknowledging the source revision", async ({ page }) => {
  const headers = { "x-ocf-client": "1" };
  const created = await page.request.post("/api/v1/articles", { headers,
    data: { title: `修订检查-${randomUUID().slice(0, 8)}`, summary: "原摘要", date: "2026-11-07", sourceRef: null } });
  const articleId = (await created.json()).id as string;
  await page.request.put(`/api/v1/articles/${articleId}/draft`, { headers,
    data: { expectedRevision: 0, markdown: "# 初稿\n\n原始内容" } });
  await page.request.post(`/api/v1/articles/${articleId}/finalize`, { headers, data: { expectedRevision: 1 } });
  await page.request.put(`/api/v1/articles/${articleId}/channel-drafts/weibo`, { headers,
    data: { expectedRevision: 0, content: { text: "已写好的微博", topics: "" }, status: "ready", assetIds: [] } });
  await page.request.put(`/api/v1/articles/${articleId}/draft`, { headers,
    data: { expectedRevision: 2, markdown: "# 修订稿\n\n新增的重要内容" } });
  await page.request.post(`/api/v1/articles/${articleId}/finalize`, { headers, data: { expectedRevision: 3 } });

  await page.goto(`/#publish/${articleId}`);
  await page.getByRole("button", { name: "微博发布", exact: true }).click();
  await expect(page.getByText("文章已更新到 v4")).toBeVisible();
  await page.getByText("查看文章新修订").click();
  await expect(page.locator(".pc-notice .pc-source-review pre")).toContainText("新增的重要内容");
  await page.getByRole("button", { name: "从文章提取文案建议" }).click();
  await expect(page.getByRole("region", { name: "文案建议预览" })).toContainText("新增的重要内容");
  await page.getByRole("region", { name: "文案建议预览" }).getByRole("button", { name: "采用建议到编辑区" }).click();
  await expect(page.getByRole("textbox", { name: "微博正文" })).toContainText("新增的重要内容");
  await expect(page.getByRole("button", { name: "已核对新修订" })).toBeDisabled();
  await page.getByRole("button", { name: "保存草稿" }).click();
  await page.getByRole("button", { name: "已核对新修订" }).click();
  await expect(page.getByRole("textbox", { name: "微博正文" })).toContainText("新增的重要内容");
  await expect(page.getByText("文章已更新到 v4")).toHaveCount(0);
});

test("channel fields stay locked while a save is in flight", async ({ page }) => {
  const headers = { "x-ocf-client": "1" };
  const created = await page.request.post("/api/v1/articles", { headers,
    data: { title: `保存中-${randomUUID().slice(0, 8)}`, summary: "并发编辑保护", date: "2026-11-07", sourceRef: null } });
  const articleId = (await created.json()).id as string;
  await page.request.put(`/api/v1/articles/${articleId}/draft`, { headers,
    data: { expectedRevision: 0, markdown: "# 保存中\n\n检查渠道稿" } });
  await page.request.post(`/api/v1/articles/${articleId}/finalize`, { headers, data: { expectedRevision: 1 } });
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  await page.route(`**/api/v1/articles/${articleId}/channel-drafts/weibo`, async (route) => {
    if (route.request().method() === "PUT") await gate;
    await route.continue();
  });
  await page.goto(`/#publish/${articleId}`);
  await page.getByRole("button", { name: "微博发布", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "微博正文" });
  await editor.fill("保存前的内容");
  await page.getByRole("button", { name: "保存草稿" }).click();
  try { await expect(editor).toBeDisabled(); }
  finally { release(); }
  await expect(page.getByRole("status")).toContainText("渠道稿已保存");
});

test("a finished refresh cannot replace a newly selected article", async ({ page }) => {
  const headers = { "x-ocf-client": "1" };
  async function finalArticle(title: string) {
    const created = await page.request.post("/api/v1/articles", { headers,
      data: { title, summary: "检查文章切换", date: "2026-11-07", sourceRef: null } });
    const id = (await created.json()).id as string;
    await page.request.put(`/api/v1/articles/${id}/draft`, { headers,
      data: { expectedRevision: 0, markdown: `# ${title}\n\n渠道稿内容` } });
    await page.request.post(`/api/v1/articles/${id}/finalize`, { headers, data: { expectedRevision: 1 } });
    return id;
  }
  const firstTitle = `切换前-${randomUUID().slice(0, 8)}`;
  const secondTitle = `切换后-${randomUUID().slice(0, 8)}`;
  const first = await finalArticle(firstTitle);
  const second = await finalArticle(secondTitle);
  await page.goto(`/#publish/${first}`);
  await page.getByRole("button", { name: "微博发布", exact: true }).click();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  let refreshStarted!: () => void;
  const started = new Promise<void>((resolveStarted) => { refreshStarted = resolveStarted; });
  await page.route(`**/api/v1/articles/${first}`, async (route) => {
    if (route.request().method() === "GET") { refreshStarted(); await gate; }
    await route.continue();
  });
  await page.getByRole("textbox", { name: "微博正文" }).fill("旧文章内容");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await started;
  await page.evaluate((id) => { location.hash = `#publish/${id}`; }, second);
  await expect(page.getByRole("heading", { name: secondTitle })).toBeVisible();
  const completed = page.waitForResponse((response) => response.url().endsWith(`/api/v1/articles/${first}`) && response.request().method() === "GET");
  release();
  await completed;
  await expect(page.getByRole("heading", { name: firstTitle })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: secondTitle })).toBeVisible();
});

test("a generated image is not requested again when the library refresh fails", async ({ page }) => {
  const headers = { "x-ocf-client": "1" };
  const created = await page.request.post("/api/v1/articles", { headers,
    data: { title: `生成后刷新-${randomUUID().slice(0, 8)}`, summary: "刷新异常保护", date: "2026-11-07", sourceRef: null } });
  const articleId = (await created.json()).id as string;
  await page.request.put(`/api/v1/articles/${articleId}/draft`, { headers,
    data: { expectedRevision: 0, markdown: "# 生成后刷新\n\n共享图片" } });
  await page.request.post(`/api/v1/articles/${articleId}/finalize`, { headers, data: { expectedRevision: 1 } });
  let generationCalls = 0;
  let failRefresh = true;
  await page.route(`**/api/v1/articles/${articleId}/publish-assets/generate`, async (route) => {
    generationCalls += 1;
    await route.fulfill({ status: 201, json: { id: "generated-asset", articleId, group: "vertical", name: "生成图片.png",
      mime: "image/png", origin: "generated", createdAt: new Date().toISOString(), usedBy: [] } });
  });
  await page.goto(`/#publish/${articleId}`);
  await page.getByRole("button", { name: "制作图片" }).click();
  await page.getByRole("combobox", { name: "图像服务" }).selectOption("gemini");
  await page.getByRole("button", { name: "配置连接" }).click();
  await page.getByRole("textbox", { name: "Gemini API Key" }).fill("test-gemini-key-12345");
  await page.getByRole("button", { name: "保存 Key" }).click();
  await page.route(`**/api/v1/articles/${articleId}/publish-assets`, async (route) => {
    if (route.request().method() === "GET" && failRefresh) {
      await route.fulfill({ status: 503, json: { error: "TEMPORARY_FAILURE" } });
      return;
    }
    await route.continue();
  });
  await page.getByRole("button", { name: "生成并保存图片" }).click();
  await expect(page.getByRole("status")).toContainText("图片已生成并保存，但素材列表刷新失败");
  await expect(page.getByRole("button", { name: "生成并保存图片" })).toBeDisabled();
  expect(generationCalls).toBe(1);
  failRefresh = false;
  await page.getByRole("button", { name: "重新载入素材" }).click();
  await expect(page.getByRole("status")).toContainText("素材列表已更新");
  expect(generationCalls).toBe(1);
});
