import { useEffect, useRef, useState } from "react";
import { api, ApiError, type Article, type PublishAsset, type PublishCenterSummary,
  type PublishChannelDraft, type PublishChannelId } from "../api";
import { PublishAssets } from "./PublishAssets";
import { PublishChannels } from "./PublishChannels";
import { PublishScreen as BlogPublishScreen } from "./PublishScreen";
import "./publish-center.css";

interface Props {
  focusArticleId: string | null;
  publicationId: string | null;
  onFocusChange: (articleId: string | null) => void;
  onPublication: (id: string) => void;
  onOpenArticles: (articleId?: string) => void;
}

function statusText(status: { status: "unplanned" | "draft" | "ready" | "published"; stale: boolean }): string {
  if (status.stale) return "文章已更新";
  return status.status === "published" ? "已发布" : status.status === "ready" ? "待发布" : status.status === "draft" ? "编辑中" : "未计划";
}

export function PublishCenterTable({ summary, onOpen }: { summary: PublishCenterSummary; onOpen: (id: string) => void }) {
  return <div className="pc-table-wrap"><table className="pc-table"><thead><tr><th>文章</th>
    {summary.channels.map((channel) => <th key={channel.id}>{channel.label}</th>)}<th>进度</th></tr></thead><tbody>
    {summary.items.map((item) => { const ready = summary.channels.filter((channel) => ["ready", "published"].includes(item.channels[channel.id].status) && !item.channels[channel.id].stale).length;
      const planned = summary.channels.filter((channel) => item.channels[channel.id].status !== "unplanned").length;
      return <tr key={item.id}><td><button className="pc-article-link" onClick={() => onOpen(item.id)}><strong>{item.title}</strong><small>定稿 v{item.revision} · {item.summary}</small></button></td>
        {summary.channels.map((channel) => <td key={channel.id}><span className={`pc-status ${item.channels[channel.id].status === "ready" && !item.channels[channel.id].stale ? "ready" : ""}`}>{statusText(item.channels[channel.id])}</span></td>)}
        <td>{planned ? <><strong>{ready}/{planned}</strong><small>渠道已准备</small></> : <span className="pc-status">未选择渠道</span>}</td></tr>; })}
    </tbody></table></div>;
}

async function loadDraft(articleId: string, channel: PublishChannelId): Promise<PublishChannelDraft | null> {
  try { return await api<PublishChannelDraft>(`/articles/${articleId}/channel-drafts/${channel}`); }
  catch (error) { if (error instanceof ApiError && error.status === 404) return null; throw error; }
}

