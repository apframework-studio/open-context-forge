import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isIP } from "node:net";
import type { ArticleStore } from "../articles/store.js";
import type { PublishAsset, PublishCenterStore } from "./center.js";

export const imageModels = [
  { id: "gemini-3.1-flash-lite-image", label: "Gemini 3.1 Flash Lite Image · 快速" },
  { id: "gemini-3.1-flash-image", label: "Gemini 3.1 Flash Image · 均衡" },
  { id: "gemini-3-pro-image", label: "Gemini 3 Pro Image · 精细" },
] as const;
export const imageProviders = [
  { id: "gemini", label: "Gemini", models: imageModels },
  { id: "openai", label: "GPT", models: [
    { id: "gpt-image-2.5-flare", label: "GPT Image 2.5 Flare · 快速" },
    { id: "gpt-image-2.5-sunburst", label: "GPT Image 2.5 Sunburst · 精细" },
    { id: "gpt-image-2", label: "GPT Image 2 · 兼容接口" },
  ] },
  { id: "volcengine", label: "豆包", models: [
    { id: "doubao-seedream-5-0-flash-260915", label: "Seedream 5.0 Flash · 快速" },
    { id: "doubao-seedream-5-0-pro-260628", label: "Seedream 5.0 Pro · 精细" },
  ] },
  { id: "aliyun", label: "阿里云千问", models: [
    { id: "qwen-image-3.0", label: "Qwen Image 3.0" },
    { id: "qwen-image-3.0-pro", label: "Qwen Image 3.0 Pro" },
  ] },
] as const;
type Provider = typeof imageProviders[number]["id"];
type Region = "cn-beijing" | "ap-southeast-1";
interface Config { apiKeys: Partial<Record<Provider, string>>; aliyunRegion: Region; openaiBaseUrl: string; customModels: Partial<Record<Provider, string[]>> }
const officialOpenaiBaseUrl = "https://api.openai.com/v1";

function validOpenaiBaseUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 300) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.port ||
      !url.hostname.includes(".") || isIP(url.hostname) || url.pathname.replace(/\/$/, "") !== "/v1") return null;
    return `${url.origin}/v1`;
  } catch { return null; }
}
const ratios = ["9:16", "4:5", "1:1", "16:9"] as const;
const sizes: Record<typeof ratios[number], string> = { "9:16": "1024x1824", "4:5": "1024x1280", "1:1": "1024x1024", "16:9": "1824x1024" };
const endpoint = "https://generativelanguage.googleapis.com/v1beta/interactions";

function providerId(value: unknown, code: "INVALID_IMAGE_SETTINGS" | "INVALID_IMAGE_REQUEST"): Provider {
  const id = value ?? "gemini";
  if (imageProviders.some((item) => item.id === id)) return id as Provider;
  throw new ImageGenerationError(code, 422);
}

function validModelId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 2 && value.length <= 120 &&
    /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(value) && !/^(?:sk[-_]|aiza|akia|asia|eyj)/i.test(value) &&
    !(value.length >= 32 && /^[A-Za-z0-9]+$/.test(value));
}

function firstImage(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const data = (value as Record<string, unknown>).data;
  return Array.isArray(data) && data[0] && typeof data[0] === "object" ? data[0] as Record<string, unknown> : null;
}

function decodeImage(value: unknown): Buffer {
  if (typeof value !== "string" || !value || value.length > 30 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))
    throw new ImageGenerationError("IMAGE_RESPONSE_INVALID", 502);
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new ImageGenerationError("IMAGE_RESPONSE_INVALID", 502);
  return bytes;
}

async function limitedImage(response: Response): Promise<Buffer> {
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > 20 * 1024 * 1024)
    throw new ImageGenerationError("IMAGE_RESPONSE_INVALID", 502);
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 20 * 1024 * 1024) throw new ImageGenerationError("IMAGE_RESPONSE_INVALID", 502);
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  if (!length) throw new ImageGenerationError("IMAGE_RESPONSE_INVALID", 502);
  return Buffer.concat(chunks);
}

