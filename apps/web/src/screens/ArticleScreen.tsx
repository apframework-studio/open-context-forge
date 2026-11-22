import { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, type Article, type ArticleList as ArticleListData, type ArticleListItem, type VaultList } from "../api";
import { articleBodyCharacterCount } from "../articleMarkdown";
import { ArticleMaterialsDrawer } from "../ArticleMaterialsDrawer";
import { ArticleMaterialReader, type RequestedWritingSource } from "../ArticleMaterialReader";
import { useArticleWriting } from "../useArticleWriting";
import { useWritingSelections } from "../useWritingSelections";
import { ArticleConversation } from "../ArticleConversation";
import { WorkspaceIcon } from "../WorkspaceIcon";
import { ArticleList } from "./ArticleList";
import { useLocale, type LocalizedError } from "../locale";

interface Props { articleId: string | null; vaults: VaultList | null;
  onArticle: (id: string) => void; onOpenSources: () => void;
  onOpenExport: (id: string) => void; onArticlesRemoved: (ids: string[]) => void }

type ArticleFeedback = { type: "saved" } | { type: "finalized" } | { type: "message"; copy: LocalizedError };

function articleTitleFromMarkdown(markdown: string): string | null {
  const withoutCodeBlocks = markdown.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, "");
  const heading = withoutCodeBlocks.match(/^#\s+(.+?)\s*#*\s*$/m)?.[1]?.trim();
  return heading || null;
}

function ArticleMarkdown({ content, articleId }: { content: string; articleId: string }) {
  return <div className="markdown-body article-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
    table: ({ children }) => <div className="article-table-scroll"><table>{children}</table></div>,
    img: ({ src, ...props }) => <img {...props} src={src?.startsWith("assets/") ? `/api/v1/articles/${articleId}/asset?path=${encodeURIComponent(src)}` : src} /> }}>{content}</Markdown></div>;
}

