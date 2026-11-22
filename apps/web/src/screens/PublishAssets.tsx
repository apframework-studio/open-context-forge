import { useEffect, useState } from "react";
import { api, type Article, type ImageGenerationSettings, type PublishAsset, type WritingOutline } from "../api";
import { useLocale, type LocalizedNotice, type Translate } from "../locale";
import { buildImagePrompt } from "./image-prompt";

function looksLikeApiKey(value: string): boolean {
  const clean = value.trim();
  return /^(?:sk[-_]|aiza|akia|asia|eyj)/i.test(clean) || (clean.length >= 32 && /^[A-Za-z0-9]+$/.test(clean));
}

type ImageProvider = ImageGenerationSettings["providers"][number]["id"];

const imageProviderLabels: Record<ImageProvider, [string, string]> = {
  gemini: ["Gemini", "Gemini"],
  openai: ["GPT", "GPT"],
  volcengine: ["豆包", "Doubao"],
  aliyun: ["阿里云千问", "Alibaba Cloud Qwen"],
};

function imageProviderName(provider: string, t: Translate): string {
  return Object.hasOwn(imageProviderLabels, provider) ? t(...imageProviderLabels[provider as ImageProvider]) : t("图像服务", "Image service");
}

function englishModelLabel(label: string): string {
  return label.replace(" · 快速", " · Fast").replace(" · 均衡", " · Balanced")
    .replace(" · 精细", " · Detailed").replace(" · 兼容接口", " · Compatible API");
}

function imagePromptKey(articleId: string, group: PublishAsset["group"]): string {
  return `ocf-image-prompt:${articleId}:${group}`;
}

function readImagePrompt(articleId: string, group: PublishAsset["group"]): string | null {
  try { return sessionStorage.getItem(imagePromptKey(articleId, group)); }
  catch { return null; }
}

function rememberImagePrompt(articleId: string, group: PublishAsset["group"], value: string): void {
  try { sessionStorage.setItem(imagePromptKey(articleId, group), value); }
  catch { /* Editing still works when browser storage is unavailable. */ }
}

export function publishAssetUrl(asset: PublishAsset): string {
  return `/api/v1/articles/${encodeURIComponent(asset.articleId)}/publish-assets/${encodeURIComponent(asset.id)}/file`;
}

interface Props {
  article: Article;
  assets: PublishAsset[];
  onChanged: () => Promise<void>;
}