export class ImageGenerationError extends Error {
  constructor(readonly code: "INVALID_IMAGE_SETTINGS" | "INVALID_IMAGE_MODEL" | "INVALID_IMAGE_REQUEST" | "IMAGE_KEY_MISSING" | "IMAGE_AUTH_FAILED" |
    "IMAGE_GENERATION_FAILED" | "IMAGE_RESPONSE_INVALID" | "ARTICLE_NOT_FINAL", readonly statusCode: number) { super(code); }
}

function imageBlock(value: unknown): { data: string; mime_type: string } | null {
  if (!value || typeof value !== "object") return null;
  const response = value as Record<string, unknown>;
  const root = response.interaction && typeof response.interaction === "object" ? response.interaction as Record<string, unknown> : response;
  const direct = root.output_image;
  if (direct && typeof direct === "object" && typeof (direct as Record<string, unknown>).data === "string") {
    const block = direct as Record<string, unknown>;
    return { data: block.data as string, mime_type: typeof block.mime_type === "string" ? block.mime_type : "image/png" };
  }
  if (!Array.isArray(root.steps)) return null;
  for (const step of root.steps) {
    if (!step || typeof step !== "object" || (step as Record<string, unknown>).type !== "model_output") continue;
    const content = (step as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && typeof block === "object" && (block as Record<string, unknown>).type === "image" && typeof (block as Record<string, unknown>).data === "string") {
        const image = block as Record<string, unknown>;
        return { data: image.data as string, mime_type: typeof image.mime_type === "string" ? image.mime_type : "image/png" };
      }
    }
  }
  return null;
}

export class ImageGenerationService {
  private readonly keyPath: string;
  constructor(dataDir: string, private readonly articles: ArticleStore, private readonly center: PublishCenterStore,
    private readonly request: typeof fetch = fetch) {
    this.keyPath = join(dataDir, "secrets", "image-generation.json");
  }

  private async config(): Promise<Config> {
    try {
      const value = JSON.parse(await readFile(this.keyPath, "utf8")) as Record<string, unknown>;
      const stored = value.apiKeys && typeof value.apiKeys === "object" ? value.apiKeys as Record<string, unknown> : {};
      const apiKeys: Config["apiKeys"] = {};
      for (const { id } of imageProviders) {
        const key = stored[id] ?? (id === "gemini" ? value.apiKey : undefined);
        if (typeof key === "string" && key) apiKeys[id] = key;
      }
      const storedModels = value.customModels && typeof value.customModels === "object" ? value.customModels as Record<string, unknown> : {};
      const customModels: Config["customModels"] = {};
      let needsScrub = Object.keys(storedModels).some((id) => !imageProviders.some((provider) => provider.id === id));
      for (const { id } of imageProviders) {
        const models = storedModels[id];
        if (Array.isArray(models)) {
          const clean = [...new Set(models.filter(validModelId))].slice(0, 30);
          customModels[id] = clean;
          if (clean.length !== models.length) needsScrub = true;
        } else if (models !== undefined) needsScrub = true;
      }
      const config: Config = { apiKeys, aliyunRegion: value.aliyunRegion === "ap-southeast-1" ? "ap-southeast-1" : "cn-beijing",
        openaiBaseUrl: validOpenaiBaseUrl(value.openaiBaseUrl) ?? officialOpenaiBaseUrl, customModels };
      if (needsScrub) await this.save(config);
      return config;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return { apiKeys: {}, aliyunRegion: "cn-beijing", openaiBaseUrl: officialOpenaiBaseUrl, customModels: {} };
      throw error;
    }
  }

