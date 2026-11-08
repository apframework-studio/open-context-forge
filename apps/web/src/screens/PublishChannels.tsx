import { useEffect, useState } from "react";
import { api, ApiError, type Article, type ChannelPublication, type PublishAsset, type PublishChannelDraft, type PublishChannelId } from "../api";
import { publishAssetUrl } from "./PublishAssets";
import { buildChannelSuggestion } from "./channel-suggestion";

interface Props {
  article: Article;
  channel: PublishChannelId;
  draft: PublishChannelDraft | null;
  assets: PublishAsset[];
  onSaved: () => Promise<void>;
}

interface LocalChannelEdit { revision: number; text: string; extra: string; assetIds: string[] }

function localEditKey(articleId: string, channel: PublishChannelId): string {
  return `ocf-channel-edit:${articleId}:${channel}`;
}

function readLocalEdit(articleId: string, channel: PublishChannelId, draft: PublishChannelDraft | null,
  extraKey: "topics" | "question", assets: PublishAsset[]): LocalChannelEdit | null {
  try {
    const raw = sessionStorage.getItem(localEditKey(articleId, channel));
    if (!raw) return null;
    const saved = JSON.parse(raw) as LocalChannelEdit;
    if (saved.revision !== (draft?.revision ?? 0) || typeof saved.text !== "string" || typeof saved.extra !== "string" ||
      !Array.isArray(saved.assetIds) || !saved.assetIds.every((id) => typeof id === "string")) {
      sessionStorage.removeItem(localEditKey(articleId, channel)); return null;
    }
    saved.assetIds = saved.assetIds.filter((id) => assets.some((asset) => asset.id === id));
    if (saved.text === (draft?.content.text ?? "") && saved.extra === (draft?.content[extraKey] ?? "") &&
      JSON.stringify(saved.assetIds) === JSON.stringify(draft?.assetIds ?? [])) {
      sessionStorage.removeItem(localEditKey(articleId, channel)); return null;
    }
    return saved;
  } catch { return null; }
}

