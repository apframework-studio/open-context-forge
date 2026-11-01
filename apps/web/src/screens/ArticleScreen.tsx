import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, type Article, type ArticleList as ArticleListData, type ArticleListItem, type SourceRef, type VaultList } from "../api";
import { ArticleMaterialsDrawer } from "../ArticleMaterialsDrawer";
import { ArticleMaterialReader, type RequestedWritingSource } from "../ArticleMaterialReader";
import { useArticleWriting } from "../useArticleWriting";
import { useWritingSelections } from "../useWritingSelections";
import { ArticleConversation } from "../ArticleConversation";
import { WorkspaceIcon } from "../WorkspaceIcon";
import { ArticleList } from "./ArticleList";

interface Props { sourceRef: SourceRef | null; articleId: string | null; vaults: VaultList | null;
  onArticle: (id: string, publicationId?: string | null) => void; onOpenSources: () => void;
  onOpenPublish: (item: ArticleListItem) => void; onArticlesRemoved: (ids: string[]) => void }

function ArticleMarkdown({ content, articleId }: { content: string; articleId: string }) {
  return <div className="markdown-body"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{ img: ({ src, ...props }) =>
    <img {...props} src={src?.startsWith("assets/") ? `/api/v1/articles/${articleId}/asset?path=${encodeURIComponent(src)}` : src} /> }}>{content}</Markdown></div>;
}

