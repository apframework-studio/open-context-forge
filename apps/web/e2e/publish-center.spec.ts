import { randomUUID } from "node:crypto";
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

test("an unfinished image prompt survives returning to the asset library", async ({ page }) => {
  const headers = { "x-ocf-client": "1" };
  const created = await page.request.post("/api/v1/articles", { headers,
    data: { title: `提示词切换-${randomUUID().slice(0, 8)}`, summary: "检查提示词草稿", date: "2026-11-08", sourceRef: null } });
  const id = (await created.json()).id as string;
  await page.request.put(`/api/v1/articles/${id}/draft`, { headers,
    data: { expectedRevision: 0, markdown: "# 提示词切换\n\n文章正文。" } });
  await page.request.post(`/api/v1/articles/${id}/finalize`, { headers, data: { expectedRevision: 1 } });
  await page.goto(`/#publish/${id}`);
  await page.getByRole("button", { name: "图片素材", exact: true }).click();
  await page.getByRole("button", { name: "制作图片" }).click();
  await page.getByRole("textbox", { name: "画面提示词" }).fill("暖色调的知识地图，中心留标题区域");
  await page.getByRole("button", { name: "返回素材" }).click();
  await page.getByRole("button", { name: "制作图片" }).click();
  await expect(page.getByRole("textbox", { name: "画面提示词" })).toHaveValue("暖色调的知识地图，中心留标题区域");
  await page.reload();
  await page.getByRole("button", { name: "图片素材", exact: true }).click();
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
  await page.getByRole("button", { name: "图片素材", exact: true }).click();
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
  await page.getByRole("button", { name: "图片素材", exact: true }).click();
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
  await page.getByRole("button", { name: "图片素材", exact: true }).click();
  await page.getByRole("button", { name: "制作图片" }).click();
  await page.getByRole("combobox", { name: "图像服务" }).selectOption("openai");
  await page.getByRole("button", { name: "添加自定义模型" }).click();
  await page.getByRole("textbox", { name: "自定义模型 ID" }).fill("gpt-image-2.6-flare");
  await page.getByRole("button", { name: "添加模型" }).click();
  await expect(page.getByRole("combobox", { name: "图像模型" })).toHaveValue("gpt-image-2.6-flare");
  await page.reload();
  await page.getByRole("button", { name: "图片素材", exact: true }).click();
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
  await page.getByRole("button", { name: "图片素材", exact: true }).click();
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
  await page.getByRole("button", { name: "图片素材", exact: true }).click();
  await page.getByRole("button", { name: "制作图片" }).click();
  await expect(page.getByRole("combobox", { name: "图像服务" })).toHaveValue("openai");
  await page.getByRole("button", { name: "管理连接" }).click();
  await page.getByRole("button", { name: "移除 Key" }).click();
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
  await page.getByRole("button", { name: "图片素材", exact: true }).click();
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
