import { useEffect, useState } from "react";
import { api, type Article, type ImageGenerationSettings, type PublishAsset, type WritingOutline } from "../api";
import { buildImagePrompt } from "./image-prompt";

function looksLikeApiKey(value: string): boolean {
  const clean = value.trim();
  return /^(?:sk[-_]|aiza|akia|asia|eyj)/i.test(clean) || (clean.length >= 32 && /^[A-Za-z0-9]+$/.test(clean));
}

const defaultImagePrompt = "制作一张竖屏首页图：资料逐渐汇成清晰的知识脉络，视觉简洁，留出标题空间。";

function imagePromptKey(articleId: string, group: PublishAsset["group"]): string {
  return `ocf-image-prompt:${articleId}:${group}`;
}

function readImagePrompt(articleId: string, group: PublishAsset["group"]): string {
  try { return sessionStorage.getItem(imagePromptKey(articleId, group)) ?? defaultImagePrompt; }
  catch { return defaultImagePrompt; }
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
  const [prompt, setPrompt] = useState(() => readImagePrompt(article.id, group));
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
  const [message, setMessage] = useState("");
  const [generated, setGenerated] = useState<PublishAsset | null>(null);
  const [needsReload, setNeedsReload] = useState(false);

  useEffect(() => { void api<ImageGenerationSettings>("/image-generation/settings").then((value) => {
    setSettings(value); setAliyunRegion(value.aliyunRegion); setOpenaiBaseUrl(value.openaiBaseUrl);
    setProvider(value.providers.find((item) => item.configured)?.id ?? "gemini");
  })
    .catch((error) => setMessage(error instanceof Error ? error.message : "图像服务状态加载失败")); }, []);
  const selected = settings?.providers.find((item) => item.id === provider);
  const safeModels = selected?.models.filter((item) => !looksLikeApiKey(item.id));
  const providerLabel = selected?.label ?? "Gemini";
  const regionUnsaved = provider === "aliyun" && !!settings && aliyunRegion !== settings.aliyunRegion;
  const endpointUnsaved = provider === "openai" && !!settings && openaiBaseUrl !== settings.openaiBaseUrl;
  const selectedModel = safeModels?.find((item) => item.id === model);

  useEffect(() => {
    if (safeModels?.length && !safeModels.some((item) => item.id === model)) setModel(safeModels[0].id);
  }, [settings, provider, model]);

  function chooseProvider(value: ImageGenerationSettings["providers"][number]["id"]) {
    setProvider(value); setKey(""); setCustomModel(""); setConnectionOpen(false); setCustomModelOpen(false);
    setModel(settings?.providers.find((item) => item.id === value)?.models[0]?.id ?? "");
    setMessage("");
  }

  async function saveKey() {
    setBusy(true); setMessage("");
    try { const next = await api<ImageGenerationSettings>("/image-generation/settings", { method: "PUT", body: { provider, apiKey: key,
      ...(provider === "aliyun" ? { region: aliyunRegion } : {}), ...(provider === "openai" ? { baseUrl: openaiBaseUrl } : {}) } });
      setSettings(next); setOpenaiBaseUrl(next.openaiBaseUrl);
      setKey(""); setConnectionOpen(false); setMessage(`${providerLabel} API Key 已保存在本机`); }
    catch (error) { setMessage(error instanceof Error ? error.message : "保存图像服务 Key 失败"); }
    finally { setBusy(false); }
  }

  async function clearKey() {
    setBusy(true); setMessage("");
    try { setSettings(await api<ImageGenerationSettings>(`/image-generation/settings?provider=${provider}`, { method: "DELETE" }));
      setKey(""); setConnectionOpen(false); setMessage("已移除本机保存的图像服务 Key"); }
    catch (error) { setMessage(error instanceof Error ? error.message : "移除图像服务 Key 失败"); }
    finally { setBusy(false); }
  }

  async function addModel() {
    const value = customModel.trim();
    if (!value) return;
    setBusy(true); setMessage("");
    try {
      const next = await api<ImageGenerationSettings>("/image-generation/models", { method: "POST", body: { provider, model: value } });
      setSettings(next); setModel(value); setCustomModel(""); setCustomModelOpen(false); setMessage(`已加入 ${providerLabel} 自定义模型列表`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "添加模型失败"); }
    finally { setBusy(false); }
  }

  async function removeModel() {
    if (!selectedModel?.custom) return;
    setBusy(true); setMessage("");
    try {
      const next = await api<ImageGenerationSettings>(`/image-generation/models?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}`, { method: "DELETE" });
      setSettings(next); setModel(next.providers.find((item) => item.id === provider)?.models[0]?.id ?? "");
      setMessage("自定义模型已从列表移除，已生成图片仍保留");
    } catch (error) { setMessage(error instanceof Error ? error.message : "移除模型失败"); }
    finally { setBusy(false); }
  }

  function updateCustomModel(value: string) {
    if (looksLikeApiKey(value)) {
      setCustomModel("");
      setMessage("这看起来是 API Key，请在连接配置中填写；未保存为模型。");
      return;
    }
    setCustomModel(value);
  }

  async function generate() {
    setBusy(true); setMessage("");
    let asset: PublishAsset;
    try {
      asset = await api<PublishAsset>(`/articles/${article.id}/publish-assets/generate`, { method: "POST",
        body: { provider, group, prompt, model, aspectRatio } });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "图片生成失败");
      setBusy(false); return;
    }
    setGenerated(asset);
    try { await onGenerated?.(asset); setNeedsReload(false); setMessage("图片已生成并保存到本篇素材库"); }
    catch { setNeedsReload(true); setMessage("图片已生成并保存，但素材列表刷新失败；请重新载入，勿重复生成。"); }
    finally { setBusy(false); }
  }

  async function reloadAssets() {
    if (!generated) return;
    setBusy(true);
    try { await onGenerated?.(generated); setNeedsReload(false); setMessage("素材列表已更新"); }
    catch { setMessage("素材列表仍无法读取，请检查连接后重试。"); }
    finally { setBusy(false); }
  }

  async function extractPrompt() {
    setBusy(true); setMessage("");
    let outline = "";
    try {
      outline = (await api<WritingOutline>(`/articles/${article.id}/outline`)).markdown;
    } catch { /* Article title, summary and body are enough when an outline is unavailable. */ }
    const nextPrompt = buildImagePrompt(article, outline);
    setPrompt(nextPrompt); rememberImagePrompt(article.id, group, nextPrompt);
    setMessage("已从文章提取画面提示词，可继续修改后生成");
    setBusy(false);
  }

  const connectionFields = connectionOpen && <div id="pc-connection-fields" className="pc-connection-fields"><p>Key 只保存在本机；保存后不会再次显示。GPT 使用独立的 OpenAI API Key，与 Codex 套餐分开计费。</p>
      {provider === "aliyun" && <label className="pc-field">千问服务地域<select value={aliyunRegion} onChange={(event) => setAliyunRegion(event.target.value as typeof aliyunRegion)}>
        <option value="cn-beijing">中国内地 · 北京</option><option value="ap-southeast-1">国际 · 新加坡</option></select></label>}
      {provider === "openai" && <label className="pc-field">GPT API 地址<input type="url" value={openaiBaseUrl} onChange={(event) => setOpenaiBaseUrl(event.target.value)}
        placeholder="https://api.openai.com/v1" /><small>使用兼容接口时，Key 将发送到此地址；更改后需重新保存 Key。</small></label>}
      <label className="pc-field">{providerLabel} API Key<input type="password" autoComplete="off" spellCheck={false} value={key} onChange={(event) => setKey(event.target.value)} placeholder={selected?.configured ? "已配置；输入新 Key 可替换" : `粘贴 ${providerLabel} API Key`} /></label>
      <div className="pc-actions"><button className="pc-button" disabled={busy || key.length < 10} onClick={() => void saveKey()}>保存 Key</button>
        {selected?.configured && <button className="pc-button" disabled={busy} onClick={() => void clearKey()}>移除 Key</button>}
        <span className="pc-key-status">{selected?.configured ? "已保存 Key，可尝试生成" : "未配置"}</span></div></div>;

  const toggleConnection = () => { setConnectionOpen(!connectionOpen); if (connectionOpen) setKey(""); };

  return <div className="pc-create-grid"><div className="pc-create-main"><div className="pc-context pc-context-compact"><strong>用于制作 · {article.title}</strong>
    <span>定稿 v{article.revision}{article.summary ? ` · ${article.summary}` : ""}</span>
    <small>生成时会把标题、摘要、正文前 8000 字和提示词发送给所选图像服务。</small></div>
    {settings && !selected?.configured && <section className="pc-setup-card"><div className="pc-setup-top"><div><h3>先配置 {providerLabel} 图像服务</h3>
      <p>只需设置一次，之后会自动收起，不影响日常制作。</p></div>
      <button className="pc-button" aria-expanded={connectionOpen} aria-controls="pc-connection-fields" disabled={busy} onClick={toggleConnection}>配置连接</button></div>
      {connectionFields}</section>}
    <div className="pc-generation-controls"><label className="pc-field">图像服务<select value={provider} disabled={busy} onChange={(event) => chooseProvider(event.target.value as typeof provider)}>
      {(settings?.providers ?? [{ id: "gemini" as const, label: "Gemini" }]).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <label className="pc-field">图像模型<select value={model} disabled={busy} onChange={(event) => setModel(event.target.value)}>
      {(safeModels ?? [{ id: model, label: "Gemini 图片模型" }]).map((item) => <option key={item.id} value={item.id}>{item.custom ? `${item.label} · 自定义` : item.label}</option>)}</select></label>
      <label className="pc-field">画幅比例<select value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value)}><option>9:16</option><option>4:5</option><option>1:1</option><option>16:9</option></select></label></div>
    <div className="pc-control-utilities"><div className="pc-model-tools"><button className="pc-button pc-utility-button" aria-expanded={customModelOpen} aria-controls="pc-model-add-fields" disabled={busy}
      onClick={() => { setCustomModelOpen(!customModelOpen); if (customModelOpen) setCustomModel(""); }}>添加自定义模型</button>
      {selectedModel?.custom && <button className="pc-button pc-utility-button" disabled={busy} onClick={() => void removeModel()}>移除自定义模型</button>}</div>
      {selected?.configured && <div className="pc-connection-summary"><span className="pc-key-status">{providerLabel} 连接已配置</span>
        <button className="pc-button pc-utility-button" aria-expanded={connectionOpen} aria-controls="pc-connection-fields" disabled={busy} onClick={toggleConnection}>管理连接</button></div>}</div>
    {selected?.configured && connectionFields}
    {customModelOpen && <div id="pc-model-add-fields" className="pc-model-add"><label className="pc-field">自定义模型 ID<input autoComplete="off" spellCheck={false}
      value={customModel} onChange={(event) => updateCustomModel(event.target.value)} placeholder="例如 gpt-image-2.6-flare；不要填 API Key" /></label>
      <button className="pc-button" disabled={busy || !customModel.trim()} onClick={() => void addModel()}>添加模型</button>
      <small className="pc-model-note">只填写服务商提供的模型 ID。添加后保存在本机；是否可用以服务商响应为准。</small></div>}
    <div className="pc-prompt-heading"><label htmlFor="pc-image-prompt">画面提示词</label>
      <button className="pc-button pc-utility-button" disabled={busy} onClick={() => void extractPrompt()}>从当前文章提取并替换提示词</button></div>
    <textarea id="pc-image-prompt" className="pc-prompt-input" value={prompt} onChange={(event) => {
      setPrompt(event.target.value); rememberImagePrompt(article.id, group, event.target.value);
    }} />
    <div className="pc-generation-footer"><button className="pc-button pc-primary" disabled={busy || needsReload || !selected?.configured || !selectedModel || !prompt.trim() || !!key || regionUnsaved || endpointUnsaved} onClick={() => void generate()}>{busy ? "正在处理…" : "生成并保存图片"}</button>
      <small className="pc-generation-cost">{regionUnsaved ? "千问地域已更改；请填入对应地域的 Key 并保存。" : endpointUnsaved ? "GPT API 地址已更改；请确认地址并重新保存 Key。" : key ? "请先保存输入的 Key，再生成图片。" : !selected?.configured ? "连接图像服务后即可生成。" : `每次生成都会调用你的 ${providerLabel} API，可能产生费用。`}</small></div>
    {needsReload && <button className="pc-button" disabled={busy} onClick={() => void reloadAssets()}>重新载入素材</button>}
    {message && <p className="pc-feedback" role="status">{message}</p>}</div>
    <div className="pc-candidate"><h3>最近生成</h3>{generated ? <><img className="pc-generated-preview" src={publishAssetUrl(generated)} alt={generated.name} />
      <p>{generated.name}</p><button className="pc-button" onClick={() => onViewAsset?.(generated)}>在素材库中查看</button></> :
      <><p>生成成功后会直接保存到本篇素材库，可再选给微博或即刻。</p><div className="pc-candidate-placeholder">文章 + 提示词 → 图片</div></>}</div></div>;
}