export function PublishImageWorkspace({ article, group = "vertical", onGenerated, onViewAsset }: { article: Article; group?: PublishAsset["group"];
  onGenerated?: (asset: PublishAsset) => Promise<void>; onViewAsset?: (asset: PublishAsset) => void }) {
  const { locale, t, noticeText } = useLocale();
  const [promptDraft, setPrompt] = useState(() => readImagePrompt(article.id, group));
  const prompt = promptDraft ?? t("制作一张竖屏首页图：资料逐渐汇成清晰的知识脉络，视觉简洁，留出标题空间。",
    "Create a portrait cover image showing scattered sources forming a clear thread. Keep it simple and leave room for a title.");
  const [settings, setSettings] = useState<ImageGenerationSettings | null>(null);
  const [key, setKey] = useState("");
  const [provider, setProvider] = useState<ImageGenerationSettings["providers"][number]["id"]>("gemini");
  const [aliyunRegion, setAliyunRegion] = useState<ImageGenerationSettings["aliyunRegion"]>("cn-beijing");
  const [openaiBaseUrl, setOpenaiBaseUrl] = useState("https://api.openai.com/v1");
  const [model, setModel] = useState("gemini-3.1-flash-lite-image");
  const [customModel, setCustomModel] = useState("");
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [customModelOpen, setCustomModelOpen] = useState(false);
  const [aspectRatio, setAspectRatio] = useState("9:16");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<LocalizedNotice | null>(null);
  const [generated, setGenerated] = useState<PublishAsset | null>(null);
  const [needsReload, setNeedsReload] = useState(false);

  useEffect(() => { void api<ImageGenerationSettings>("/image-generation/settings").then((value) => {
    setSettings(value); setAliyunRegion(value.aliyunRegion); setOpenaiBaseUrl(value.openaiBaseUrl);
    setProvider(value.providers.find((item) => item.configured)?.id ?? "gemini");
  })
    .catch((error) => setMessage([error, "图像服务状态加载失败", "Could not load image service settings."])); }, []);
  const selected = settings?.providers.find((item) => item.id === provider);
  const safeModels = selected?.models.filter((item) => !looksLikeApiKey(item.id));
  const providerLabel = imageProviderName(provider, t);
  const regionUnsaved = provider === "aliyun" && !!settings && aliyunRegion !== settings.aliyunRegion;
  const endpointUnsaved = provider === "openai" && !!settings && openaiBaseUrl !== settings.openaiBaseUrl;
  const selectedModel = safeModels?.find((item) => item.id === model);

  useEffect(() => {
    if (safeModels?.length && !safeModels.some((item) => item.id === model)) setModel(safeModels[0].id);
  }, [settings, provider, model]);

  function chooseProvider(value: ImageGenerationSettings["providers"][number]["id"]) {
    setProvider(value); setKey(""); setCustomModel(""); setConnectionOpen(false); setCustomModelOpen(false);
    setModel(settings?.providers.find((item) => item.id === value)?.models[0]?.id ?? "");
    setMessage(null);
  }

  async function saveKey() {
    setBusy(true); setMessage(null);
    try { const next = await api<ImageGenerationSettings>("/image-generation/settings", { method: "PUT", body: { provider, apiKey: key,
      ...(provider === "aliyun" ? { region: aliyunRegion } : {}), ...(provider === "openai" ? { baseUrl: openaiBaseUrl } : {}) } });
      setSettings(next); setOpenaiBaseUrl(next.openaiBaseUrl);
      setKey(""); setConnectionOpen(false);
      const [zhProvider, enProvider] = imageProviderLabels[provider];
      setMessage([`${zhProvider} API Key 已保存在本机`, `${enProvider} API key saved on this device.`]); }
    catch (error) { setMessage([error, "保存图像服务 Key 失败", "Could not save the image service key."]); }
    finally { setBusy(false); }
  }

  async function clearKey() {
    setBusy(true); setMessage(null);
    try { setSettings(await api<ImageGenerationSettings>(`/image-generation/settings?provider=${provider}`, { method: "DELETE" }));
      setKey(""); setConnectionOpen(false); setMessage(["已移除本机保存的图像服务 Key", "Image service key removed."]); }
    catch (error) { setMessage([error, "移除图像服务 Key 失败", "Could not remove the image service key."]); }
    finally { setBusy(false); }
  }

  async function addModel() {
    const value = customModel.trim();
    if (!value) return;
    setBusy(true); setMessage(null);
    try {
      const next = await api<ImageGenerationSettings>("/image-generation/models", { method: "POST", body: { provider, model: value } });
      setSettings(next); setModel(value); setCustomModel(""); setCustomModelOpen(false);
      const [zhProvider, enProvider] = imageProviderLabels[provider];
      setMessage([`已加入 ${zhProvider} 自定义模型列表`, `Custom model added for ${enProvider}.`]);
    } catch (error) { setMessage([error, "添加模型失败", "Could not add the model."]); }
    finally { setBusy(false); }
  }

  async function removeModel() {
    if (!selectedModel?.custom) return;
    setBusy(true); setMessage(null);
    try {
      const next = await api<ImageGenerationSettings>(`/image-generation/models?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}`, { method: "DELETE" });
      setSettings(next); setModel(next.providers.find((item) => item.id === provider)?.models[0]?.id ?? "");
      setMessage(["自定义模型已从列表移除，已生成图片仍保留", "Custom model removed. Existing images are still available."]);
    } catch (error) { setMessage([error, "移除模型失败", "Could not remove the model."]); }
    finally { setBusy(false); }
  }

  function updateCustomModel(value: string) {
    if (looksLikeApiKey(value)) {
      setCustomModel("");
      setMessage(["这看起来是 API Key，请在连接配置中填写；未保存为模型。", "This looks like an API key. Enter it in connection settings."]);
      return;
    }
    setCustomModel(value);
  }

  async function generate() {
    setBusy(true); setMessage(null);
    let asset: PublishAsset;
    try {
      asset = await api<PublishAsset>(`/articles/${article.id}/publish-assets/generate`, { method: "POST",
        body: { provider, group, prompt, model, aspectRatio } });
    } catch (error) {
      setMessage([error, "图片生成失败", "Could not generate the image."]);
      setBusy(false); return;
    }
    setGenerated(asset);
    try { await onGenerated?.(asset); setNeedsReload(false); setMessage(["图片已生成并保存到本篇素材库", "Image generated and saved to this article’s library."]); }
    catch { setNeedsReload(true); setMessage(["图片已生成并保存，但素材列表刷新失败；请重新载入，勿重复生成。", "Image saved. Reload the library to see it."]); }
    finally { setBusy(false); }
  }

  async function reloadAssets() {
    if (!generated) return;
    setBusy(true);
    try { await onGenerated?.(generated); setNeedsReload(false); setMessage(["素材列表已更新", "Image library refreshed."]); }
    catch { setMessage(["素材列表仍无法读取，请检查连接后重试。", "The image library is still unavailable. Check your connection and try again."]); }
    finally { setBusy(false); }
  }

  async function extractPrompt() {
    setBusy(true); setMessage(null);
    let outline = "";
    try {
      outline = (await api<WritingOutline>(`/articles/${article.id}/outline`)).markdown;
    } catch { /* Article title, summary and body are enough when an outline is unavailable. */ }
    const nextPrompt = buildImagePrompt(article, outline, locale);
    setPrompt(nextPrompt); rememberImagePrompt(article.id, group, nextPrompt);
    setMessage(["已从文章提取画面提示词，可继续修改后生成", "Prompt created from the article. You can edit it before generating."]);
    setBusy(false);
  }

  const connectionFields = connectionOpen && <div id="pc-connection-fields" className="pc-connection-fields"><p>{t("Key 只保存在本机；保存后不会再次显示。GPT 使用独立的 OpenAI API Key，与 Codex 套餐分开计费。", "The key is stored on this device and hidden after saving. GPT uses an OpenAI API key with separate billing from Codex.")}</p>
      {provider === "aliyun" && <label className="pc-field">{t("千问服务地域", "Qwen service region")}<select value={aliyunRegion} onChange={(event) => setAliyunRegion(event.target.value as typeof aliyunRegion)}>
        <option value="cn-beijing">{t("中国内地 · 北京", "China (Beijing)")}</option><option value="ap-southeast-1">{t("国际 · 新加坡", "Singapore (international)")}</option></select></label>}
      {provider === "openai" && <label className="pc-field">{t("GPT API 地址", "GPT API URL")}<input type="url" value={openaiBaseUrl} onChange={(event) => setOpenaiBaseUrl(event.target.value)}
        placeholder="https://api.openai.com/v1" /><small>{t("使用兼容接口时，Key 将发送到此地址；更改后需重新保存 Key。", "The key is sent to this URL. Save the key again if you change the address.")}</small></label>}
      <label className="pc-field">{providerLabel} API Key<input type="password" autoComplete="off" spellCheck={false} value={key} onChange={(event) => setKey(event.target.value)} placeholder={selected?.configured ? t("已配置；输入新 Key 可替换", "Enter a new key to replace the saved key") : t(`粘贴 ${providerLabel} API Key`, `Paste your ${providerLabel} API key`)} /></label>
      <div className="pc-actions"><button className="pc-button" disabled={busy || key.length < 10} onClick={() => void saveKey()}>{t("保存 Key", "Save key")}</button>
        {selected?.configured && <button className="pc-button" disabled={busy} onClick={() => void clearKey()}>{t("移除 Key", "Remove key")}</button>}
        <span className="pc-key-status">{selected?.configured ? t("已保存 Key，可尝试生成", "Key saved") : t("未配置", "Unconfigured")}</span></div></div>;

  const toggleConnection = () => { setConnectionOpen(!connectionOpen); if (connectionOpen) setKey(""); };

  return <div className="pc-create-grid"><div className="pc-create-main"><div className="pc-context pc-context-compact"><strong>{t("用于制作 ·", "Article")} {article.title}</strong>
    <span>{t("定稿", "Finalized")} v{article.revision}{article.summary ? ` · ${article.summary}` : ""}</span>
    <small>{t("生成时会把标题、摘要、正文前 8000 字和提示词发送给所选图像服务。", "The image service receives the title, summary, first 8,000 characters, and prompt.")}</small></div>
    {settings && !selected?.configured && <section className="pc-setup-card"><div className="pc-setup-top"><div><h3>{t(`先配置 ${providerLabel} 图像服务`, `Connect ${providerLabel}`)}</h3>
      <p>{t("只需设置一次，之后会自动收起，不影响日常制作。", "Set up the connection once to generate images.")}</p></div>
      <button className="pc-button" aria-expanded={connectionOpen} aria-controls="pc-connection-fields" disabled={busy} onClick={toggleConnection}>{t("配置连接", "Set up connection")}</button></div>
      {connectionFields}</section>}
    <div className="pc-generation-controls"><label className="pc-field">{t("图像服务", "Image service")}<select value={provider} disabled={busy} onChange={(event) => chooseProvider(event.target.value as typeof provider)}>
      {(settings?.providers ?? [{ id: "gemini" as const, label: "Gemini" }]).map((item) => <option key={item.id} value={item.id}>{imageProviderName(item.id, t)}</option>)}</select></label>
      <label className="pc-field">{t("图像模型", "Image model")}<select value={model} disabled={busy} onChange={(event) => setModel(event.target.value)}>
      {(safeModels ?? [{ id: model, label: t("Gemini 图片模型", "Gemini image model") }]).map((item) => <option key={item.id} value={item.id}>{item.custom ? t(`${item.label} · 自定义`, `${item.label} (custom)`) : (locale === "en" ? englishModelLabel(item.label) : item.label)}</option>)}</select></label>
      <label className="pc-field">{t("画幅比例", "Aspect ratio")}<select value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value)}><option>9:16</option><option>4:5</option><option>1:1</option><option>16:9</option></select></label></div>
    <div className="pc-control-utilities"><div className="pc-model-tools"><button className="pc-button pc-utility-button" aria-expanded={customModelOpen} aria-controls="pc-model-add-fields" disabled={busy}
      onClick={() => { setCustomModelOpen(!customModelOpen); if (customModelOpen) setCustomModel(""); }}>{t("添加自定义模型", "Add custom model")}</button>
      {selectedModel?.custom && <button className="pc-button pc-utility-button" disabled={busy} onClick={() => void removeModel()}>{t("移除自定义模型", "Remove custom model")}</button>}</div>
      {selected?.configured && <div className="pc-connection-summary"><span className="pc-key-status">{t(`${providerLabel} 连接已配置`, `${providerLabel} connected`)}</span>
        <button className="pc-button pc-utility-button" aria-expanded={connectionOpen} aria-controls="pc-connection-fields" disabled={busy} onClick={toggleConnection}>{t("管理连接", "Manage connection")}</button></div>}</div>
    {selected?.configured && connectionFields}
    {customModelOpen && <div id="pc-model-add-fields" className="pc-model-add"><label className="pc-field">{t("自定义模型 ID", "Custom model ID")}<input autoComplete="off" spellCheck={false}
      value={customModel} onChange={(event) => updateCustomModel(event.target.value)} placeholder={t("例如 gpt-image-2.6-flare；不要填 API Key", "Example: gpt-image-2.6-flare")} /></label>
      <button className="pc-button" disabled={busy || !customModel.trim()} onClick={() => void addModel()}>{t("添加模型", "Add model")}</button>
      <small className="pc-model-note">{t("只填写服务商提供的模型 ID。添加后保存在本机；是否可用以服务商响应为准。", "Enter a model ID from your provider. Wenmai saves it on this device.")}</small></div>}
    <div className="pc-prompt-heading"><label htmlFor="pc-image-prompt">{t("画面提示词", "Image prompt")}</label>
      <button className="pc-button pc-utility-button" disabled={busy} onClick={() => void extractPrompt()}>{t("从当前文章提取并替换提示词", "Replace with a prompt from this article")}</button></div>
    <textarea id="pc-image-prompt" className="pc-prompt-input" value={prompt} onChange={(event) => {
      setPrompt(event.target.value); rememberImagePrompt(article.id, group, event.target.value);
    }} />
    <div className="pc-generation-footer"><button className="pc-button pc-primary" disabled={busy || needsReload || !selected?.configured || !selectedModel || !prompt.trim() || !!key || regionUnsaved || endpointUnsaved} onClick={() => void generate()}>{busy ? t("正在处理…", "Working…") : t("生成并保存图片", "Generate and save")}</button>
      <small className="pc-generation-cost">{regionUnsaved ? t("千问地域已更改；请填入对应地域的 Key 并保存。", "Save an API key for the new Qwen region.") : endpointUnsaved ? t("GPT API 地址已更改；请确认地址并重新保存 Key。", "Check the new GPT API URL and save the key again.") : key ? t("请先保存输入的 Key，再生成图片。", "Save the key before generating.") : !selected?.configured ? t("连接图像服务后即可生成。", "Connect an image service to generate images.") : t(`每次生成都会调用你的 ${providerLabel} API，可能产生费用。`, `Your ${providerLabel} account may be charged for each image.`)}</small></div>
    {needsReload && <button className="pc-button" disabled={busy} onClick={() => void reloadAssets()}>{t("重新载入素材", "Reload library")}</button>}
    {message && <p className="pc-feedback" role="status">{noticeText(message)}</p>}</div>
    <div className="pc-candidate"><h3>{t("最近生成", "Last generated")}</h3>{generated ? <><img className="pc-generated-preview" src={publishAssetUrl(generated)} alt={generated.name} />
      <p>{generated.name}</p><button className="pc-button" onClick={() => onViewAsset?.(generated)}>{t("在素材库中查看", "View in library")}</button></> :
      <><p>{t("生成后可在导出预览中选为插图。", "Generated images can be selected in the export preview.")}</p><div className="pc-candidate-placeholder">{t("文章 + 提示词 → 图片", "Article + prompt → image")}</div></>}</div></div>;
}

