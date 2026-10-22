import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, type Article, type SourceRef } from "../api";

interface Props { sourceRef: SourceRef | null; articleId: string | null; onArticle: (id: string) => void }

export function ArticleScreen({ sourceRef, articleId, onArticle }: Props) {
  const [article, setArticle] = useState<Article | null>(null);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [draft, setDraft] = useState("");
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!articleId) return;
    void api<Article>(`/articles/${articleId}`).then((item) => { setArticle(item); setDraft(item.markdown); }).catch(() => setMessage("文章加载失败"));
  }, [articleId]);

  useEffect(() => {
    if (!article || draft === article.markdown || busy) return;
    const timer = window.setTimeout(() => { void save(); }, 1_200);
    return () => window.clearTimeout(timer);
  }, [article?.revision, article?.markdown, draft, busy]);

  async function create() {
    if (!sourceRef) return;
    setBusy(true); setMessage("");
    try {
      const item = await api<Article>("/articles", { method: "POST", body: { title, summary, date, sourceRef } });
      setArticle(item); setDraft(item.markdown); onArticle(item.id);
    } catch (error) { setMessage(error instanceof Error ? error.message : "创建失败"); }
    finally { setBusy(false); }
  }

  async function save() {
    if (!article || draft === article.markdown || busy) return;
    setBusy(true); setMessage("");
    try {
      const item = await api<Article>(`/articles/${article.id}/draft`, { method: "PUT", body: { markdown: draft, expectedRevision: article.revision } });
      setArticle(item); setMessage(`草稿已保存 · 修订 ${item.revision}`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "保存失败"); }
    finally { setBusy(false); }
  }

  async function finalize() {
    if (!article || draft !== article.markdown) { setMessage("请先保存草稿"); return; }
    setBusy(true); setMessage("");
    try {
      const item = await api<Article>(`/articles/${article.id}/finalize`, { method: "POST", body: { expectedRevision: article.revision } });
      setArticle(item); setMessage("已定稿");
    } catch (error) { setMessage(error instanceof Error ? error.message : "定稿检查失败"); }
    finally { setBusy(false); }
  }

  if (!article) return <section className="panel-card">
    <div className="section-heading"><div><span className="overline">WRITING PROJECT</span><h2>创建文章</h2></div></div>
    {sourceRef ? <><p className="muted">当前来源：{sourceRef.vaultId} / {sourceRef.snapshot}</p><div className="form-grid"><label>文章标题<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="一个清楚的标题" /></label><label>公开摘要<input value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="给读者看的简要说明" /></label><label>发布日期<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label></div><div className="action-row"><button className="primary-button" disabled={busy || !title.trim() || !summary.trim()} onClick={() => void create()}>创建文章</button></div></> : <p className="muted">先在“资料与分析”中确认导入一份来源，再开始写作。</p>}
    {message && <p className="inline-message" role="status">{message}</p>}
  </section>;

  return <div className="screen-stack">
    <section className="panel-card"><div className="section-heading"><div><span className="overline">EDITOR</span><h2>{article.title}</h2></div><span className={`tag ${article.status === "final" ? "success" : "warning"}`}>{article.status === "final" ? "已定稿" : "草稿"} · v{article.revision}</span></div>
      <p className="muted">来源：{article.sourceRef.vaultId} / {article.sourceRef.snapshot}</p>
      <label className="editor-label">文章正文<textarea value={draft} onChange={(event) => setDraft(event.target.value)} aria-label="文章正文" spellCheck={false} /></label>
      <div className="action-row"><button className="secondary-button" disabled={busy || draft === article.markdown} onClick={() => void save()}>保存草稿</button><button className="secondary-button" onClick={() => setPreview((value) => !value)}>本地预览</button><button className="primary-button" disabled={busy || draft !== article.markdown} onClick={() => void finalize()}>定稿</button>{message && <span className="inline-message" role="status">{message}</span>}</div>
    </section>
    {preview && <section className="panel-card preview-panel"><div className="section-heading"><div><span className="overline">LOCAL PREVIEW</span><h2>Markdown 预览</h2></div></div><div className="markdown-body"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{ img: ({ src, ...props }) => <img {...props} src={src?.startsWith("assets/") ? `/api/v1/articles/${article.id}/asset?path=${encodeURIComponent(src)}` : src} /> }}>{draft}</Markdown></div></section>}
  </div>;
}
