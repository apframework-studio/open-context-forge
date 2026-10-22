import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, type Article, type Publication } from "../api";

interface Props { articleId: string | null; publicationId: string | null; onPublication: (id: string) => void }

function publicationBody(mdx: string): string {
  return mdx.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
}

export function PublishScreen({ articleId, publicationId, onPublication }: Props) {
  const [article, setArticle] = useState<Article | null>(null);
  const [publication, setPublication] = useState<Publication | null>(null);
  const [slug, setSlug] = useState("");
  const [showConfirm, setShowConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [publicUrl, setPublicUrl] = useState("");
  const [confirmedLayout, setConfirmedLayout] = useState(false);

  useEffect(() => {
    if (!articleId) return;
    void api<Article>(`/articles/${articleId}`).then(setArticle).catch(() => setMessage("文章加载失败"));
    if (publicationId) void api<Publication>(`/articles/${articleId}/publications/${publicationId}`).then(setPublication).catch(() => setPublication(null));
  }, [articleId, publicationId]);

  async function prepare() {
    if (!article) return;
    setBusy(true); setMessage("");
    try {
      const item = await api<Publication>(`/articles/${article.id}/publications/prepare`, { method: "POST", body: { slug } });
      setPublication(item); onPublication(item.id); setMessage("本地包已准备");
    } catch (error) { setMessage(error instanceof Error ? error.message : "发布包生成失败"); }
    finally { setBusy(false); }
  }

  async function publish() {
    if (!publication) return;
    setBusy(true); setMessage("");
    try {
      const item = await api<Publication>(`/publications/${publication.id}/publish`, { method: "POST", body: { confirmedRevision: publication.revision, confirmedArticlePath: publication.articlePath } });
      setPublication(item); setShowConfirm(false); setMessage("已写入博客仓库，等待公开链接验证");
    } catch (error) { setMessage(error instanceof Error ? error.message : "发布失败"); }
    finally { setBusy(false); }
  }

  async function verify() {
    if (!publication) return;
    setBusy(true); setMessage("");
    try {
      const item = await api<Publication>(`/publications/${publication.id}/verify`, { method: "POST", body: { publicUrl, confirmedLayout } });
      setPublication(item); setMessage("公开链接已验证");
    } catch (error) { setMessage(error instanceof Error ? error.message : "公开链接验证失败"); }
    finally { setBusy(false); }
  }

  if (!article) return <section className="panel-card"><div className="section-heading"><div><span className="overline">PUBLISH</span><h2>预览与发布</h2></div></div><p className="muted">先在“文章工作台”完成文章定稿。</p></section>;

  return <div className="screen-stack">
    <section className="panel-card"><div className="section-heading"><div><span className="overline">APFRAMEWORK</span><h2>博客发布准备</h2></div><span className={`tag ${article.status === "final" ? "success" : "warning"}`}>{article.status === "final" ? "可准备" : "需定稿"}</span></div>
      <p className="muted">文章：{article.title} · 修订 {article.revision}。生成包只写本机文件；发布前请检查下方渠道预览。</p>
      <div className="form-grid two"><label>文章 slug<input value={slug} onChange={(event) => setSlug(event.target.value)} placeholder="my-article" /></label><div className="form-action"><button className="primary-button" disabled={busy || article.status !== "final" || !slug.trim()} onClick={() => void prepare()}>生成本地发布包</button></div></div>
      {message && <p className="inline-message" role="status">{message}</p>}
    </section>
    {publication && <section className="panel-card"><div className="section-heading"><div><span className="overline">CHANNEL PREVIEW</span><h2>apframework 预览</h2></div><span className={`tag ${publication.status === "stale" ? "warning" : "success"}`}>{publication.status === "prepared" ? "本地包已准备" : publication.status === "stale" ? "需重新准备" : publication.status === "live" ? "已上线" : "待验证"}</span></div>
      <div className="details-grid"><div><small>目标路径</small><code>{publication.articlePath}</code></div><div><small>文章修订</small><strong>v{publication.revision}</strong></div><div><small>素材</small><strong>{publication.assets.length} 个</strong></div></div>
      <div className="markdown-body channel-preview"><h2>{article.title}</h2><p className="preview-summary">{article.summary}</p><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{ img: ({ src, ...props }) => <img {...props} src={src?.startsWith("/static/images/") ? `/api/v1/publications/${publication.id}/asset?path=${encodeURIComponent(`public${src}`)}` : src} /> }}>{publicationBody(publication.mdx)}</Markdown></div>
      <details className="source-details"><summary>查看生成的 MDX</summary><pre>{publication.mdx}</pre></details>
      <div className="action-row">{publication.status === "prepared" && <button className="primary-button" onClick={() => setShowConfirm(true)}>打开发布确认</button>}{publication.publicUrl && <a href={publication.publicUrl} target="_blank" rel="noreferrer">查看公开文章</a>}</div>
    </section>}
    {publication && (publication.status === "deployment-pending" || publication.status === "written-to-repository") && <section className="panel-card"><div className="section-heading"><div><span className="overline">VERIFY</span><h2>验证公开链接</h2></div></div><p className="muted">仓库提交和线上可见是两个状态。部署完成后填写公开链接并核对排版。</p><div className="form-grid"><label>公开链接<input value={publicUrl} onChange={(event) => setPublicUrl(event.target.value)} placeholder="https://apframework.com/blog/essay/..." /></label><label className="check-label"><input type="checkbox" checked={confirmedLayout} onChange={(event) => setConfirmedLayout(event.target.checked)} />我已在浏览器检查排版</label></div><div className="action-row"><button className="primary-button" disabled={busy || !publicUrl || !confirmedLayout} onClick={() => void verify()}>验证并标记上线</button></div></section>}
    {showConfirm && publication && <div className="modal-backdrop"><div className="confirm-modal" role="dialog" aria-modal="true" aria-label="发布确认"><span className="overline">FINAL CONFIRMATION</span><h2>确认发布到 apframework</h2><p>将定稿修订 v{publication.revision} 写入隔离的博客工作区，构建通过后提交并推送。</p><div className="confirm-target"><small>目标仓库</small><strong>apframework.com</strong><small>目标文章路径</small><code>{publication.articlePath}</code></div><div className="action-row"><button className="secondary-button" onClick={() => setShowConfirm(false)}>取消</button><button className="primary-button" disabled={busy} onClick={() => void publish()}>确认写入并推送</button></div></div></div>}
  </div>;
}
