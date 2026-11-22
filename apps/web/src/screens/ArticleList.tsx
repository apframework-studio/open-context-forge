import { useEffect, useState } from "react";
import type { ArticleListItem } from "../api";
import { WorkbenchSelect } from "../WorkbenchSelect";
import { WorkspaceIcon } from "../WorkspaceIcon";
import { useLocale, type LocalizedError } from "../locale";

const displayStage = (item: ArticleListItem) => item.status === "final" ? "complete" : item.stage === "new" ? "new" : "writing";

interface Props {
  items: ArticleListItem[]; busy: boolean; message: string; onCreate: () => void;
  onSelect: (item: ArticleListItem) => void; onExport: (item: ArticleListItem) => void;
  onManage: (action: "trash" | "restore", items: ArticleListItem[]) => Promise<void>;
  onPermanentlyDelete: (items: ArticleListItem[]) => Promise<void>;
}

export function ArticleList({ items, busy, message, onCreate, onSelect, onExport, onManage, onPermanentlyDelete }: Props) {
  const { locale, t, errorText } = useLocale();
  const articleStages = { new: t("新建", "New"), writing: t("写作中", "In progress"), complete: t("已定稿", "Finalized") };
  const untitled = t("未命名文章", "Untitled article");
  const [view, setView] = useState<"active" | "trash">("active");
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmation, setConfirmation] = useState<{ action: "empty" | "purge"; items: ArticleListItem[] } | null>(null);
  const [failure, setError] = useState<LocalizedError | null>(null);
  const error = failure ? errorText(...failure) : "";
  const viewItems = items.filter((item) => !!item.trashedAt === (view === "trash"));
  const filtered = viewItems.filter((item) => (filter === "all" || displayStage(item) === filter) &&
    (!query.trim() || `${item.title} ${item.summary}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));
  const pages = Math.max(1, Math.ceil(filtered.length / 12));
  const currentPage = Math.min(page, pages);
  const rows = filtered.slice((currentPage - 1) * 12, currentPage * 12);
  const chosen = viewItems.filter((item) => selected.has(item.id));
  const pageSelected = rows.length > 0 && rows.every((item) => selected.has(item.id));
  useEffect(() => {
    if (!confirmation) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) setConfirmation(null); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [confirmation, busy]);
  function switchView(next: "active" | "trash") { setView(next); setSelected(new Set()); setPage(1); setError(null); }
  function toggle(id: string) { setSelected((previous) => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
  async function manage(action: "trash" | "restore", targets: ArticleListItem[]) {
    setError(null);
    try { await onManage(action, targets); setConfirmation(null); setSelected(new Set()); }
    catch (cause) { setConfirmation(null); setError([cause, "操作失败，请重试", "Could not complete the action. Try again."]); }
  }
  async function permanentlyDelete(targets: ArticleListItem[], clearAll: boolean) {
    setError(null);
    try { await onPermanentlyDelete(targets); setConfirmation(null); setSelected(new Set()); if (clearAll) setPage(1); }
    catch (cause) { setConfirmation(null); setError([cause, "永久删除失败，请重试", "Could not permanently delete the articles. Try again."]); }
  }

  return <div className="article-index">
    <div className="article-index-toolbar"><p role={message ? "status" : undefined}>{message || t("从一个想法开始，每篇文章都有独立的文稿与对话。", "Start with an idea. Each article has its own draft and conversation.")}</p>
      <button className="primary-button" type="button" disabled={busy} onClick={onCreate}>{t("新建文章", "New article")}</button></div>
    {error && !confirmation && <p className="inline-message error" role="alert">{error}</p>}
    <section className={`article-index-panel${chosen.length ? " has-selection" : ""}`} aria-label={t("文章列表", "Article list")}>
      <div className="article-index-filters"><div className="article-index-tabs" role="tablist" aria-label={t("文章视图", "Article views")}>
        <button type="button" role="tab" aria-selected={view === "active"} onClick={() => switchView("active")}>{t("全部文章", "All articles")} <span>{items.filter((item) => !item.trashedAt).length}</span></button>
        <button type="button" role="tab" aria-selected={view === "trash"} onClick={() => switchView("trash")}>{t("回收站", "Trash")} <span>{items.filter((item) => item.trashedAt).length}</span></button></div>
        <input aria-label={t("搜索文章", "Search articles")} placeholder={t("搜索标题或摘要", "Search title or summary")} value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); setSelected(new Set()); }} />
        <WorkbenchSelect label={t("文章状态", "Article status")} value={filter} onChange={(value) => { setFilter(value); setPage(1); setSelected(new Set()); }}
          options={[{ value: "all", label: t("全部状态", "All statuses") }, ...Object.entries(articleStages).map(([value, label]) => ({ value,
            label: `${label} · ${viewItems.filter((item) => displayStage(item) === value).length}` }))]} />
        {view === "trash" && <button type="button" className="secondary-button article-empty-trash" disabled={busy || !viewItems.length}
          onClick={() => { setError(null); setConfirmation({ action: "empty", items: [...viewItems] }); }}>{t("清空回收站", "Empty trash")}</button>}</div>
      <div className="article-index-columns"><label className="article-check-hit" title={t("选择本页", "Select this page")}><input type="checkbox" aria-label={t("选择本页文章", "Select all articles on this page")} checked={pageSelected} disabled={busy || !rows.length}
        ref={(node) => { if (node) node.indeterminate = !pageSelected && rows.some((item) => selected.has(item.id)); }} onChange={() => setSelected((previous) => {
          const next = new Set(previous); for (const item of rows) { if (pageSelected) next.delete(item.id); else next.add(item.id); } return next;
        })} /></label><span>{t("文章", "Article")}</span><span>{t("状态", "Status")}</span><span>{view === "trash" ? t("删除时间", "Deleted") : t("最近更新", "Last updated")}</span><span>{t("操作", "Actions")}</span></div>
      <div className="article-index-rows">{rows.length ? rows.map((item) => <article key={item.id} className="article-list-item" data-selected={selected.has(item.id)} onClick={(event) => {
        if (view === "active" && !(event.target instanceof Element && event.target.closest("button, input, label, a"))) onSelect(item);
      }}>
        <label className="article-check-hit"><input type="checkbox" aria-label={t(`选择 ${item.title || untitled}`, `Select ${item.title || untitled}`)} disabled={busy} checked={selected.has(item.id)} onChange={() => toggle(item.id)} /></label>
        <div className="article-list-copy">{view === "active" ? <button type="button" disabled={busy} onClick={() => onSelect(item)}>{item.title || untitled}</button> : <strong>{item.title || untitled}</strong>}
          <span>{item.summary || (item.sourceRef ? t("已关联来源资料", "Source attached") : t("从想法与讨论开始", "Start with an idea and a conversation"))}</span></div>
        <span className={`article-stage ${displayStage(item)}`}>{articleStages[displayStage(item)]}</span>
        <time dateTime={item.trashedAt || item.updatedAt}>{new Date(item.trashedAt || item.updatedAt).toLocaleString(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>
        <div className="article-list-actions">{view === "trash" ? <>
          <button className="text-button" type="button" disabled={busy} onClick={() => void manage("restore", [item])}>{t("恢复", "Restore")}</button>
          <button className="text-button article-delete-button" type="button" disabled={busy} onClick={() => { setError(null); setConfirmation({ action: "purge", items: [item] }); }}>{t("永久删除", "Delete permanently")}</button></> : <>
          {item.status === "final" ? <><button className="text-button" type="button" disabled={busy} onClick={() => onSelect(item)}>{t("查看", "View")}</button>
            <button className="text-button" type="button" disabled={busy} onClick={() => onExport(item)}>{t("前往导出", "Go to export")}</button></> :
            <button className="text-button" type="button" disabled={busy} onClick={() => onSelect(item)}>{t("继续写作", "Continue writing")}</button>}
          <button className="text-button article-delete-button" type="button" disabled={busy} onClick={() => void manage("trash", [item])}>{t("移入回收站", "Move to trash")}</button></>}</div>
      </article>) : <div className="article-index-empty"><WorkspaceIcon name="article" size={27} /><strong>{view === "trash" ? t("回收站里没有匹配的文章", "No matching articles in trash") : viewItems.length ? t("没有匹配的文章", "No matching articles") : t("开始你的第一篇文章", "Start your first article")}</strong>
        <span>{view === "trash" ? t("删除的文章可以在这里恢复。", "You can restore deleted articles here.") : viewItems.length ? t("试试其他关键词或状态。", "Try a different search or status.") : t("创建空白稿，和智能体边聊边写。", "Create a blank draft and write with an assistant.")}</span></div>}</div>
      {chosen.length > 0 && <div className="article-bulk-toolbar" role="toolbar" aria-label={t("批量文章操作", "Bulk article actions")}><strong>{t(`已选择 ${chosen.length} 篇`, `${chosen.length} selected`)}</strong>
        {chosen.length < filtered.length && <button className="text-button" disabled={busy || filtered.length > 1_000} onClick={() => setSelected(new Set(filtered.map((item) => item.id)))}>{t(`选择全部筛选结果（${filtered.length}）`, `Select all results (${filtered.length})`)}</button>}
        {view === "trash" ? <><button className="secondary-button" disabled={busy} onClick={() => void manage("restore", chosen)}>{t("批量恢复", "Restore selected")}</button>
          <button className="secondary-button article-empty-trash" disabled={busy} onClick={() => { setError(null); setConfirmation({ action: "purge", items: chosen }); }}>{t("批量永久删除", "Delete selected permanently")}</button></> : <>
          {chosen.length === 1 && chosen[0].status === "final" && <button className="secondary-button" disabled={busy} onClick={() => onExport(chosen[0])}>{t("前往导出", "Go to export")}</button>}
          <button className="secondary-button" disabled={busy} onClick={() => void manage("trash", chosen)}>{t("移入回收站", "Move to trash")}</button></>}
        <button className="text-button" disabled={busy} onClick={() => setSelected(new Set())}>{t("清除选择", "Clear selection")}</button></div>}
      <div className="source-pagination"><span>{t(`第 ${currentPage} / ${pages} 页 · 共 ${filtered.length} 篇`, `Page ${currentPage} of ${pages} · ${filtered.length} ${filtered.length === 1 ? "article" : "articles"}`)}</span><div>
        <button className="text-button" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>{t("上一页", "Previous")}</button>
        <button className="text-button" disabled={currentPage >= pages} onClick={() => setPage(currentPage + 1)}>{t("下一页", "Next")}</button></div></div>
    </section>
    {confirmation && <div className="modal-backdrop article-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setConfirmation(null); }}>
      <section className="confirm-modal" role="dialog" aria-modal="true" aria-label={confirmation.action === "empty" ? t("清空文章回收站", "Empty article trash") : t("永久删除文章", "Permanently delete articles")}>
        <h2>{confirmation.action === "empty"
          ? t(`永久删除回收站中的 ${confirmation.items.length} 篇文章？`, `Permanently delete ${confirmation.items.length} ${confirmation.items.length === 1 ? "article" : "articles"} from trash?`)
          : t(`永久删除所选的 ${confirmation.items.length} 篇文章？`, `Permanently delete ${confirmation.items.length} selected ${confirmation.items.length === 1 ? "article" : "articles"}?`)}</h2>
        <p>{confirmation.action === "empty" ? t("将清空整个回收站，不受当前搜索、状态或分页影响。", "This empties the entire trash across all filters and pages.") : t("仅永久删除以下选中的文章，其他回收站文章保留。", "This permanently deletes the selected articles below.")}</p>
        <p>{t("删除后无法恢复正文、历史版本和工作台对话。知识库来源和已导出的文件仍可使用。", "This permanently removes the article text, version history, and workspace conversations. You can still use sources and exported files.")}</p>
        <ul className="article-delete-titles">{confirmation.items.slice(0, 3).map((item) => <li key={item.id}>{item.title || untitled}</li>)}</ul>
        {confirmation.items.length > 3 && <p>{t(`以及另外 ${confirmation.items.length - 3} 篇文章。`, `And ${confirmation.items.length - 3} more.`)}</p>}{error && <p className="inline-message error" role="alert">{error}</p>}
        <div className="action-row"><button className="secondary-button" autoFocus disabled={busy} onClick={() => setConfirmation(null)}>{t("取消", "Cancel")}</button>
          <button className="primary-button danger-button" disabled={busy}
            onClick={() => void permanentlyDelete(confirmation.items, confirmation.action === "empty")}>
            {busy ? t("处理中…", "Deleting…") : t("永久删除", "Delete permanently")}</button></div></section></div>}
  </div>;
}