export function PublishCenterScreen({ focusArticleId, publicationId, onFocusChange, onPublication, onOpenArticles }: Props) {
  const focusRef = useRef(focusArticleId);
  focusRef.current = focusArticleId;
  const [summary, setSummary] = useState<PublishCenterSummary | null>(null);
  const [article, setArticle] = useState<Article | null>(null);
  const [assets, setAssets] = useState<PublishAsset[]>([]);
  const [drafts, setDrafts] = useState<Record<PublishChannelId, PublishChannelDraft | null>>({ weibo: null, jike: null });
  const [tab, setTab] = useState<"assets" | "weibo" | "jike" | "blog">("assets");
  const [message, setMessage] = useState("");

  async function refreshSummary() { setSummary(await api<PublishCenterSummary>("/publish-center")); }
  async function refreshDetail(id: string) {
    const nextArticle = await api<Article>(`/articles/${id}`);
    if (nextArticle.status !== "final") {
      if (focusRef.current === id) { setArticle(nextArticle); setAssets([]); setDrafts({ weibo: null, jike: null }); }
      return;
    }
    const [assetList, weibo, jike] = await Promise.all([
      api<{ items: PublishAsset[] }>(`/articles/${id}/publish-assets`),
      loadDraft(id, "weibo"), loadDraft(id, "jike"),
    ]);
    if (focusRef.current !== id) return;
    setArticle(nextArticle); setAssets(assetList.items); setDrafts({ weibo, jike });
  }
  async function refresh() {
    if (focusArticleId) await refreshDetail(focusArticleId);
    await refreshSummary();
  }

  useEffect(() => {
    let active = true;
    void api<PublishCenterSummary>("/publish-center").then((value) => { if (active) setSummary(value); })
      .catch((error) => { if (active) setMessage(error instanceof Error ? error.message : "发布中心加载失败"); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    setArticle(null); setAssets([]); setDrafts({ weibo: null, jike: null });
    if (!focusArticleId) return;
    setTab("assets");
    let active = true;
    void api<Article>(`/articles/${focusArticleId}`).then(async (nextArticle) => {
      if (!active) return;
      if (nextArticle.status !== "final") { setArticle(nextArticle); setMessage(""); return; }
      const [assetList, weibo, jike] = await Promise.all([api<{ items: PublishAsset[] }>(`/articles/${focusArticleId}/publish-assets`),
        loadDraft(focusArticleId, "weibo"), loadDraft(focusArticleId, "jike")]);
      if (active) { setArticle(nextArticle); setAssets(assetList.items); setDrafts({ weibo, jike }); setMessage(""); }
    })
      .catch((error) => { if (active) setMessage(error instanceof Error ? error.message : "文章发布准备加载失败"); });
    return () => { active = false; };
  }, [focusArticleId]);

  const visibleArticle = article?.id === focusArticleId ? article : null;
  if (!focusArticleId) return <div className="screen-stack pc-screen"><section className="panel-card"><div className="pc-heading"><div><span className="overline">PUBLISHING CENTER</span>
    <h2>定稿文章</h2><p>从定稿文章出发，为不同渠道独立准备内容与图片。</p></div></div>
    {summary?.items.length ? <PublishCenterTable summary={summary} onOpen={onFocusChange} /> : <div className="pc-empty">{message || "暂无已定稿文章。"}
      <button className="pc-button" onClick={() => onOpenArticles()}>前往文章工作台</button></div>}</section></div>;

  return <div className="screen-stack pc-screen"><section className="panel-card"><button className="pc-back" onClick={() => onFocusChange(null)}>← 返回发布中心</button>
    <div className="pc-heading"><div><h2>{visibleArticle?.title ?? "加载文章中…"}</h2><p>{visibleArticle ? visibleArticle.status === "final" ? `定稿 v${visibleArticle.revision} · 微博、即刻可分别准备` : "这篇文章仍在工作台编辑中" : "正在读取文章与渠道稿"}</p></div>
      {visibleArticle && <span className={`pc-status ${visibleArticle.status === "final" ? "ready" : ""}`}>{visibleArticle.status === "final" ? "已定稿" : "需定稿"}</span>}</div>
    {message && <p className="pc-feedback" role="status">{message}</p>}
    {!visibleArticle ? <div className="pc-empty">正在读取文章与渠道稿…</div> : visibleArticle.status === "draft" ? <div className="pc-empty"><strong>请先在文章工作台定稿</strong><span>定稿后即可为微博、即刻准备独立渠道稿和共享图片。</span>
      <button className="pc-button" onClick={() => onOpenArticles(focusArticleId)}>返回此文章并定稿</button></div> : <><div className="pc-tabs" role="tablist" aria-label="发布准备页面"><button className={tab === "assets" ? "active" : ""} onClick={() => setTab("assets")}>图片素材</button>
      <button className={tab === "weibo" ? "active" : ""} onClick={() => setTab("weibo")}>微博发布</button>
      <button className={tab === "jike" ? "active" : ""} onClick={() => setTab("jike")}>即刻发布</button>
      <button className={tab === "blog" ? "active" : ""} onClick={() => setTab("blog")}>博客（现有流程）</button></div>
    {visibleArticle && tab === "assets" && <PublishAssets key={visibleArticle.id} article={visibleArticle} assets={assets} onChanged={refresh} />}
    {visibleArticle && (tab === "weibo" || tab === "jike") && <PublishChannels key={`${visibleArticle.id}:${tab}`} article={visibleArticle} channel={tab} draft={drafts[tab]}
      assets={assets} onSaved={refresh} />}
    {tab === "blog" && <BlogPublishScreen articleId={focusArticleId} publicationId={publicationId} onPublication={onPublication} onOpenArticles={() => onOpenArticles(focusArticleId)} />}</>}
  </section></div>;
}