  async status() {
    const config = await this.config();
    return { provider: "gemini" as const, configured: !!config.apiKeys.gemini, models: imageModels,
      providers: imageProviders.map(({ id, label, models }) => ({ id, label, models: [
        ...models, ...(config.customModels[id] ?? []).filter((model) => !models.some((builtin) => builtin.id === model))
          .map((model) => ({ id: model, label: model, custom: true as const })),
      ], configured: !!config.apiKeys[id] })),
      aliyunRegion: config.aliyunRegion, openaiBaseUrl: config.openaiBaseUrl };
  }

  private async save(config: Config): Promise<void> {
    const directory = dirname(this.keyPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporary = `${this.keyPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(config), { flag: "wx", mode: 0o600 });
      await rename(temporary, this.keyPath);
      await chmod(this.keyPath, 0o600);
    } finally { await rm(temporary, { force: true }); }
  }

  async configure(input: unknown) {
    const fields = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
    const provider = providerId(fields.provider, "INVALID_IMAGE_SETTINGS");
    const value = fields.apiKey;
    if (typeof value !== "string" || value.length < 10 || value.length > 500 || /\s/.test(value) ||
      (fields.region !== undefined && (provider !== "aliyun" || (fields.region !== "cn-beijing" && fields.region !== "ap-southeast-1"))) ||
      (fields.baseUrl !== undefined && (provider !== "openai" || !validOpenaiBaseUrl(fields.baseUrl)))) {
      throw new ImageGenerationError("INVALID_IMAGE_SETTINGS", 422);
    }
    const config = await this.config();
    config.apiKeys[provider] = value;
    if (provider === "aliyun" && fields.region) config.aliyunRegion = fields.region as Region;
    if (provider === "openai" && fields.baseUrl) config.openaiBaseUrl = validOpenaiBaseUrl(fields.baseUrl) as string;
    await this.save(config);
    return this.status();
  }

  async clear(value?: unknown) {
    const provider = providerId(value, "INVALID_IMAGE_SETTINGS");
    const config = await this.config();
    delete config.apiKeys[provider];
    await this.save(config);
    return this.status();
  }

  async addModel(input: unknown) {
    const fields = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
    const provider = providerId(fields.provider, "INVALID_IMAGE_SETTINGS");
    const model = fields.model;
    if (!validModelId(model) || imageProviders.some((item) => item.models.some((builtin) => builtin.id === model)))
      throw new ImageGenerationError("INVALID_IMAGE_MODEL", 422);
    const config = await this.config();
    const models = config.customModels[provider] ?? [];
    if (!models.includes(model)) {
      if (models.length >= 30) throw new ImageGenerationError("INVALID_IMAGE_MODEL", 422);
      config.customModels[provider] = [...models, model];
      await this.save(config);
    }
    return this.status();
  }

  async removeModel(providerValue: unknown, modelValue: unknown) {
    const provider = providerId(providerValue, "INVALID_IMAGE_SETTINGS");
    if (!validModelId(modelValue)) throw new ImageGenerationError("INVALID_IMAGE_MODEL", 422);
    const config = await this.config();
    const models = config.customModels[provider] ?? [];
    if (!models.includes(modelValue)) throw new ImageGenerationError("INVALID_IMAGE_MODEL", 422);
    config.customModels[provider] = models.filter((model) => model !== modelValue);
    await this.save(config);
    return this.status();
  }

  async generate(articleId: string, input: unknown): Promise<PublishAsset> {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new ImageGenerationError("INVALID_IMAGE_REQUEST", 422);
    const { group, prompt, model, aspectRatio } = input as Record<string, unknown>;
    const provider = providerId((input as Record<string, unknown>).provider, "INVALID_IMAGE_REQUEST");
    const config = await this.config();
    if ((group !== "vertical" && group !== "article") || typeof prompt !== "string" || !prompt.trim() || prompt.length > 4_000 ||
      !validModelId(model) || !(imageProviders.find((item) => item.id === provider)?.models.some((item) => item.id === model) ||
        (config.customModels[provider] ?? []).includes(model)) || !ratios.includes(aspectRatio as typeof ratios[number])) {
      throw new ImageGenerationError("INVALID_IMAGE_REQUEST", 422);
    }
    const article = await this.articles.get(articleId);
    if (article.status !== "final") throw new ImageGenerationError("ARTICLE_NOT_FINAL", 409);
    const apiKey = config.apiKeys[provider];
    if (!apiKey) throw new ImageGenerationError("IMAGE_KEY_MISSING", 409);
    const composed = `请根据以下文章制作一张可用于社交渠道的图片。保持图像清晰，避免虚构文章没有提到的事实。\n\n文章标题：${article.title}\n摘要：${article.summary}\n正文节选：${article.markdown.slice(0, 8_000)}\n\n画面要求：${prompt.trim()}`;
    const size = sizes[aspectRatio as typeof ratios[number]];
    const url = provider === "gemini" ? endpoint : provider === "openai" ? `${config.openaiBaseUrl}/images/generations` :
      provider === "volcengine" ? "https://ark.cn-beijing.volces.com/api/v3/images/generations" :
      config.aliyunRegion === "cn-beijing" ? "https://dashscope.aliyuncs.com/compatible-mode/v1/images/generations" :
      "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/images/generations";
    const body = provider === "gemini" ? { model, input: composed, response_format: { type: "image", mime_type: "image/png", aspect_ratio: aspectRatio, image_size: "1K" } } :
      provider === "openai" ? { model, prompt: composed, n: 1, size, output_format: "png", ...(model === "gpt-image-2" ? { quality: "medium" } : {}) } :
      provider === "volcengine" ? { model, prompt: composed, size, output_format: "png", response_format: "b64_json" } :
      { model, prompt: composed, size, n: 1 };
    let response: Response;
    try {
      response = await this.request(url, { method: "POST", headers: { ...(provider === "gemini" ? { "x-goog-api-key": apiKey } : { authorization: `Bearer ${apiKey}` }),
        "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(provider === "aliyun" ? 300_000 : provider === "openai" ? 180_000 : 120_000) });
    } catch { throw new ImageGenerationError("IMAGE_GENERATION_FAILED", 502); }
    if (!response.ok) throw new ImageGenerationError(response.status === 401 || response.status === 403 ? "IMAGE_AUTH_FAILED" : "IMAGE_GENERATION_FAILED", response.status === 401 || response.status === 403 ? 401 : 502);
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new ImageGenerationError("IMAGE_RESPONSE_INVALID", 502); }
    let bytes: Buffer;
    try {
      if (provider === "gemini") bytes = decodeImage(imageBlock(payload)?.data);
      else if (provider === "aliyun") {
        const address = firstImage(payload)?.url;
        if (typeof address !== "string") throw new ImageGenerationError("IMAGE_RESPONSE_INVALID", 502);
        const imageUrl = new URL(address);
        if (imageUrl.protocol !== "https:" || imageUrl.username || imageUrl.password || !imageUrl.hostname.endsWith(".aliyuncs.com"))
          throw new ImageGenerationError("IMAGE_RESPONSE_INVALID", 502);
        const imageResponse = await this.request(imageUrl, { redirect: "error", signal: AbortSignal.timeout(30_000) });
        bytes = await limitedImage(imageResponse);
      } else bytes = decodeImage(firstImage(payload)?.b64_json);
    } catch (error) {
      if (error instanceof ImageGenerationError) throw error;
      throw new ImageGenerationError("IMAGE_RESPONSE_INVALID", 502);
    }
    try {
      return await this.center.createGeneratedAsset(articleId, { provider, group, prompt: prompt.trim(), model: model as string,
        aspectRatio: aspectRatio as string, sourceRevision: article.revision }, "image/png", bytes);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "INVALID_ASSET") throw new ImageGenerationError("IMAGE_RESPONSE_INVALID", 502);
      throw error;
    }
  }
}