export function ArticleScreen({ articleId, vaults, onArticle, onOpenSources, onOpenExport, onArticlesRemoved }: Props) {
  const { locale, t, errorText } = useLocale();
  const [items, setItems] = useState<ArticleListItem[]>([]);
  const [article, setArticle] = useState<Article | null>(null);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [date, setDate] = useState("");
  const [draft, setDraft] = useState("");
  const [workspaceView, setWorkspaceView] = useState<"list" | "writing">(() => {
    if (articleId) return "writing";
    try { return sessionStorage.getItem("ocf-article-page") === "writing" ? "writing" : "list"; } catch { return "list"; }
  });
  const [mode, setMode] = useState<"write" | "read">("write");
  const [mobilePane, setMobilePane] = useState<"chat" | "document">("chat");
  const [focusChat, setFocusChat] = useState(false);
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [proposal, setProposal] = useState<string | null>(null);
  const [proposalHash, setProposalHash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<ArticleFeedback | null>(null);
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
  const titleInput = useRef<HTMLInputElement>(null);
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
  function showMessage(zh: string, en: string, cause?: unknown) { setFeedback({ type: "message", copy: [cause, zh, en] }); }
  async function openProposal(kind: "outline" | "draft", turnId: string) {
    if (!articleId) return;
    const id = articleId;
    try {
      const latest = await api<import("../api").WritingProposals>(`/articles/${id}/writing-proposals`);
      if (currentId.current !== id) return;
      const item = latest[kind];
      if (!item || item.turnId !== turnId) { showMessage("这轮产物已不可用，请查看当前文章的最新提案。", "This output is no longer available. Open the latest proposal for this article."); return; }
      setMode("write"); setRightTab(kind === "outline" ? "outline" : "body"); setFocusChat(false); setMobilePane("document");
      if (kind === "outline") setOutlineProposal(item.markdown);
      else { setProposalHash(item.sha256); setProposal(item.markdown); }
    } catch (error) { if (currentId.current === id) showMessage("产物读取失败", "Could not load the proposed draft", error); }
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
    setDraft(item.markdown); setFeedback(null); setMode("write"); setFocusChat(false); setMobilePane("chat");
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
    }).catch(() => { if (active) showMessage("文章列表加载失败", "Could not load the article list"); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!articleId) { setArticle(null); return; }
    if (article?.id === articleId) return;
    let active = true;
    if (article?.id !== articleId) setArticle(null);
    void api<Article>(`/articles/${articleId}`).then((item) => { if (active) showArticle(item); })
      .catch(() => { if (active) showMessage("文章加载失败", "Could not load the article"); });
    return () => { active = false; };
  }, [articleId]);

  const dirty = !!article && (draft.trim() !== article.markdown || title.trim() !== article.title || summary.trim() !== article.summary || date !== article.date);
  const needsTitle = !title.trim();
  const needsBody = !draft.replace(/^#{1,6}\s+.*$/gm, "").trim();
  const bodyCharacterCount = useMemo(() => articleBodyCharacterCount(draft, title), [draft, title]);
  useEffect(() => {
    if (!dirty || busy) return;
    const timer = window.setTimeout(() => { void save(); }, 1_200);
    return () => window.clearTimeout(timer);
  }, [article?.revision, article?.markdown, title, summary, date, draft, busy]);

  async function save(): Promise<boolean> {
    if (!article || busy) return false;
    if (!dirty) return true;
    setBusy(true); setFeedback(null);
    try {
      const item = await api<Article>(`/articles/${article.id}/draft`, { method: "PUT", body: {
        markdown: draft, title, summary, date, expectedRevision: article.revision,
      } });
      if (currentId.current === article.id) { setArticle(item); setFeedback({ type: "saved" }); }
      await refreshItems(); return true;
    } catch (error) { showMessage("保存失败", "Could not save the article", error); return false; }
    finally { setBusy(false); }
  }
  async function create() {
    if (busy || (dirty && !(await save()))) return;
    setBusy(true); setFeedback(null);
    try {
      const item = await api<Article>("/articles", { method: "POST", body: {} });
      showArticle(item); onArticle(item.id); navigate("writing"); await refreshItems();
    } catch (error) { showMessage("创建失败", "Could not create the article", error); }
    finally { setBusy(false); }
  }
  async function selectItem(item: ArticleListItem) {
    if (busy || (dirty && !(await save()))) return;
    if (item.id !== articleId) { setArticle(null); onArticle(item.id); }
    navigate("writing"); setMode("write"); setFocusChat(false);
  }
  async function backToList() { if (!busy && (!dirty || await save())) { navigate("list"); setFeedback(null); } }
  async function manageArticles(action: "trash" | "restore", targets: ArticleListItem[]) {
    if (busy) return;
    setBusy(true); setFeedback(null);
    try {
      const result = await api<{ changed: number }>("/articles/actions", { method: "POST", body: {
        action, items: targets.map((item) => ({ id: item.id, expectedRevision: item.revision })),
      } });
      if (action === "trash") onArticlesRemoved(targets.map((item) => item.id));
      await refreshItems();
      const articles = `${result.changed} ${result.changed === 1 ? "article" : "articles"}`;
      if (action === "trash") showMessage(`已将 ${result.changed} 篇文章移入回收站，可随时恢复`, `Moved ${articles} to trash. You can restore from trash at any time.`);
      else showMessage(`已恢复 ${result.changed} 篇文章`, `Restored ${articles}.`);
    } catch (error) {
      await refreshItems().catch(() => undefined);
      throw error;
    } finally { setBusy(false); }
  }
  async function permanentlyDelete(targets: ArticleListItem[]) {
    if (busy) return;
    setBusy(true); setFeedback(null);
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
      const articles = `${result.changed} ${result.changed === 1 ? "article" : "articles"}`;
      const workspaces = `${result.retainedWorkspaces} historical ${result.retainedWorkspaces === 1 ? "workspace" : "workspaces"}`;
      showMessage(
        `已永久删除 ${result.changed} 篇文章${result.cleanupPending ? "；部分本地文章文件暂未清理，将在下次启动时重试" : "，工作台文章文件已清理"}${result.retainedWorkspaces ? `；已保留 ${result.retainedWorkspaces} 个历史工作区` : ""}`,
        `Permanently deleted ${articles}. ${result.cleanupPending ? "The app will retry cleaning up remaining local files on restart." : "Workspace article files were removed."}${result.retainedWorkspaces ? ` Kept ${workspaces}.` : ""}`,
      );
    } catch (error) {
      await refreshItems().catch(() => undefined);
      throw error;
    } finally { setBusy(false); }
  }
  async function finalize() {
    if (!article || busy || dirty) return;
    if (needsTitle) {
      showMessage("定稿前请填写文章标题", "Enter an article title before finalizing");
      titleInput.current?.focus();
      return;
    }
    if (needsBody) { showMessage("定稿前请采用文章正文", "Adopt article text before finalizing"); return; }
    setBusy(true); setFeedback(null);
    try {
      const item = await api<Article>(`/articles/${article.id}/finalize`, { method: "POST", body: { expectedRevision: article.revision } });
      if (currentId.current === article.id) {
        setArticle(item);
        setDate((current) => current === date ? item.date : current);
        setFeedback({ type: "finalized" });
      }
      await refreshItems();
    } catch (error) { showMessage("定稿检查失败", "Could not finalize the article", error); }
    finally { setBusy(false); }
  }

  const message = !feedback ? "" : feedback.type === "message" ? errorText(...feedback.copy) : feedback.type === "saved" ? t("草稿已保存", "Draft saved") : t("已定稿", "Finalized");
  if (workspaceView === "list") return <ArticleList items={items} busy={busy} message={message} onCreate={() => void create()} onSelect={(item) => void selectItem(item)}
    onExport={(item) => onOpenExport(item.id)} onManage={manageArticles} onPermanentlyDelete={permanentlyDelete} />;
  if (!article || article.id !== articleId) return <div className="article-loading"><p>{message || t("正在打开文章…", "Opening article…")}</p>
    <button className="secondary-button" onClick={() => navigate("list")}>{t("返回文章列表", "Back to article list")}</button></div>;
  const outlineCandidate = writing.proposals.outline;
  const bodyCandidate = writing.proposals.draft;
  const pendingOutline = outlineCandidate && outlineCandidate.markdown !== outlineDraft &&
    !dismissed.includes(outlineCandidate.sha256) ? outlineCandidate : null;
  const pendingBody = bodyCandidate && bodyCandidate.markdown.trim() !== draft.trim() &&
    !dismissed.includes(bodyCandidate.sha256) ? bodyCandidate : null;
  const saveStatus = busy ? t("正在保存…", "Saving…") : dirty && feedback?.type !== "message" ?
    t("有未保存的修改", "Unsaved changes") : message || t("已自动保存", "Autosaved");
  const vaultCount = writing.context?.vaultIds.length ?? 0;
  const materialCount = writing.context?.materials.length ?? 0;
  const materialLabel = `${materialCount} ${materialCount === 1 ? "item" : "items"}`;
  return <div className="article-studio">
    <div className="article-studio-toolbar">
      <button className="article-back" type="button" aria-label={t("返回文章列表", "Back to article list")} title={t("返回文章列表", "Back to article list")} disabled={busy} onClick={() => void backToList()}><WorkspaceIcon name="chevronLeft" size={18} /><span>{t("文章列表", "Article list")}</span></button>
      <input ref={titleInput} className="article-inline-title" aria-label={t("文章标题", "Article title")} aria-required="true" aria-describedby={article.status === "draft" && needsTitle ? "article-required-title" : undefined}
        value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t("未命名文章", "Untitled article")} />
      <span className={`article-stage ${article.status === "final" ? "complete" : "writing"}`}>{article.status === "final" ? t("已定稿", "Finalized") : t("草稿", "Draft")}</span>
      <div className="article-save-line"><span role="status">{saveStatus}</span>
        <span>{t(`${bodyCharacterCount.toLocaleString(locale)} 字`, `${bodyCharacterCount.toLocaleString(locale)} ${bodyCharacterCount === 1 ? "character" : "characters"}`)}</span></div>
      <div className="article-mode-switch"><button type="button" aria-pressed={mode === "write"} onClick={() => { setMode("write"); setFocusChat(false); }}>{t("协作写作", "Collaborative writing")}</button>
        <button type="button" aria-pressed={mode === "read"} onClick={() => setMode("read")}>{t("阅读文章", "Read article")}</button></div>
      <div className="article-studio-actions"><button className="text-button" type="button" onClick={() => setMetadataOpen(true)}>{t("文章信息", "Article details")}</button>
        <button className="secondary-button" disabled={busy || !dirty} onClick={() => void save()}>{t("保存草稿", "Save draft")}</button>
        {article.status === "final" ? <button className="primary-button" disabled={busy || dirty} onClick={() => onOpenExport(article.id)}>{t("前往导出", "Go to export")}</button> :
          <button className="primary-button" disabled={busy || dirty} onClick={() => void finalize()}>{t("定稿", "Finalize")}</button>}</div>
    </div>
    <div className="article-context-bar"><button type="button" className="secondary-button" disabled={!writing.context || writing.busy} onClick={() => setMaterialsOpen(true)} aria-label={t("选择创作资料", "Writing materials")}>{t("选择创作资料", "Writing materials")}</button>
      <span title={writing.context?.vaultIds.join(t("、", ", "))}>{writing.context ? t(`${vaultCount} 个知识库 · ${materialCount} 篇资料`, `${vaultCount} ${vaultCount === 1 ? "knowledge base" : "knowledge bases"} · ${materialLabel}`) : t("正在恢复创作资料…", "Restoring writing materials…")}</span>
      <label className="article-writer-skill"><input type="checkbox" checked={!!writing.context?.skillEnabled && !!writing.skill?.available}
        disabled={!writing.context || !writing.skill?.available || writing.busy} onChange={() => void writing.toggleSkill()} />{t("使用写作技能", "Use writing skill")}
        {writing.skill?.available === false && <small>{t("不可用", "Unavailable")}</small>}</label></div>
    {article.status === "draft" && (needsTitle || needsBody) && <div className="article-finalize-guide" role="region" aria-label={t("定稿准备", "Before finalizing")}>
      <span>{needsTitle && <span id="article-required-title">{t("请填写文章标题。", "Enter an article title. ")}</span>}
        {needsBody && (pendingBody ? t("请审阅并采用正文。", "Review and adopt the article text.") : t("先在 AI 写作中起草正文，再审阅并采用。", "Draft the article in AI Writing, then review and adopt it."))}</span>
      {needsBody && (pendingBody
        ? <button className="text-button" onClick={() => { setProposalHash(pendingBody.sha256); setProposal(pendingBody.markdown); setMode("write"); setRightTab("body"); }}>{t("审阅并采用正文", "Review and adopt article text")}</button>
        : <button className="text-button" onClick={() => { setMode("write"); setFocusChat(true); setMobilePane("chat"); }}>{t("打开 AI 写作", "Open AI Writing")}</button>)}
    </div>}
    {writing.error && <p role="alert" className="inline-message error">{writing.error}</p>}
    {mode === "write" && <div className="article-mobile-tabs" role="tablist" aria-label={t("写作面板", "Writing panes")}>
      <button type="button" role="tab" aria-selected={mobilePane === "chat"} onClick={() => setMobilePane("chat")}>{t("AI 写作", "AI Writing")}</button>
      <button type="button" role="tab" aria-selected={mobilePane === "document"} onClick={() => { setMobilePane("document"); setFocusChat(false); }}>{t("文章正文", "Article text")}</button></div>}
    <div className={`article-writing-layout mode-${mode}${focusChat ? " focus-chat" : ""}`} data-mobile-pane={mobilePane}>
      {mode === "write" && <section className="article-manuscript" aria-label={t("文章文稿", "Article manuscript")}>
        <div className="article-manuscript-head"><div role="tablist" aria-label={t("创作阅读区", "Writing panels")}>{[["materials", t("资料阅读", "Materials")], ["outline", t("大纲", "Outline")], ["body", t("正文", "Article text")]].map(([value, label]) =>
          <button key={value} type="button" role="tab" aria-selected={rightTab === value} data-new={(value === "outline" && pendingOutline) || (value === "body" && pendingBody) ? true : undefined}
            onClick={() => setRightTab(value as typeof rightTab)}>{label}</button>)}</div>
          {rightTab === "body" && <button type="button" className="text-button" onClick={() => prepare(t(
            "请基于当前正文和我们的讨论修改正文，保留可核查的来源依据，并将可审阅的新版本写入本轮 article.md。",
            "Revise the current article based on our discussion. Keep verifiable source evidence and save the revision for review as article.md.",
          ))}>{t("讨论修改正文", "Discuss article revisions")}</button>}</div>
        <div className="article-right-panel" hidden={rightTab !== "materials"}><ArticleMaterialReader key={article.id} articleId={article.id} materials={writing.context?.materials ?? []} requestedSource={requestedSource}
          onQuote={(selection) => { pending.update([...pending.selections.filter((s) => s.materialId !== selection.materialId), selection]); prepare(t("请结合这个选段讨论：", "Discuss this excerpt:")); }} /></div>
        <div className="article-right-panel article-outline-panel" hidden={rightTab !== "outline"}>
          <div className="article-outline-toolbar"><span aria-label={t("大纲状态", "Outline status")}>{outlineDraft !== writing.outline?.markdown ? t("待保存的旧草稿", "Unsaved previous draft") : writing.outline?.approved ? t(`已确认 · v${writing.outline.revision}`, `Approved · v${writing.outline.revision}`) : t("待审阅", "Awaiting review")}</span>
            {outlineDraft !== writing.outline?.markdown && <button className="text-button" disabled={writing.busy || !writing.outline} onClick={() => void saveWritingOutline()}>{t("保存旧草稿", "Save previous draft")}</button>}
            <button className="text-button" onClick={() => prepare(t(
              "请根据当前大纲和我们的讨论修改大纲，列出主线、章节与对应证据，并将可审阅的新版本写入本轮 outline.md。",
              "Revise the outline based on our discussion. Include the main argument, sections, and supporting evidence. Save the revision for review as outline.md.",
            ))}>{t("讨论修改大纲", "Discuss outline revisions")}</button>
            <button className="secondary-button" disabled={writing.busy || !writing.outline || !outlineDraft.trim() || (writing.outline.approved && outlineDraft === writing.outline.markdown)} onClick={async () => {
              const approved = await saveWritingOutline(true);
              if (approved) prepare(t(
                "请按本轮已确认的大纲起草文章，结合所选资料，以 [S编号] 标注可回查的依据。将可审阅正文写入本轮 article.md。",
                "Draft the article from the approved outline and selected sources. Cite evidence as [S1], [S2], and so on. Save the draft for review as article.md.",
              ));
            }}>{t("确认大纲", "Approve outline")}</button></div>
          {pendingOutline && <section className={`article-proposal-inline${outlineDraft ? "" : " fill-panel"}`} aria-label={t("待采用大纲预览", "Proposed outline preview")}>
            <header><strong>{t("智能体提纲 · 待采用", "Assistant outline · Awaiting adoption")}</strong><button className="text-button" onClick={() => setOutlineProposal(pendingOutline.markdown)}>{t("审阅大纲草案", "Review proposed outline")}</button>
              <button className="text-button" onClick={() => setDismissed((value) => [...value, pendingOutline.sha256])}>{t("忽略", "Dismiss")}</button></header>
            <ArticleMarkdown content={pendingOutline.markdown} articleId={article.id} /></section>}
          {outlineDraft && <section className="article-document-preview" aria-label={t("文章大纲", "Article outline")}><ArticleMarkdown content={outlineDraft} articleId={article.id} /></section>}
        </div>
        <div className="article-right-panel" hidden={rightTab !== "body"}>
          {pendingBody && <section className={`article-proposal-inline${draft ? "" : " fill-panel"}`} aria-label={t("待采用正文预览", "Proposed article preview")}>
            <header><strong>{t("智能体正文 · 待采用", "Assistant draft · Awaiting adoption")}</strong><button className="text-button" onClick={() => { setProposalHash(pendingBody.sha256); setProposal(pendingBody.markdown); }}>{t("审阅正文草稿", "Review proposed article")}</button>
              <button className="text-button" onClick={() => setDismissed((value) => [...value, pendingBody.sha256])}>{t("忽略", "Dismiss")}</button></header>
            <ArticleMarkdown content={pendingBody.markdown} articleId={article.id} /></section>}
          {draft && <section className="article-document-preview" aria-label={t("文章正文", "Article text")}><ArticleMarkdown content={draft} articleId={article.id} /></section>}</div>
      </section>}
      {mode === "read" && <section className="article-reader" aria-label={t("文章阅读", "Article reading view")}><div className="article-reading-paper">
        {draft ? <ArticleMarkdown content={draft} articleId={article.id} /> : <div className="article-reader-empty"><h2>{title || t("未命名文章", "Untitled article")}</h2><p>{t("正文尚未开始。", "This article has no draft yet.")}</p>
          <button className="secondary-button" onClick={() => setMode("write")}>{t("开始写作", "Start writing")}</button></div>}
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
    {outlineProposal !== null && <div className="modal-backdrop article-dialog-backdrop"><section className="confirm-modal article-proposal-dialog" role="dialog" aria-modal="true" aria-label={t("采用大纲草案", "Adopt proposed outline")}>
      <h2>{t("审阅大纲草案", "Review proposed outline")}</h2><p>{t("采用后替换当前大纲草稿，确认主线后再起草正文。", "This replaces the current outline draft. Approve the outline before drafting the article.")}</p><div className="article-proposal-preview"><ArticleMarkdown content={outlineProposal} articleId={article.id} /></div>
      <div className="action-row"><button className="secondary-button" onClick={() => setOutlineProposal(null)}>{t("取消", "Cancel")}</button><button className="primary-button" disabled={writing.busy} onClick={async () => {
        const id = article.id, value = outlineProposal; const saved = await saveWritingOutline(false, value);
        if (saved && currentId.current === id) { setOutlineProposal(null); if (writing.proposals.outline) setDismissed((v) => [...v, writing.proposals.outline!.sha256]); }
      }}>{t("采用大纲", "Adopt outline")}</button></div></section></div>}
    {metadataOpen && <div className="modal-backdrop article-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setMetadataOpen(false); }}>
      <section className="confirm-modal article-metadata-dialog" role="dialog" aria-modal="true" aria-label={t("文章信息", "Article details")}><h2>{t("文章信息", "Article details")}</h2>
        <p>{t("摘要选填。日期留空时，定稿将使用当天日期。", "The summary is optional. Finalizing uses today's date if you leave it blank.")}</p><div className="form-grid"><label>{t("文章摘要", "Article summary")}<input value={summary} onChange={(event) => setSummary(event.target.value)} placeholder={t("给读者看的简要说明", "A short description for readers")} /></label>
          <label>{t("文章日期", "Article date")}<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label></div>
        <details className="article-context-details"><summary>{t(`创作资料 · ${materialCount} 篇`, `Writing materials · ${materialLabel}`)}</summary>
          {writing.context?.materials.length ? writing.context.materials.map((m) => <p key={m.id}>{m.id} · {m.vaultId} / {m.path}</p>) : <button className="text-button" onClick={onOpenSources}>{t("查看资料与分析", "View sources and analysis")}</button>}</details>
        <div className="action-row"><button className="primary-button" type="button" onClick={() => setMetadataOpen(false)}>{t("完成设置", "Done")}</button></div></section></div>}
    {proposal !== null && <div className="modal-backdrop article-dialog-backdrop"><section className="confirm-modal article-proposal-dialog" role="dialog" aria-modal="true" aria-label={t("采用智能体正文", "Adopt assistant draft")}>
      <h2>{t("采用智能体正文", "Adopt assistant draft")}</h2><p>{t("确认后将使用下方文稿替换当前正文。后续修改可继续在右侧讨论。", "This replaces the current article text with the draft below. Use the conversation to discuss revisions.")}</p><div className="article-proposal-preview"><ArticleMarkdown content={proposal} articleId={article.id} /></div>
      <div className="action-row"><button className="secondary-button" onClick={() => setProposal(null)}>{t("取消", "Cancel")}</button><button className="primary-button" onClick={() => {
        const heading = articleTitleFromMarkdown(proposal);
        setDraft(proposal); if (heading && (!title.trim() || title.trim() === "未命名文章")) setTitle(heading); if (proposalHash) setDismissed((v) => [...v, proposalHash]); setProposal(null); setProposalHash(null); setMode("write"); setRightTab("body"); setFocusChat(false); setMobilePane("document");
      }}>{t("替换正文", "Replace article text")}</button></div></section></div>}
  </div>;
}