export function PublishChannels({ article, channel, draft, assets, onSaved }: Props) {
  const isWeibo = channel === "weibo";
  const extraKey = isWeibo ? "topics" : "question";
  const [initialEdit] = useState(() => readLocalEdit(article.id, channel, draft, extraKey, assets));
  const [text, setText] = useState(initialEdit?.text ?? draft?.content.text ?? "");
  const [extra, setExtra] = useState(initialEdit?.extra ?? draft?.content[extraKey] ?? "");
  const [assetIds, setAssetIds] = useState<string[]>(initialEdit?.assetIds ?? draft?.assetIds ?? []);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [publishUrl, setPublishUrl] = useState("");
  const [publishTime, setPublishTime] = useState("");
  const [needsReload, setNeedsReload] = useState(false);
  const [publishedLocally, setPublishedLocally] = useState(false);
  const [suggestion, setSuggestion] = useState<{ text: string; extra: string; sourceRevision: number } | null>(null);

  useEffect(() => {
    const local = readLocalEdit(article.id, channel, draft, extraKey, assets);
    setText(local?.text ?? draft?.content.text ?? "");
    setExtra(local?.extra ?? draft?.content[extraKey] ?? "");
    setAssetIds(local?.assetIds ?? draft?.assetIds ?? []);
  }, [draft, extraKey]);

  function rememberEdit(nextText: string, nextExtra: string, nextAssetIds: string[]) {
    try {
      const key = localEditKey(article.id, channel);
      if (nextText === (draft?.content.text ?? "") && nextExtra === (draft?.content[extraKey] ?? "") &&
        JSON.stringify(nextAssetIds) === JSON.stringify(draft?.assetIds ?? [])) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, JSON.stringify({ revision: draft?.revision ?? 0, text: nextText, extra: nextExtra,
        assetIds: nextAssetIds } satisfies LocalChannelEdit));
    } catch { /* Editing still works when browser storage is unavailable. */ }
  }

  function discardLocalEdit() {
    try { sessionStorage.removeItem(localEditKey(article.id, channel)); } catch { /* Local state can still be reset. */ }
    setText(draft?.content.text ?? ""); setExtra(draft?.content[extraKey] ?? ""); setAssetIds(draft?.assetIds ?? []);
    setMessage("已恢复上次保存的渠道稿");
  }

  function prepareSuggestion() {
    setSuggestion({ ...buildChannelSuggestion(article, channel, extra), sourceRevision: article.revision });
  }

  function adoptSuggestion() {
    if (!suggestion) return;
    setText(suggestion.text); setExtra(suggestion.extra);
    rememberEdit(suggestion.text, suggestion.extra, assetIds);
    setSuggestion(null); setMessage("建议已填入编辑区，保存后才会更新渠道稿");
  }

  function toggleAsset(id: string, checked: boolean) {
    const next = checked ? assetIds.includes(id) ? assetIds : [...assetIds, id] : assetIds.filter((item) => item !== id);
    setAssetIds(next); rememberEdit(text, extra, next);
  }

  function moveAsset(id: string, direction: -1 | 1) {
    const index = assetIds.indexOf(id), next = index + direction;
    if (index < 0 || next < 0 || next >= assetIds.length) return;
    const copy = [...assetIds]; [copy[index], copy[next]] = [copy[next], copy[index]];
    setAssetIds(copy); rememberEdit(text, extra, copy);
  }

  async function save(status: "draft" | "ready") {
    setBusy(true); setMessage("");
    try {
      await api<PublishChannelDraft>(`/articles/${article.id}/channel-drafts/${channel}`, { method: "PUT",
        body: { expectedRevision: draft?.revision ?? 0, content: { text, [extraKey]: extra }, status, assetIds } });
      try { sessionStorage.removeItem(localEditKey(article.id, channel)); } catch { /* Server save succeeded. */ }
      setPublishedLocally(false);
    } catch (error) {
      if (error instanceof ApiError && error.code === "CHANNEL_REVISION_CONFLICT") setNeedsReload(true);
      setMessage(error instanceof Error ? error.message : "渠道稿保存失败");
      setBusy(false); return;
    }
    try { await onSaved(); setNeedsReload(false); setMessage(status === "ready" ? "渠道稿已标记待发布" : "渠道稿已保存"); }
    catch { setNeedsReload(true); setMessage("渠道稿已保存，但读取最新状态失败；请重新载入，勿重复保存。"); }
    finally { setBusy(false); }
  }

  async function sync() {
    setBusy(true); setMessage("");
    try {
      await api<PublishChannelDraft>(`/articles/${article.id}/channel-drafts/${channel}/sync`, { method: "POST",
        body: { expectedRevision: draft?.revision } });
    } catch (error) {
      if (error instanceof ApiError && error.code === "CHANNEL_REVISION_CONFLICT") setNeedsReload(true);
      setMessage(error instanceof Error ? error.message : "文章修订同步失败");
      setBusy(false); return;
    }
    try { await onSaved(); setNeedsReload(false); setMessage("已核对文章新修订；渠道文案和图片保留"); }
    catch { setNeedsReload(true); setMessage("修订已核对，但读取最新状态失败；请重新载入。"); }
    finally { setBusy(false); }
  }

  async function copyPost() {
    try {
      await navigator.clipboard.writeText([text.trim(), extra.trim()].filter(Boolean).join("\n\n"));
      setMessage("文案已复制，可粘贴到平台发布页");
    } catch { setMessage("复制失败，请检查浏览器剪贴板权限"); }
  }

  async function downloadHandoff() {
    if (!draft) return;
    setBusy(true); setMessage("");
    try {
      const response = await fetch(`/api/v1/articles/${encodeURIComponent(article.id)}/channel-drafts/${channel}/handoff`);
      if (!response.ok) throw new Error(response.status === 413 ? "图片合计超过 100 MB，请减少图片后重试" : "发布包生成失败，请重新载入渠道稿后重试");
      const blobUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = blobUrl; link.download = `${channel}-${article.id}.zip`;
      document.body.append(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
      setMessage("发布包已下载，包含当前渠道文案及按顺序排列的图片");
    } catch (error) { setMessage(error instanceof Error ? error.message : "发布包下载失败"); }
    finally { setBusy(false); }
  }

  async function markPublished() {
    setBusy(true); setMessage("");
    try {
      await api<ChannelPublication>(`/articles/${article.id}/channel-drafts/${channel}/published`, { method: "POST",
        body: { expectedRevision: draft?.revision, url: publishUrl.trim(), ...(publishTime ? { publishedAt: new Date(publishTime).toISOString() } : {}) } });
      setPublishedLocally(true);
    } catch (error) {
      if (error instanceof ApiError && error.code === "CHANNEL_REVISION_CONFLICT") setNeedsReload(true);
      setMessage(error instanceof Error ? error.message : "记录发布结果失败");
      setBusy(false); return;
    }
    try { await onSaved(); setNeedsReload(false); setPublishedLocally(false); setPublishUrl(""); setPublishTime(""); setMessage("已记录本渠道发布结果"); }
    catch { setNeedsReload(true); setMessage("发布结果已记录，但读取最新状态失败；请重新载入，勿重复登记。"); }
    finally { setBusy(false); }
  }

  async function reloadLatest() {
    setBusy(true);
    try { await onSaved(); setNeedsReload(false); setPublishedLocally(false); setMessage("已载入最新渠道稿"); }
    catch { setMessage("重新载入失败，请检查连接后重试"); }
    finally { setBusy(false); }
  }

  const orderedAssets = assetIds.map((id) => assets.find((item) => item.id === id)).filter((item): item is PublishAsset => !!item);
  const hasUnsavedChanges = text !== (draft?.content.text ?? "") || extra !== (draft?.content[extraKey] ?? "") ||
    JSON.stringify(assetIds) !== JSON.stringify(draft?.assetIds ?? []);
  const canHandoff = !!draft && draft.status === "ready" && !draft.stale && !hasUnsavedChanges && !needsReload;
  const canMarkPublished = canHandoff && !draft.lastPublication?.current && !publishedLocally;
  const platformUrl = isWeibo ? "https://weibo.com/" : "https://web.okjike.com/";
  return <div className="pc-panel"><div className="pc-heading"><div><h2>{isWeibo ? "微博" : "即刻"}发布页</h2>
    <p>{isWeibo ? "微博文案、话题与图片顺序独立保存。" : "即刻正文、讨论引导与图片顺序独立保存。"}</p></div>
    <span className={`pc-status ${draft?.status === "ready" ? "ready" : ""}`}>{publishedLocally ? "已登记，待刷新" : draft?.lastPublication?.current ? "已发布" : draft?.status === "ready" ? "待发布" : draft ? "草稿" : "未计划"}</span></div>
    {needsReload && <div className="pc-notice">渠道稿状态可能已变化。
      <button className="pc-button" disabled={busy} onClick={() => void reloadLatest()}>放弃本地修改并载入最新稿</button></div>}
    {draft?.stale && <div className="pc-notice">文章已更新到 v{article.revision}，本稿仍基于 v{draft.sourceRevision}。
      <details className="pc-source-review"><summary>查看文章新修订</summary><pre>{article.markdown}</pre></details>
      <button className="pc-button" disabled={busy || needsReload || hasUnsavedChanges} onClick={() => void sync()}>已核对新修订</button>
      {hasUnsavedChanges && <small>请先保存当前渠道修改，再核对文章修订。</small>}</div>}
    <div className="pc-channel-layout"><div><div className="pc-channel-source-actions"><details className="pc-source-review pc-article-reference"><summary>查看定稿文章</summary>
      <div><strong>{article.title}</strong><p>{article.summary}</p><pre>{article.markdown}</pre></div></details>
      <button className="pc-button pc-utility-button" disabled={busy} onClick={prepareSuggestion}>从文章提取文案建议</button></div>
      {suggestion && <section className="pc-suggestion-preview" role="region" aria-label="文案建议预览"><div className="pc-suggestion-head"><h3>文案建议 · 定稿 v{suggestion.sourceRevision}</h3>
        <span>仅根据标题、摘要和正文线索整理；采用后仍需保存。</span></div>
        <div className="pc-suggestion-compare"><div><h4>当前编辑稿</h4><pre>{text || "尚无正文"}</pre><small>{isWeibo ? "话题" : "讨论引导"}：{extra || "未填写"}</small></div>
          <div><h4>文章建议稿</h4><pre>{suggestion.text}</pre><small>{isWeibo ? "话题" : "讨论引导"}：{suggestion.extra || "未填写"}</small></div></div>
        <div className="pc-actions"><button className="pc-button" onClick={() => setSuggestion(null)}>保留当前稿</button>
          <button className="pc-button pc-primary" disabled={busy || (text === suggestion.text && extra === suggestion.extra)} onClick={adoptSuggestion}>采用建议到编辑区</button></div></section>}
      <label className="pc-field">{isWeibo ? "微博正文" : "即刻正文"}
      <textarea value={text} disabled={busy} onChange={(event) => { setText(event.target.value); rememberEdit(event.target.value, extra, assetIds); }} placeholder={isWeibo ? "用适合微博的方式表达文章观点" : "用适合即刻讨论的方式表达文章观点"} /></label>
      <label className="pc-field">{isWeibo ? "话题" : "讨论引导"}<input value={extra} disabled={busy} onChange={(event) => { setExtra(event.target.value); rememberEdit(text, event.target.value, assetIds); }}
        placeholder={isWeibo ? "#知识管理" : "邀请读者分享自己的体验"} /></label>
      <section className="pc-subpanel"><h3>本渠道图片</h3><p>从文章素材库选择。调整这里的顺序不会改变其他渠道。</p>
        {assets.length ? <div className="pc-pick-grid">{assets.map((item) => <label key={item.id} className="pc-pick"><input type="checkbox" disabled={busy} checked={assetIds.includes(item.id)}
          onChange={(event) => toggleAsset(item.id, event.target.checked)} /><img src={publishAssetUrl(item)} alt="" /><span>{item.name}</span></label>)}</div> : <p>尚无图片，可先到图片素材页上传。</p>}
        {orderedAssets.length > 1 && <div className="pc-order">{orderedAssets.map((item, index) => <div key={item.id}><span>{index + 1}. {item.name}</span>
          <button aria-label={`上移 ${item.name}`} disabled={busy || index === 0} onClick={() => moveAsset(item.id, -1)}>↑</button>
          <button aria-label={`下移 ${item.name}`} disabled={busy || index === orderedAssets.length - 1} onClick={() => moveAsset(item.id, 1)}>↓</button></div>)}</div>}</section>
      {hasUnsavedChanges && <div className="pc-unsaved-row"><span>未保存的修改暂存在当前浏览器标签页；保存后才会写入发布中心。</span>
        <button className="pc-button pc-utility-button" disabled={busy} onClick={discardLocalEdit}>放弃未保存修改</button></div>}
      <div className={`pc-actions pc-draft-actions${hasUnsavedChanges ? " pc-draft-actions-pending" : ""}`}><button className="pc-button" disabled={busy || needsReload} onClick={() => void save("draft")}>保存草稿</button>
        <button className="pc-button pc-primary" disabled={busy || needsReload || !text.trim()} onClick={() => void save("ready")}>标记待发布</button></div>
      {draft?.status === "ready" || draft?.lastPublication ? <section className="pc-subpanel pc-handoff-panel"><h3>发布交接 · {isWeibo ? "微博" : "即刻"}</h3>
        <p>带着文案和图片到平台核对发布，完成后登记结果。</p>
        <div className="pc-actions pc-handoff-actions"><button className="pc-button" disabled={busy || !canHandoff} onClick={() => void downloadHandoff()}>下载渠道发布包</button>
          <button className="pc-button" disabled={busy || !canHandoff} onClick={() => void copyPost()}>复制发布文案</button>
          <a className="pc-button" href={platformUrl} target="_blank" rel="noopener noreferrer">打开{isWeibo ? "微博" : "即刻"}</a>
          {orderedAssets.map((item, index) => <a className="pc-button" key={item.id} href={publishAssetUrl(item)} download={item.name}>下载图片 {index + 1}</a>)}</div>
        <label className="pc-field">已发布链接（选填）<input type="url" value={publishUrl} disabled={busy} onChange={(event) => setPublishUrl(event.target.value)}
          placeholder={isWeibo ? "https://weibo.com/..." : "https://web.okjike.com/..."} /></label>
        <label className="pc-field">实际发布时间（选填，留空按登记时间）<input type="datetime-local" value={publishTime} disabled={busy} onChange={(event) => setPublishTime(event.target.value)} /></label>
        <button className="pc-button pc-primary" disabled={busy || !canMarkPublished} onClick={() => void markPublished()}>确认已在平台发布</button>
        {hasUnsavedChanges && <small>请先保存当前渠道修改。</small>}
        {draft?.lastPublication && <p className="pc-publication-record">最近记录：{new Date(draft.lastPublication.publishedAt).toLocaleString("zh-CN")}
          {draft.lastPublication.url && <> · <a href={draft.lastPublication.url} target="_blank" rel="noopener noreferrer">查看发布链接</a></>}
          {!draft.lastPublication.current && " · 当前稿件已变化"}</p>}
        <details className="pc-handoff-help"><summary>发布方式与接入说明</summary>
          <p>当前方式：网页人工交接。先将渠道稿标记待发布，再带着文案和图片到平台核对发布，最后登记结果。</p>
          {isWeibo ? <p className="pc-connection-note">可选的官方 CLI 需要开发者认证、OAuth 授权和服务额度；多图发博不在体验服务内。
            <a href="https://open.weibo.com/cli/quickstart" target="_blank" rel="noopener noreferrer">查看官方接入说明</a></p> :
            <p className="pc-connection-note">即刻网页可手动发布；浏览器辅助仍需验证登录、图文填写和结果回查，当前不会自动发帖。</p>}</details></section> :
        <p className="pc-handoff-hint">标记待发布后，可下载发布包、复制文案并登记发布结果。</p>}
      {message && <p className="pc-feedback" role="status">{message}</p>}</div>
      <aside className="pc-preview"><h3>{isWeibo ? "微博" : "即刻"}效果预览</h3><div className="pc-post"><strong>{isWeibo ? "@ 我的账号" : "我的即刻动态"}</strong>
        <p>{text || "正文将在这里预览"}</p>{orderedAssets.length > 0 && <div className="pc-preview-images">{orderedAssets.map((item) =>
          <img key={item.id} src={publishAssetUrl(item)} alt={item.name} />)}</div>}
        <small>{extra}</small></div></aside></div>
  </div>;
}
