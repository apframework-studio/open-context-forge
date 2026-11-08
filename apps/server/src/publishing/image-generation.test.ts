import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createApp } from "../app.js";

const headers = { "x-ocf-client": "1" };
const png = readFileSync(new URL("../../../web/public/favicon-32x32.png", import.meta.url));

async function finalArticle(app: ReturnType<typeof createApp>) {
  const created = await app.inject({ method: "POST", url: "/api/v1/articles", headers,
    payload: { title: "基于文章制作封面", summary: "一份可复用的渠道图片", date: "2026-11-07", sourceRef: null } });
  const id = created.json().id as string;
  await app.inject({ method: "PUT", url: `/api/v1/articles/${id}/draft`, headers,
    payload: { expectedRevision: 0, markdown: "# 文章正文\n\n这是生成图片时应参考的文章内容。" } });
  await app.inject({ method: "POST", url: `/api/v1/articles/${id}/finalize`, headers, payload: { expectedRevision: 1 } });
  return id;
}

test("image key stays server-side and a generated image becomes reusable article media", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-image-main-"));
  let requestBody: Record<string, unknown> | null = null;
  let providerKey = "";
  const app = createApp({ dataDir, imageFetch: async (_url, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    providerKey = String(new Headers(init?.headers).get("x-goog-api-key"));
    return new Response(JSON.stringify({ steps: [{ type: "model_output", content: [{ type: "image", mime_type: "image/png", data: png.toString("base64") }] }] }),
      { status: 200, headers: { "content-type": "application/json" } });
  } });
  try {
    const id = await finalArticle(app);
    const path = `/api/v1/articles/${id}/publish-assets/generate`;
    const input = { group: "vertical", prompt: "留出醒目的标题空间，采用温暖的蓝绿色", model: "gemini-3.1-flash-lite-image", aspectRatio: "9:16" };
    const noKey = await app.inject({ method: "POST", url: path, headers, payload: input });
    expect(noKey.statusCode).toBe(409);
    expect((await app.inject({ url: `/api/v1/articles/${id}/publish-assets` })).json().items).toEqual([]);

    const configured = await app.inject({ method: "PUT", url: "/api/v1/image-generation/settings", headers, payload: { apiKey: "test-gemini-key-12345" } });
    expect(configured.statusCode).toBe(200);
    expect(configured.body).not.toContain("test-gemini-key-12345");
    expect(configured.json()).toMatchObject({ configured: true, provider: "gemini" });
    expect(statSync(join(dataDir, "secrets", "image-generation.json")).mode & 0o777).toBe(0o600);
    expect((await app.inject({ url: "/api/v1/image-generation/settings" })).body).not.toContain("test-gemini-key-12345");
    const reopened = createApp({ dataDir });
    try { expect((await reopened.inject({ url: "/api/v1/image-generation/settings" })).json().configured).toBe(true); }
    finally { await reopened.close(); }
    const generated = await app.inject({ method: "POST", url: path, headers, payload: input });
    expect(generated.statusCode).toBe(201);
    expect(providerKey).toBe("test-gemini-key-12345");
    expect(requestBody).toMatchObject({ model: input.model, response_format: { type: "image", aspect_ratio: "9:16" } });
    expect(JSON.stringify(requestBody)).toContain("这是生成图片时应参考的文章内容");
    const asset = generated.json();
    expect(asset).toMatchObject({ articleId: id, group: "vertical", origin: "generated", mime: "image/png",
      generation: { model: input.model, prompt: input.prompt, sourceRevision: 2, aspectRatio: "9:16" } });
    const file = await app.inject({ url: `/api/v1/articles/${id}/publish-assets/${asset.id}/file` });
    expect(file.rawPayload).toEqual(png);
    expect((await app.inject({ url: `/api/v1/articles/${id}/publish-assets` })).json().items).toHaveLength(1);
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("generation failure writes no media and deleting the configured key disables generation", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-image-fail-"));
  let malformed = false;
  const app = createApp({ dataDir, imageFetch: async () => malformed ? new Response(JSON.stringify({ steps: [{ type: "model_output", content: [{ type: "image", data: "invalid" }] }] }), { status: 200 }) :
    new Response(JSON.stringify({ error: { message: "provider details" } }), { status: 503 }) });
  try {
    const id = await finalArticle(app);
    const settings = "/api/v1/image-generation/settings";
    const path = `/api/v1/articles/${id}/publish-assets/generate`;
    const input = { group: "vertical", prompt: "知识脉络", model: "gemini-3.1-flash-image", aspectRatio: "4:5" };
    await app.inject({ method: "PUT", url: settings, headers, payload: { apiKey: "test-gemini-key-12345" } });
    const failed = await app.inject({ method: "POST", url: path, headers, payload: input });
    expect(failed.statusCode).toBe(502);
    expect(failed.body).not.toContain("provider details");
    expect((await app.inject({ url: `/api/v1/articles/${id}/publish-assets` })).json().items).toEqual([]);
    malformed = true;
    expect((await app.inject({ method: "POST", url: path, headers, payload: input })).statusCode).toBe(502);
    expect((await app.inject({ url: `/api/v1/articles/${id}/publish-assets` })).json().items).toEqual([]);
    const invalid = await app.inject({ method: "POST", url: path, headers, payload: { ...input, model: "unknown-model" } });
    expect(invalid.statusCode).toBe(422);
    expect((await app.inject({ method: "DELETE", url: settings, headers })).json()).toMatchObject({ configured: false });
    expect((await app.inject({ method: "POST", url: path, headers, payload: input })).statusCode).toBe(409);
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("provider keys stay independent and each provider uses its own image API", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-image-providers-"));
  const calls: { url: string; body: Record<string, unknown>; authorization: string | null }[] = [];
  const app = createApp({ dataDir, imageFetch: async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      authorization: new Headers(init?.headers).get("authorization") });
    return new Response(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }), { status: 200 });
  } });
  try {
    const id = await finalArticle(app);
    const settings = "/api/v1/image-generation/settings";
    for (const provider of ["openai", "volcengine"] as const) {
      const configured = await app.inject({ method: "PUT", url: settings, headers, payload: { provider, apiKey: `test-${provider}-key-12345` } });
      expect(configured.statusCode).toBe(200);
      expect(configured.body).not.toContain(`test-${provider}-key-12345`);
    }
    const current = (await app.inject({ url: settings })).json();
    expect(current.providers.find((item: { id: string }) => item.id === "openai").configured).toBe(true);
    expect(current.providers.find((item: { id: string }) => item.id === "volcengine").configured).toBe(true);
    expect(current.providers.find((item: { id: string }) => item.id === "gemini").configured).toBe(false);
    for (const [provider, model] of [["openai", "gpt-image-2.5-flare"], ["volcengine", "doubao-seedream-5-0-flash-260915"]] as const) {
      const result = await app.inject({ method: "POST", url: `/api/v1/articles/${id}/publish-assets/generate`, headers,
        payload: { provider, model, group: "vertical", prompt: "知识封面", aspectRatio: "16:9" } });
      expect(result.statusCode).toBe(201);
      expect(result.json().generation.provider).toBe(provider);
    }
    expect(calls[0]).toMatchObject({ url: "https://api.openai.com/v1/images/generations", authorization: "Bearer test-openai-key-12345",
      body: { model: "gpt-image-2.5-flare", size: "1824x1024", output_format: "png" } });
    expect(calls[1]).toMatchObject({ url: "https://ark.cn-beijing.volces.com/api/v3/images/generations", authorization: "Bearer test-volcengine-key-12345",
      body: { model: "doubao-seedream-5-0-flash-260915", size: "1824x1024", response_format: "b64_json" } });
    await app.inject({ method: "DELETE", url: `${settings}?provider=openai`, headers });
    const after = (await app.inject({ url: settings })).json();
    expect(after.providers.find((item: { id: string }) => item.id === "openai").configured).toBe(false);
    expect(after.providers.find((item: { id: string }) => item.id === "volcengine").configured).toBe(true);
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("Qwen downloads its short-lived image URL from an allowed host and rejects other hosts", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-image-qwen-"));
  let imageHost = "dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com";
  const calls: string[] = [];
  const app = createApp({ dataDir, imageFetch: async (url, init) => {
    calls.push(String(url));
    if (init?.method === "POST") return new Response(JSON.stringify({ data: [{ url: `https://${imageHost}/result.png` }] }), { status: 200 });
    expect(init?.redirect).toBe("error");
    return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
  } });
  try {
    const id = await finalArticle(app);
    await app.inject({ method: "PUT", url: "/api/v1/image-generation/settings", headers,
      payload: { provider: "aliyun", apiKey: "test-aliyun-key-12345", region: "ap-southeast-1" } });
    const path = `/api/v1/articles/${id}/publish-assets/generate`;
    const input = { provider: "aliyun", model: "qwen-image-3.0", group: "vertical", prompt: "知识封面", aspectRatio: "9:16" };
    const generated = await app.inject({ method: "POST", url: path, headers, payload: input });
    expect(generated.statusCode).toBe(201);
    expect(generated.json().generation.provider).toBe("aliyun");
    expect(calls[0]).toBe("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/images/generations");
    expect(calls[1]).toContain(".aliyuncs.com/result.png");
    imageHost = "example.com";
    const rejected = await app.inject({ method: "POST", url: path, headers, payload: input });
    expect(rejected.statusCode).toBe(502);
    expect(calls).toHaveLength(3);
    expect((await app.inject({ url: `/api/v1/articles/${id}/publish-assets` })).json().items).toHaveLength(1);
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("an existing Gemini key migrates when another provider is configured", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-image-legacy-"));
  mkdirSync(join(dataDir, "secrets"));
  writeFileSync(join(dataDir, "secrets", "image-generation.json"), JSON.stringify({ apiKey: "legacy-gemini-key-12345" }), { mode: 0o600 });
  const app = createApp({ dataDir });
  try {
    const settings = "/api/v1/image-generation/settings";
    expect((await app.inject({ url: settings })).json().configured).toBe(true);
    await app.inject({ method: "PUT", url: settings, headers, payload: { provider: "openai", apiKey: "new-openai-key-12345" } });
    const current = (await app.inject({ url: settings })).json();
    expect(current.providers.find((item: { id: string }) => item.id === "gemini").configured).toBe(true);
    expect(current.providers.find((item: { id: string }) => item.id === "openai").configured).toBe(true);
    expect(statSync(join(dataDir, "secrets", "image-generation.json")).mode & 0o777).toBe(0o600);
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("GPT accepts an explicit HTTPS compatible endpoint and gpt-image-2", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-image-gpt-proxy-"));
  let requestedUrl = "";
  let requestBody: Record<string, unknown> = {};
  const app = createApp({ dataDir, imageFetch: async (url, init) => {
    requestedUrl = String(url);
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }), { status: 200 });
  } });
  try {
    const settings = "/api/v1/image-generation/settings";
    const invalid = await app.inject({ method: "PUT", url: settings, headers,
      payload: { provider: "openai", apiKey: "test-proxy-key-12345", baseUrl: "http://localhost:9999/v1" } });
    expect(invalid.statusCode).toBe(422);
    const configured = await app.inject({ method: "PUT", url: settings, headers,
      payload: { provider: "openai", apiKey: "test-proxy-key-12345", baseUrl: "https://images.example.com/v1" } });
    expect(configured.statusCode).toBe(200);
    expect(configured.json().openaiBaseUrl).toBe("https://images.example.com/v1");
    const id = await finalArticle(app);
    const generated = await app.inject({ method: "POST", url: `/api/v1/articles/${id}/publish-assets/generate`, headers,
      payload: { provider: "openai", model: "gpt-image-2", group: "vertical", prompt: "资料封面", aspectRatio: "9:16" } });
    expect(generated.statusCode).toBe(201);
    expect(requestedUrl).toBe("https://images.example.com/v1/images/generations");
    expect(requestBody).toMatchObject({ model: "gpt-image-2", size: "1024x1824", quality: "medium" });
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("custom model can be selected later for its provider and removed without deleting generated media", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-image-custom-model-"));
  let sentModel = "";
  const app = createApp({ dataDir, imageFetch: async (_url, init) => {
    sentModel = (JSON.parse(String(init?.body)) as { model: string }).model;
    return new Response(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }), { status: 200 });
  } });
  try {
    const model = "gpt-image-2.6-flare", provider = "openai";
    const added = await app.inject({ method: "POST", url: "/api/v1/image-generation/models", headers, payload: { provider, model } });
    expect(added.statusCode).toBe(200);
    expect(added.json().providers.find((item: { id: string }) => item.id === provider).models).toContainEqual({ id: model, label: model, custom: true });
    expect((await app.inject({ method: "POST", url: "/api/v1/image-generation/models", headers,
      payload: { provider: "aliyun", model: "gpt-image-2.5-flare" } })).statusCode).toBe(422);
    const reopened = createApp({ dataDir });
    try { expect((await reopened.inject({ url: "/api/v1/image-generation/settings" })).json().providers
      .find((item: { id: string }) => item.id === provider).models).toContainEqual({ id: model, label: model, custom: true }); }
    finally { await reopened.close(); }
    const id = await finalArticle(app);
    await app.inject({ method: "PUT", url: "/api/v1/image-generation/settings", headers,
      payload: { provider, apiKey: "test-openai-key-12345" } });
    const path = `/api/v1/articles/${id}/publish-assets/generate`;
    const input = { provider, model, group: "vertical", prompt: "知识封面", aspectRatio: "9:16" };
    const generated = await app.inject({ method: "POST", url: path, headers, payload: input });
    expect(generated.statusCode).toBe(201);
    expect(sentModel).toBe(model);
    const removed = await app.inject({ method: "DELETE", url: `/api/v1/image-generation/models?provider=${provider}&model=${model}`, headers });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().providers.find((item: { id: string }) => item.id === provider).models).not.toContainEqual({ id: model, label: model, custom: true });
    expect((await app.inject({ method: "POST", url: path, headers, payload: input })).statusCode).toBe(422);
    expect((await app.inject({ url: `/api/v1/articles/${id}/publish-assets` })).json().items[0].generation.model).toBe(model);
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("a pasted API key is rejected as a model and never returned in settings", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-image-secret-model-"));
  const app = createApp({ dataDir });
  try {
    const mistakenKey = "sk-test-accidentally-pasted-api-key-123456789";
    const added = await app.inject({ method: "POST", url: "/api/v1/image-generation/models", headers,
      payload: { provider: "openai", model: mistakenKey } });
    expect(added.statusCode).toBe(422);
    expect(added.body).not.toContain(mistakenKey);
    const settings = await app.inject({ url: "/api/v1/image-generation/settings" });
    expect(settings.body).not.toContain(mistakenKey);
    const opaqueKey = "A7b9C2d4E6f8G1h3I5j7K9m2N4p6Q8r1S3t5U7v9W2x4";
    const opaque = await app.inject({ method: "POST", url: "/api/v1/image-generation/models", headers,
      payload: { provider: "volcengine", model: opaqueKey } });
    expect(opaque.statusCode).toBe(422);
    expect(opaque.body).not.toContain(opaqueKey);
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

test("reading legacy settings scrubs a secret previously saved as a custom model", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ocf-image-secret-migration-"));
  const secretPath = join(dataDir, "secrets", "image-generation.json");
  const mistakenKey = "sk-test-legacy-accidental-key-123456789";
  const opaqueKey = "A7b9C2d4E6f8G1h3I5j7K9m2N4p6Q8r1S3t5U7v9W2x4";
  mkdirSync(join(dataDir, "secrets"));
  writeFileSync(secretPath, JSON.stringify({ apiKeys: {}, aliyunRegion: "cn-beijing", openaiBaseUrl: "https://api.openai.com/v1",
    customModels: { openai: [mistakenKey, opaqueKey, "gpt-image-2.6-flare"] } }), { mode: 0o600 });
  const app = createApp({ dataDir });
  try {
    const settings = await app.inject({ url: "/api/v1/image-generation/settings" });
    expect(settings.body).not.toContain(mistakenKey);
    expect(settings.body).not.toContain(opaqueKey);
    expect(settings.json().providers.find((item: { id: string }) => item.id === "openai").models)
      .toContainEqual({ id: "gpt-image-2.6-flare", label: "gpt-image-2.6-flare", custom: true });
    expect(readFileSync(secretPath, "utf8")).not.toContain(mistakenKey);
    expect(readFileSync(secretPath, "utf8")).not.toContain(opaqueKey);
    expect(statSync(secretPath).mode & 0o777).toBe(0o600);
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});