export function PublishAssets({ article, assets, onChanged }: Props) {
  const [group, setGroup] = useState<PublishAsset["group"]>("vertical");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [mode, setMode] = useState<"library" | "create">("library");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const shown = assets.filter((item) => item.group === group);
  const selected = shown.find((item) => item.id === selectedId) ?? shown[0] ?? null;
  const deleting = assets.find((item) => item.id === deletingId) ?? null;

  async function upload(files: FileList | null) {
    const selectedFiles = Array.from(files ?? []);
    if (!selectedFiles.length) return;
    setBusy(true); setMessage("");
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
      setMessage(uploaded ? `已上传 ${uploaded} 张图片；其余上传失败：${error instanceof Error ? error.message : "请重试"}` :
        error instanceof Error ? error.message : "图片上传失败");
      setBusy(false); return;
    }
    try { await onChanged(); setMessage(`已上传 ${uploaded} 张图片`); }
    catch { setMessage(`已上传 ${uploaded} 张图片，但素材列表刷新失败；请重新载入。`); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (!deleting) return;
    setBusy(true); setMessage("");
    try {
      await api(`/articles/${article.id}/publish-assets/${deleting.id}`, { method: "DELETE" });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "图片删除失败");
      setBusy(false); return;
    }
    setDeletingId(null); setSelectedId(null);
    try { await onChanged(); setMessage("图片已删除，相关渠道稿的引用已移除；受影响的待发布稿已退回草稿"); }
    catch { setMessage("图片已删除，但素材列表刷新失败；请重新载入。"); }
    finally { setBusy(false); }
  }

  return <div className="pc-panel">
    <div className="pc-heading"><div><h2>本篇图片素材</h2><p>图片只保存一份，微博与即刻可分别选择并排序。</p></div>
      <div className="pc-actions"><label className="pc-button">上传本地图片<input type="file" accept="image/png,image/jpeg,image/webp" multiple hidden disabled={busy}
        onChange={(event) => { void upload(event.target.files); event.target.value = ""; }} /></label>
        <button className="pc-button pc-primary" onClick={() => setMode(mode === "library" ? "create" : "library")}>{mode === "library" ? "制作图片" : "返回素材"}</button></div></div>
    {mode === "create" ? <PublishImageWorkspace article={article} group={group} onGenerated={async () => { await onChanged(); }}
      onViewAsset={(asset) => { setGroup(asset.group); setSelectedId(asset.id); setMode("library"); }} /> : <>
      <div className="pc-group-tabs"><button className={group === "vertical" ? "active" : ""} onClick={() => { setGroup("vertical"); setSelectedId(null); }}>竖屏传播图组</button>
        <button className={group === "article" ? "active" : ""} onClick={() => { setGroup("article"); setSelectedId(null); }}>文章原图</button></div>
      <div className="pc-assets-layout"><div className="pc-assets-grid">{shown.length ? shown.map((item) => <button key={item.id} className={`pc-asset-card ${selected?.id === item.id ? "selected" : ""}`}
        onClick={() => setSelectedId(item.id)}><img src={publishAssetUrl(item)} alt={item.name} /><strong>{item.name}</strong><small>{item.mime.replace("image/", "").toUpperCase()}</small></button>) :
        <div className="pc-empty">这个图组还没有图片。上传后可供多个渠道复用。</div>}</div>
        <aside className="pc-asset-detail"><h3>素材详情</h3>{selected ? <><img className="pc-detail-image" src={publishAssetUrl(selected)} alt={selected.name} />
          <strong>{selected.name}</strong><p>来源：{selected.origin === "generated" ? `${({ gemini: "Gemini", openai: "GPT", volcengine: "豆包", aliyun: "阿里云千问" } as Record<string, string>)[selected.generation?.provider ?? "gemini"] ?? "图像服务"} 生成` : "本地上传"}</p>
          {selected.generation && <><p>模型：{selected.generation.model} · {selected.generation.aspectRatio}</p><p>提示词：{selected.generation.prompt}</p></>}
          <p>用于：{selected.usedBy.length ? selected.usedBy.map((id) => id === "weibo" ? "微博" : "即刻").join("、") : "尚未加入渠道稿"}</p>
          <button className="pc-button pc-danger" disabled={busy} onClick={() => setDeletingId(selected.id)}>删除图片</button></> : <p>选择图片查看详情</p>}</aside></div></>}
    {deleting && <div className="modal-backdrop"><div className="confirm-modal" role="dialog" aria-modal="true" aria-label="删除图片确认"><h2>删除“{deleting.name}”？</h2>
      <p>{deleting.usedBy.length ? `这张图片将从${deleting.usedBy.map((id) => id === "weibo" ? "微博" : "即刻").join("、")}渠道稿中移除。` : "这张图片目前没有渠道引用。"}</p>
      <div className="pc-actions"><button className="pc-button" onClick={() => setDeletingId(null)}>取消</button><button className="pc-button pc-danger" disabled={busy} onClick={() => void remove()}>确认删除</button></div></div></div>}
    {message && <p className="pc-feedback" role="status">{message}</p>}
  </div>;
}
