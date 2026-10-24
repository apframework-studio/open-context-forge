import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, type Article, type ArticleList, type ArticleListItem, type SourceRef } from "../api";
import { ArticleConversation } from "../ArticleConversation";
import { WorkspaceIcon } from "../WorkspaceIcon";

interface Props {
  sourceRef: SourceRef | null;
  articleId: string | null;
  onArticle: (id: string, publicationId?: string | null) => void;
  onOpenSources: () => void;
}

const stages: Record<ArticleListItem["stage"], string> = {
  new: "新建", writing: "写作中", complete: "已完成", pending_publish: "待发布", published: "已发布",
};

export function ArticleScreen({ sourceRef, articleId, onArticle, onOpenSources }: Props) {
  const [items, setItems] = useState<ArticleListItem[]>([]);
  const [article, setArticle] = useState<Article | null>(null);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [date, setDate] = useState("");
  const [draft, setDraft] = useState("");
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [filter, setFilter] = useState<ArticleListItem["stage"] | "all">("all");
  const [query, setQuery] = useState("");
  const [conversationCollapsed, setConversationCollapsed] = useState(() => {
    try { return localStorage.getItem("ocf-article-conversation-collapsed") === "1"; } catch { return false; }
  });
  const conversationToggle = useRef<HTMLButtonElement>(null);

  function showArticle(item: Article) {
    setArticle(item); setTitle(item.title); setSummary(item.summary); setDate(item.date);
    setDraft(item.markdown); setMessage(""); setPreview(false);
  }

  async function refreshItems(): Promise<void> {
    const result = await api<ArticleList>("/articles");
    setItems(result.items);
  }

  useEffect(() => {
    let active = true;
    void api<ArticleList>("/articles").then((result) => {
      if (!active) return;
      setItems(result.items);
      if (articleId && !result.items.some((item) => item.id === articleId) && result.items[0]) {
        onArticle(result.items[0].id, result.items[0].publicationId);
      }
    }).catch(() => { if (active) setMessage("文章列表加载失败"); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!articleId) { setArticle(null); return; }
    let active = true;
    if (article?.id !== articleId) setArticle(null);
    void api<Article>(`/articles/${articleId}`).then((item) => { if (active) showArticle(item); })
      .catch(() => { if (active) setMessage("文章加载失败"); });
    return () => { active = false; };
  }, [articleId]);

  const dirty = !!article && (draft !== article.markdown || title !== article.title ||
    summary !== article.summary || date !== article.date);

  useEffect(() => {
    if (!dirty || busy) return;
    const timer = window.setTimeout(() => { void save(); }, 1_200);
    return () => window.clearTimeout(timer);
  }, [article?.revision, article?.markdown, title, summary, date, draft, busy]);

  const articleReady = !!article && article.id === articleId && !dirty && !busy;
  const visibleItems = items.filter((item) => (filter === "all" || item.stage === filter) &&
    (!query.trim() || `${item.title} ${item.summary}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));

  function toggleConversation() {
    const next = !conversationCollapsed;
    setConversationCollapsed(next);
    try { localStorage.setItem("ocf-article-conversation-collapsed", next ? "1" : "0"); } catch { /* Storage is optional. */ }
    if (next) requestAnimationFrame(() => conversationToggle.current?.focus());
  }

  async function save(): Promise<boolean> {
    if (!article || !dirty || busy) return !dirty;
    setBusy(true); setMessage("");
    try {
      const item = await api<Article>(`/articles/${article.id}/draft`, {
        method: "PUT", body: { markdown: draft, title, summary, date, expectedRevision: article.revision },
      });
      setArticle(item);
      setMessage(`草稿已保存 · 修订 ${item.revision}`);
      await refreshItems();
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存失败");
      return false;
    } finally { setBusy(false); }
  }

  async function create() {
    if (busy) return;
    if (dirty && !(await save())) return;
    setBusy(true); setMessage("");
    try {
      const item = await api<Article>("/articles", { method: "POST", body: { sourceRef } });
      setArticle(null); onArticle(item.id);
      await refreshItems();
    } catch (error) { setMessage(error instanceof Error ? error.message : "创建失败"); }
    finally { setBusy(false); }
  }

  async function selectItem(item: ArticleListItem) {
    if (busy || item.id === articleId) return;
    if (dirty && !(await save())) return;
    setArticle(null); setPreview(false); setMessage("");
    onArticle(item.id, item.publicationId);
  }

  async function finalize() {
    if (!article) return;
    if (dirty) { setMessage("请先保存草稿"); return; }
    setBusy(true); setMessage("");
    try {
      const item = await api<Article>(`/articles/${article.id}/finalize`, {
        method: "POST", body: { expectedRevision: article.revision },
      });
      setArticle(item); setMessage("已定稿");
      await refreshItems();
    } catch (error) { setMessage(error instanceof Error ? error.message : "定稿检查失败"); }
    finally { setBusy(false); }
  }

  return <div className="article-workbench">
    <aside className="panel-card article-list" aria-label="文章列表">
      <div className="article-list-header"><div><span className="overline">WRITING PROJECTS</span><h2>文章列表</h2></div>
        <button className="primary-button" type="button" disabled={busy} onClick={() => void create()}>新建文章</button></div>
      <p className="muted article-list-intro">先创建空稿，边写边确定标题；每篇文章保留独立对话。</p>
      <label className="article-list-search">搜索文章<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="标题或摘要" /></label>
      <label className="article-list-filter">状态<select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}>
        <option value="all">全部 · {items.length}</option>{Object.entries(stages).map(([value, label]) =>
          <option key={value} value={value}>{label} · {items.filter((item) => item.stage === value).length}</option>)}</select></label>
      <div className="article-list-items">{visibleItems.length ? visibleItems.map((item) =>
        <button key={item.id} className={`article-list-item${item.id === articleId ? " active" : ""}`} type="button"
          aria-current={item.id === articleId ? "true" : undefined} disabled={busy} onClick={() => void selectItem(item)}>
          <span className="article-list-item-top"><strong>{item.title || "未命名文章"}</strong><span className={`article-stage ${item.stage}`}>{stages[item.stage]}</span></span>
          <span className="article-list-item-detail">{item.summary || (item.sourceRef ? "已关联来源" : "空白稿")}</span>
          <time dateTime={item.updatedAt}>{new Date(item.updatedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>
        </button>) : <div className="article-list-empty">{items.length ? "没有符合条件的文章" : "还没有文章。创建空稿即可开始写作。"}</div>}</div>
    </aside>

    {!article || article.id !== articleId ? <section className="panel-card article-start">
      <span className="onboarding-symbol"><WorkspaceIcon name="article" size={22} /></span>
      <h2>{articleId ? "正在加载文章" : "从一个想法开始"}</h2>
      <p className="muted">创建空白文章后即可编写正文、与智能体讨论。标题、公开摘要和发布日期可以稍后再定。</p>
      <div className="action-row"><button className="primary-button" type="button" disabled={busy} onClick={() => void create()}>创建空白稿</button>
        <button className="secondary-button" type="button" onClick={onOpenSources}>查看资料</button></div>
      {message && <p className="inline-message" role="status">{message}</p>}
    </section> : <div className={`article-workspace${conversationCollapsed ? " conversation-collapsed" : ""}`}>
      <div className="screen-stack article-editor">
        <section className="panel-card"><div className="section-heading"><div><span className="overline">EDITOR</span><h2>{article.title || "未命名文章"}</h2></div>
          <div className="article-heading-actions"><span className={`tag ${article.status === "final" ? "success" : "warning"}`}>{article.status === "final" ? "已定稿" : "草稿"} · v{article.revision}</span>
            {conversationCollapsed && <button ref={conversationToggle} className="toolbar-button" type="button" onClick={toggleConversation} aria-label="展开文章对话" aria-controls="article-conversation" aria-expanded={false}><WorkspaceIcon name="assistant" size={16} /><span>展开文章对话</span></button>}</div></div>
          <label className="article-title-field">文章标题<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="可先留空，写作过程中再确定标题" /></label>
          <details className="article-metadata"><summary>发布信息 <span>摘要与日期可在定稿前填写</span></summary>
            <div className="form-grid"><label>公开摘要<input value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="给读者看的简要说明" /></label>
              <label>发布日期<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label></div></details>
          <div className="article-source-line">{article.sourceRef ? <>来源：{article.sourceRef.vaultId} / {article.sourceRef.snapshot}</> : "尚未关联来源，可先写提纲和想法"}</div>
          <label className="editor-label">文章正文<textarea value={draft} onChange={(event) => setDraft(event.target.value)} aria-label="文章正文" placeholder="从想法、提纲或第一段开始……" spellCheck={false} /></label>
          <div className="action-row"><button className="secondary-button" disabled={busy || !dirty} onClick={() => void save()}>保存草稿</button>
            <button className="secondary-button" onClick={() => setPreview((value) => !value)}>本地预览</button>
            <button className="primary-button" disabled={busy || dirty || article.status === "final"} onClick={() => void finalize()}>定稿</button>
            {message && <span className="inline-message" role="status">{message}</span>}</div>
        </section>
        {preview && <section className="panel-card preview-panel"><div className="section-heading"><div><span className="overline">LOCAL PREVIEW</span><h2>Markdown 预览</h2></div></div><div className="markdown-body"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{ img: ({ src, ...props }) => <img {...props} src={src?.startsWith("assets/") ? `/api/v1/articles/${article.id}/asset?path=${encodeURIComponent(src)}` : src} /> }}>{draft}</Markdown></div></section>}
      </div>
      <ArticleConversation articleId={article.id} articleReady={articleReady} collapsed={conversationCollapsed} onCollapse={toggleConversation} />
    </div>}
  </div>;
}