export function PublishAssets({ article, assets, onChanged }: Props) {
  const { t, noticeText } = useLocale();
  const [group, setGroup] = useState<PublishAsset["group"]>("vertical");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [mode, setMode] = useState<"library" | "create">("library");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<LocalizedNotice | null>(null);
  const shown = assets.filter((item) => item.group === group);
  const selected = shown.find((item) => item.id === selectedId) ?? shown[0] ?? null;
  const deleting = assets.find((item) => item.id === deletingId) ?? null;
  const generatorName = imageProviderName(selected?.generation?.provider ?? "gemini", t);

  async function upload(files: FileList | null) {
    const selectedFiles = Array.from(files ?? []);
    if (!selectedFiles.length) return;
    setBusy(true); setMessage(null);
    let uploaded = 0;
    try {
      for (const file of selectedFiles) {
        const body = new FormData(); body.append("file", file);
        await api<PublishAsset>(`/articles/${article.id}/publish-assets?group=${group}`, { method: "POST", body });
        uploaded += 1;
      }
    } catch (error) {
      if (uploaded) {
        try { await onChanged(); } catch { /* The saved files remain available after reload. */ }
      }
      setMessage(uploaded ? [
        `已上传 ${uploaded} 张图片；其余上传失败：${error instanceof Error ? error.message : "请重试"}`,
        `Uploaded ${uploaded} ${uploaded === 1 ? "image" : "images"}. Try again with the remaining files.`,
      ] : [error, "图片上传失败", "Could not upload the images."]);
      setBusy(false); return;
    }
    try { await onChanged(); setMessage([`已上传 ${uploaded} 张图片`, `Uploaded ${uploaded} ${uploaded === 1 ? 'image' : 'images'}.`]); }
    catch { setMessage([`已上传 ${uploaded} 张图片，但素材列表刷新失败；请重新载入。`, `Uploaded ${uploaded} ${uploaded === 1 ? 'image' : 'images'}. Reload the library to see them.`]); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (!deleting) return;
    setBusy(true); setMessage(null);
    try {
      await api(`/articles/${article.id}/publish-assets/${deleting.id}`, { method: "DELETE" });
    } catch (error) {
      setMessage([error, "图片删除失败", "Could not delete the image."]);
      setBusy(false); return;
    }
    setDeletingId(null); setSelectedId(null);
    try { await onChanged(); setMessage(["图片已删除", "Image deleted."]); }
    catch { setMessage(["图片已删除，但素材列表刷新失败；请重新载入。", "Image deleted. Reload the library to refresh the list."]); }
    finally { setBusy(false); }
  }

  return <div className="pc-panel">
    <div className="pc-heading"><div><h2>{t("本篇图片素材", "Article images")}</h2><p>{t("可在导出预览中选择本篇插图。", "Choose illustrations in the export preview.")}</p></div>
      <div className="pc-actions"><label className="pc-button">{t("上传本地图片", "Upload images")}<input type="file" accept="image/png,image/jpeg,image/webp" multiple hidden disabled={busy}
        onChange={(event) => { void upload(event.target.files); event.target.value = ""; }} /></label>
        <button className="pc-button pc-primary" onClick={() => setMode(mode === "library" ? "create" : "library")}>{mode === "library" ? t("制作图片", "Create image") : t("返回素材", "Back to library")}</button></div></div>
    {mode === "create" ? <PublishImageWorkspace article={article} group={group} onGenerated={async () => { await onChanged(); }}
      onViewAsset={(asset) => { setGroup(asset.group); setSelectedId(asset.id); setMode("library"); }} /> : <>
      <div className="pc-group-tabs"><button className={group === "vertical" ? "active" : ""} onClick={() => { setGroup("vertical"); setSelectedId(null); }}>{t("竖版图片", "Portrait images")}</button>
        <button className={group === "article" ? "active" : ""} onClick={() => { setGroup("article"); setSelectedId(null); }}>{t("文章图片", "Article images")}</button></div>
      <div className="pc-assets-layout"><div className="pc-assets-grid">{shown.length ? shown.map((item) => <button key={item.id} className={`pc-asset-card ${selected?.id === item.id ? "selected" : ""}`}
        onClick={() => setSelectedId(item.id)}><img src={publishAssetUrl(item)} alt={item.name} /><strong>{item.name}</strong><small>{item.mime.replace("image/", "").toUpperCase()}</small></button>) :
        <div className="pc-empty">{t("这个分组还没有图片。", "No images in this group yet.")}</div>}</div>
        <aside className="pc-asset-detail"><h3>{t("素材详情", "Image details")}</h3>{selected ? <><img className="pc-detail-image" src={publishAssetUrl(selected)} alt={selected.name} />
          <strong>{selected.name}</strong><p>{t("来源：", "Source: ")}{selected.origin === "generated" ?
            t(`${generatorName} 生成`, `Generated with ${generatorName}`) :
            t("本地上传", "Uploaded from this device")}</p>
          {selected.generation && <><p>{t("模型：", "Model: ")}{selected.generation.model} · {selected.generation.aspectRatio}</p><p>{t("提示词：", "Prompt: ")}{selected.generation.prompt}</p></>}
          <button className="pc-button pc-danger" disabled={busy} onClick={() => setDeletingId(selected.id)}>{t("删除图片", "Delete image")}</button></> : <p>{t("选择图片查看详情", "Select an image to see its details.")}</p>}</aside></div></>}
    {deleting && <div className="modal-backdrop"><div className="confirm-modal" role="dialog" aria-modal="true" aria-label={t("删除图片确认", "Confirm image deletion")}><h2>{t(`删除“${deleting.name}”？`, `Delete “${deleting.name}”?`)}</h2>
      <p>{t("删除后将从本篇素材中移除。", "This removes the image from the article’s library.")}</p>
      <div className="pc-actions"><button className="pc-button" onClick={() => setDeletingId(null)}>{t("取消", "Cancel")}</button><button className="pc-button pc-danger" disabled={busy} onClick={() => void remove()}>{t("确认删除", "Delete")}</button></div></div></div>}
    {message && <p className="pc-feedback" role="status">{noticeText(message)}</p>}
  </div>;
}