export function ArticleScreen({ articleId, vaults, onArticle, onOpenSources, onOpenPublish, onArticlesRemoved }: Props) {
  const [items, setItems] = useState<ArticleListItem[]>([]);
  const [article, setArticle] = useState<Article | null>(null);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [date, setDate] = useState("");
  const [draft, setDraft] = useState("");
  const [workspaceView, setWorkspaceView] = useState<"list" | "writing">(() => {
    try { return articleId && sessionStorage.getItem("ocf-article-page") === "writing" ? "writing" : "list"; } catch { return "list"; }
  });
  const [mode, setMode] = useState<"write" | "read">("write");
  const [mobilePane, setMobilePane] = useState<"chat" | "document">("chat");
  const [focusChat, setFocusChat] = useState(false);
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [proposal, setProposal] = useState<string | null>(null);
  const [proposalHash, setProposalHash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [materialsOpen, setMaterialsOpen] = useState(false);
  const [rightTab, setRightTab] = useState<"materials" | "outline" | "body">("body");
  const [requestedSource, setRequestedSource] = useState<RequestedWritingSource | null>(null);
  const [preset, setPreset] = useState<{ text: string; token: number } | null>(null);
  const [outlineDraft, setOutlineDraft] = useState("");
  // Keep edit generations in memory too: browser storage is optional, and a save
  // response only owns the draft version that was present when it was submitted.
  const outlineEdits = useRef(new Map<string, { value: string; version: number }>());
  const hydratedOutlines = useRef(new Set<string>());
  const [outlineProposal, setOutlineProposal] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const currentId = useRef(articleId); currentId.current = articleId;
  const writingId = workspaceView === "writing" && article?.id === articleId ? articleId : null;
  const writing = useArticleWriting(writingId);
  const pending = useWritingSelections(writingId, writing.context);
  useEffect(() => {
    setMaterialsOpen(false); setRequestedSource(null); setPreset(null); setOutlineProposal(null); setProposal(null); setProposalHash(null); setMetadataOpen(false); setDismissed([]); setRightTab("body");
  }, [articleId]);
  useEffect(() => {
    if (!writing.outline || !writingId) { setOutlineDraft(""); return; }
    let local = outlineEdits.current.get(writingId);
    if (!local && !hydratedOutlines.current.has(writingId)) {
      let cached: string | null = null;
      try { cached = sessionStorage.getItem(`ocf-outline-draft:${writingId}`); } catch { /* Optional. */ }
      if (cached !== null) { local = { value: cached, version: 0 }; outlineEdits.current.set(writingId, local); }
      hydratedOutlines.current.add(writingId);
    }
    setOutlineDraft(local?.value ?? writing.outline.markdown);
  }, [writingId, writing.outline?.revision]);
  async function saveWritingOutline(approve = false, replacement?: string) {
    const id = writingId;
    const submittedEdit = id ? outlineEdits.current.get(id) : undefined;
    const value = replacement ?? submittedEdit?.value ?? outlineDraft;
    const result = await writing.saveOutline(value, approve);
    if (result && id && currentId.current === id && outlineEdits.current.get(id) === submittedEdit) {
      outlineEdits.current.delete(id);
      try {
        // An explicit adoption can replace the prior cached draft too, provided
        // no new editor generation appeared while that adoption was in flight.
        if (sessionStorage.getItem(`ocf-outline-draft:${id}`) === (submittedEdit?.value ?? value)) sessionStorage.removeItem(`ocf-outline-draft:${id}`);
      } catch { /* Optional. */ }
      setOutlineDraft(result.markdown);
    }
    return result;
  }
  function openSource(materialId: string, turnId?: string, startLine?: number) {
    setRequestedSource({ materialId, turnId, startLine, token: Date.now() }); setRightTab("materials"); setFocusChat(false); setMobilePane("document");
  }
  async function openProposal(kind: "outline" | "draft", turnId: string) {
    if (!articleId) return;
    const id = articleId;
    try {
      const latest = await api<import("../api").WritingProposals>(`/articles/${id}/writing-proposals`);
      if (currentId.current !== id) return;
      const item = latest[kind];
      if (!item || item.turnId !== turnId) { setMessage("这轮产物已不可用，请查看当前文章的最新提案。"); return; }
      setMode("write"); setRightTab(kind === "outline" ? "outline" : "body"); setFocusChat(false); setMobilePane("document");
      if (kind === "outline") setOutlineProposal(item.markdown);
      else { setProposalHash(item.sha256); setProposal(item.markdown); }
    } catch (error) { if (currentId.current === id) setMessage(error instanceof Error ? error.message : "产物读取失败"); }
  }
  function prepare(text: string) { setPreset({ text, token: Date.now() }); setMobilePane("chat"); }
  async function beforeSend() {
    if (!(await save())) return false;
    if (writing.outline && outlineDraft !== writing.outline.markdown && !(await saveWritingOutline())) return false;
    return true;
  }
  useEffect(() => {
    if (!metadataOpen && proposal === null && outlineProposal === null) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") { setMetadataOpen(false); setProposal(null); setOutlineProposal(null); } };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [metadataOpen, proposal, outlineProposal]);

  function navigate(view: "list" | "writing") {
    setWorkspaceView(view);
    try { sessionStorage.setItem("ocf-article-page", view); } catch { /* Optional view preference. */ }
  }
  function showArticle(item: Article) {
    setArticle(item); setTitle(item.title); setSummary(item.summary); setDate(item.date);
    setDraft(item.markdown); setMessage(""); setMode("write"); setFocusChat(false); setMobilePane("chat");
  }
  async function refreshItems() { setItems((await api<ArticleListData>("/articles?includeTrashed=true")).items); }
  useEffect(() => {
    let active = true;
    void api<ArticleListData>("/articles?includeTrashed=true").then((result) => {
      if (!active) return;
      setItems(result.items);
      if (articleId && !result.items.some((item) => item.id === articleId && !item.trashedAt)) {
        navigate("list"); onArticlesRemoved([articleId]);
      }
    }).catch(() => { if (active) setMessage("文章列表加载失败"); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!articleId) { setArticle(null); return; }
    if (article?.id === articleId) return;
    let active = true;
    if (article?.id !== articleId) setArticle(null);
    void api<Article>(`/articles/${articleId}`).then((item) => { if (active) showArticle(item); })
      .catch(() => { if (active) setMessage("文章加载失败"); });
    return () => { active = false; };
  }, [articleId]);

  const dirty = !!article && (draft !== article.markdown || title !== article.title || summary !== article.summary || date !== article.date);
  useEffect(() => {
    if (!dirty || busy) return;
    const timer = window.setTimeout(() => { void save(); }, 1_200);
    return () => window.clearTimeout(timer);
  }, [article?.revision, article?.markdown, title, summary, date, draft, busy]);

  async function save(): Promise<boolean> {
    if (!article || busy) return false;
    if (!dirty) return true;
    setBusy(true); setMessage("");
    try {
      const item = await api<Article>(`/articles/${article.id}/draft`, { method: "PUT", body: {
        markdown: draft, title, summary, date, expectedRevision: article.revision,
      } });
      if (currentId.current === article.id) { setArticle(item); setMessage(`草稿已保存 · 修订 ${item.revision}`); }
      await refreshItems(); return true;
    } catch (error) { setMessage(error instanceof Error ? error.message : "保存失败"); return false; }
    finally { setBusy(false); }
  }
  async function create() {
    if (busy || (dirty && !(await save()))) return;
    setBusy(true); setMessage("");
    try {
      const item = await api<Article>("/articles", { method: "POST", body: {} });
      showArticle(item); onArticle(item.id); navigate("writing"); await refreshItems();
    } catch (error) { setMessage(error instanceof Error ? error.message : "创建失败"); }
    finally { setBusy(false); }
  }
  async function selectItem(item: ArticleListItem) {
    if (busy || (dirty && !(await save()))) return;
    if (item.id !== articleId) { setArticle(null); onArticle(item.id, item.publicationId); }
    navigate("writing"); setMode("write"); setFocusChat(false);
  }
  async function backToList() { if (!busy && (!dirty || await save())) { navigate("list"); setMessage(""); } }
  async function manageArticles(action: "trash" | "restore", targets: ArticleListItem[]) {
    if (busy) return;
    setBusy(true); setMessage("");
    try {
      const result = await api<{ changed: number }>("/articles/actions", { method: "POST", body: {
        action, items: targets.map((item) => ({ id: item.id, expectedRevision: item.revision })),
      } });
      if (action === "trash") onArticlesRemoved(targets.map((item) => item.id));
      await refreshItems();
      setMessage(action === "trash" ? `已将 ${result.changed} 篇文章移入回收站，可随时恢复` : `已恢复 ${result.changed} 篇文章`);
    } catch (error) {
      await refreshItems().catch(() => undefined);
      throw error;
    } finally { setBusy(false); }
  }
  async function permanentlyDelete(targets: ArticleListItem[]) {
    if (busy) return;
    setBusy(true); setMessage("");
    try {
      const result = await api<{ changed: number; cleanupPending: number; retainedWorkspaces: number }>("/articles/trash/empty", { method: "POST", body: {
        confirmed: true, items: targets.map((item) => ({ id: item.id, expectedRevision: item.revision, expectedTrashedAt: item.trashedAt })),
      } });
      for (const { id } of targets) {
        outlineEdits.current.delete(id); hydratedOutlines.current.delete(id);
        try { sessionStorage.removeItem(`ocf-outline-draft:${id}`); sessionStorage.removeItem(`ocf-writing-selections:${id}`); } catch { /* Optional. */ }
      }
      onArticlesRemoved(targets.map((item) => item.id));
      await refreshItems();
      setMessage(`已永久删除 ${result.changed} 篇文章${result.cleanupPending ? "；部分本地文章文件暂未清理，将在下次启动时重试" : "，工作台文章文件已清理"}${result.retainedWorkspaces ? `；已保留 ${result.retainedWorkspaces} 个博客发布工作区` : ""}`);
    } catch (error) {
      await refreshItems().catch(() => undefined);
      throw error;
    } finally { setBusy(false); }
  }
  async function finalize() {
    if (!article) return;
    if (dirty) { setMessage("请先保存草稿"); return; }
    setBusy(true); setMessage("");
    try {
      const item = await api<Article>(`/articles/${article.id}/finalize`, { method: "POST", body: { expectedRevision: article.revision } });
      setArticle(item); setMessage("已定稿"); await refreshItems();
    } catch (error) { setMessage(error instanceof Error ? error.message : "定稿检查失败"); }
    finally { setBusy(false); }
  }

  if (workspaceView === "list") return <ArticleList items={items} busy={busy} message={message} onCreate={() => void create()} onSelect={(item) => void selectItem(item)}
    onPublish={onOpenPublish} onManage={manageArticles} onPermanentlyDelete={permanentlyDelete} />;
  if (!article || article.id !== articleId) return <div className="article-loading"><p>{message || "正在打开文章…"}</p>
    <button className="secondary-button" onClick={() => navigate("list")}>返回文章列表</button></div>;
  const outlineCandidate = writing.proposals.outline;
  const bodyCandidate = writing.proposals.draft;
  const pendingOutline = outlineCandidate && outlineCandidate.markdown !== outlineDraft &&
    !dismissed.includes(outlineCandidate.sha256) ? outlineCandidate : null;
  const pendingBody = bodyCandidate && bodyCandidate.markdown !== draft &&
    !dismissed.includes(bodyCandidate.sha256) ? bodyCandidate : null;
  return <div className="article-studio">
    <div className="article-studio-toolbar">
      <button className="article-back" type="button" aria-label="返回文章列表" title="返回文章列表" disabled={busy} onClick={() => void backToList()}><WorkspaceIcon name="chevronLeft" size={18} /><span>文章列表</span></button>
      <input className="article-inline-title" aria-label="文章标题" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="未命名文章" />
      <span className={`article-stage ${article.status === "final" ? "complete" : "writing"}`}>{article.status === "final" ? "已定稿" : "草稿"}</span>
      <div className="article-mode-switch"><button type="button" aria-pressed={mode === "write"} onClick={() => { setMode("write"); setFocusChat(false); }}>协作写作</button>
        <button type="button" aria-pressed={mode === "read"} onClick={() => setMode("read")}>阅读文章</button></div>
      <div className="article-studio-actions"><button className="text-button" type="button" onClick={() => setMetadataOpen(true)}>发布信息</button>
        <button className="secondary-button" disabled={busy || !dirty} onClick={() => void save()}>保存草稿</button>
        <button className="primary-button" disabled={busy || dirty || article.status === "final"} onClick={() => void finalize()}>定稿</button></div>
    </div>
    <div className="article-save-line"><span role="status">{message || (busy ? "正在保存…" : dirty ? "有未保存的修改" : `已自动保存 · v${article.revision}`)}</span>
      <span>{draft.replace(/\s/g, "").length.toLocaleString()} 字</span></div>
    <div className="article-context-bar"><button type="button" className="secondary-button" disabled={!writing.context || writing.busy} onClick={() => setMaterialsOpen(true)} aria-label="选择创作资料">选择创作资料</button>
      <span title={writing.context?.vaultIds.join("、")}>{writing.context ? `${writing.context.vaultIds.length} 个知识库 · ${writing.context.materials.length} 篇资料` : "正在恢复创作资料…"}</span>
      <label className="article-writer-skill" title={writing.skill?.path ?? "本机未找到 tech-article-writer，将使用普通写作对话"}><input type="checkbox" aria-label="请求使用文章写作技能" checked={!!writing.context?.skillEnabled && !!writing.skill?.available}
        disabled={!writing.context || !writing.skill?.available || writing.busy} onChange={() => void writing.toggleSkill()} />请求写作技能 <small>{writing.skill?.available ? "本机可用" : "未检测到"}</small></label></div>
    {writing.error && <p role="alert" className="inline-message error">{writing.error}</p>}
    {mode === "write" && <div className="article-mobile-tabs" role="tablist" aria-label="写作面板">
      <button type="button" role="tab" aria-selected={mobilePane === "chat"} onClick={() => setMobilePane("chat")}>AI 写作</button>
      <button type="button" role="tab" aria-selected={mobilePane === "document"} onClick={() => { setMobilePane("document"); setFocusChat(false); }}>文章正文</button></div>}
    <div className={`article-writing-layout mode-${mode}${focusChat ? " focus-chat" : ""}`} data-mobile-pane={mobilePane}>
      {mode === "write" && <section className="article-manuscript" aria-label="文章文稿">
        <div className="article-manuscript-head"><div role="tablist" aria-label="创作阅读区">{[["materials", "资料阅读"], ["outline", "大纲"], ["body", "正文"]].map(([value, label]) =>
          <button key={value} type="button" role="tab" aria-selected={rightTab === value} data-new={(value === "outline" && pendingOutline) || (value === "body" && pendingBody) ? true : undefined}
            onClick={() => setRightTab(value as typeof rightTab)}>{label}</button>)}</div>
          {rightTab === "body" && <button type="button" className="text-button" onClick={() => prepare("请基于当前正文和我们的讨论修改正文，保留可核查的来源依据，并将可审阅的新版本写入本轮 article.md。")}>讨论修改正文</button>}</div>
        <div className="article-right-panel" hidden={rightTab !== "materials"}><ArticleMaterialReader key={article.id} articleId={article.id} materials={writing.context?.materials ?? []} requestedSource={requestedSource}
          onQuote={(selection) => { pending.update([...pending.selections.filter((s) => s.materialId !== selection.materialId), selection]); prepare("请结合这个选段讨论："); }} /></div>
        <div className="article-right-panel article-outline-panel" hidden={rightTab !== "outline"}>
          <div className="article-outline-toolbar"><span aria-label="大纲状态">{outlineDraft !== writing.outline?.markdown ? "待保存的旧草稿" : writing.outline?.approved ? `已确认 · v${writing.outline.revision}` : "待审阅"}</span>
            {outlineDraft !== writing.outline?.markdown && <button className="text-button" disabled={writing.busy || !writing.outline} onClick={() => void saveWritingOutline()}>保存旧草稿</button>}
            <button className="text-button" onClick={() => prepare("请根据当前大纲和我们的讨论修改大纲，列出主线、章节与对应证据，并将可审阅的新版本写入本轮 outline.md。")}>讨论修改大纲</button>
            <button className="secondary-button" disabled={writing.busy || !writing.outline || !outlineDraft.trim() || (writing.outline.approved && outlineDraft === writing.outline.markdown)} onClick={() => void saveWritingOutline(true)}>确认大纲</button></div>
          {pendingOutline && <section className={`article-proposal-inline${outlineDraft ? "" : " fill-panel"}`} aria-label="待采用大纲预览">
            <header><strong>智能体提纲 · 待采用</strong><button className="text-button" onClick={() => setOutlineProposal(pendingOutline.markdown)}>审阅大纲草案</button>
              <button className="text-button" onClick={() => setDismissed((value) => [...value, pendingOutline.sha256])}>忽略</button></header>
            <ArticleMarkdown content={pendingOutline.markdown} articleId={article.id} /></section>}
          {outlineDraft && <section className="article-document-preview" aria-label="文章大纲"><ArticleMarkdown content={outlineDraft} articleId={article.id} /></section>}
          <div className="article-outline-foot"><small>采用新大纲或更换创作资料后，需要重新确认。</small><button className="primary-button" disabled={!writing.outline?.approved || outlineDraft !== writing.outline.markdown} onClick={() => prepare("请按本轮已确认的大纲起草文章，结合所选资料，以 [S编号] 标注可回查的依据。将可审阅正文写入本轮 article.md，暂不发布。")}>按大纲起草正文</button></div>
        </div>
        <div className="article-right-panel" hidden={rightTab !== "body"}>
          {pendingBody && <section className={`article-proposal-inline${draft ? "" : " fill-panel"}`} aria-label="待采用正文预览">
            <header><strong>智能体正文 · 待采用</strong><button className="text-button" onClick={() => { setProposalHash(pendingBody.sha256); setProposal(pendingBody.markdown); }}>审阅正文草稿</button>
              <button className="text-button" onClick={() => setDismissed((value) => [...value, pendingBody.sha256])}>忽略</button></header>
            <ArticleMarkdown content={pendingBody.markdown} articleId={article.id} /></section>}
          {draft && <section className="article-document-preview" aria-label="文章正文"><ArticleMarkdown content={draft} articleId={article.id} /></section>}</div>
      </section>}
      {mode === "read" && <section className="article-reader" aria-label="文章阅读"><div className="article-reading-paper">
        {draft ? <ArticleMarkdown content={draft} articleId={article.id} /> : <div className="article-reader-empty"><h2>{title || "未命名文章"}</h2><p>正文尚未开始。</p>
          <button className="secondary-button" onClick={() => setMode("write")}>开始写作</button></div>}
      </div></section>}
      <ArticleConversation key={article.id} articleId={article.id} saving={busy || writing.busy} onBeforeSend={beforeSend} hidden={mode === "read"}
        materials={writing.context?.materials} selections={pending.selections} contextReady={pending.ready} onSelectionsChange={pending.update} onOpenMaterials={() => setMaterialsOpen(true)}
        onOpenSource={openSource} onOpenProposal={(kind, turnId) => void openProposal(kind, turnId)} preset={preset} focused={focusChat} onFocus={() => setFocusChat((value) => !value)}
        onUseText={(text) => { setProposalHash(null); setProposal(text); }} onUseOutline={(text) => {
          setOutlineProposal(text); setMode("write"); setRightTab("outline"); setFocusChat(false); setMobilePane("document");
        }} />
    </div>
    {materialsOpen && writing.context && <ArticleMaterialsDrawer key={article.id} articleId={article.id} vaults={vaults} context={writing.context} onClose={() => setMaterialsOpen(false)} onApply={(context) => {
      pending.update(context.materials.map((m) => ({ materialId: m.id })), context); writing.appliedContext(context); setMaterialsOpen(false); setRightTab("materials"); setFocusChat(false);
    }} />}
    {outlineProposal !== null && <div className="modal-backdrop article-dialog-backdrop"><section className="confirm-modal article-proposal-dialog" role="dialog" aria-modal="true" aria-label="采用大纲草案">
      <h2>审阅大纲草案</h2><p>采用后替换当前大纲草稿，确认主线后再起草正文。</p><div className="article-proposal-preview"><ArticleMarkdown content={outlineProposal} articleId={article.id} /></div>
      <div className="action-row"><button className="secondary-button" onClick={() => setOutlineProposal(null)}>取消</button><button className="primary-button" disabled={writing.busy} onClick={async () => {
        const id = article.id, value = outlineProposal; const saved = await saveWritingOutline(false, value);
        if (saved && currentId.current === id) { setOutlineProposal(null); if (writing.proposals.outline) setDismissed((v) => [...v, writing.proposals.outline!.sha256]); }
      }}>采用大纲</button></div></section></div>}
    {metadataOpen && <div className="modal-backdrop article-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setMetadataOpen(false); }}>
      <section className="confirm-modal article-metadata-dialog" role="dialog" aria-modal="true" aria-label="发布信息"><h2>发布信息</h2>
        <p>写作过程中可以留空，定稿前再补齐。</p><div className="form-grid"><label>公开摘要<input value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="给读者看的简要说明" /></label>
          <label>发布日期<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label></div>
        <details className="article-context-details"><summary>创作资料 · {writing.context?.materials.length ?? 0} 篇</summary>
          {writing.context?.materials.length ? writing.context.materials.map((m) => <p key={m.id}>{m.id} · {m.vaultId} / {m.path}</p>) : <button className="text-button" onClick={onOpenSources}>查看资料与分析</button>}</details>
        <div className="action-row"><button className="primary-button" type="button" onClick={() => setMetadataOpen(false)}>完成设置</button></div></section></div>}
    {proposal !== null && <div className="modal-backdrop article-dialog-backdrop"><section className="confirm-modal article-proposal-dialog" role="dialog" aria-modal="true" aria-label="采用智能体正文">
      <h2>采用智能体正文</h2><p>确认后将用这条回复替换当前正文。后续修改可继续在右侧讨论。</p><div className="article-proposal-preview"><ArticleMarkdown content={proposal} articleId={article.id} /></div>
      <div className="action-row"><button className="secondary-button" onClick={() => setProposal(null)}>取消</button><button className="primary-button" onClick={() => {
        setDraft(proposal); if (proposalHash) setDismissed((v) => [...v, proposalHash]); setProposal(null); setProposalHash(null); setMode("write"); setRightTab("body"); setFocusChat(false); setMobilePane("document");
      }}>替换正文</button></div></section></div>}
  </div>;
}
