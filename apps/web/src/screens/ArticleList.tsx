import { useEffect, useState } from "react";
import type { ArticleListItem } from "../api";
import { WorkbenchSelect } from "../WorkbenchSelect";
import { WorkspaceIcon } from "../WorkspaceIcon";

const articleStages: Record<ArticleListItem["stage"], string> = {
  new: "新建", writing: "写作中", complete: "已定稿", pending_publish: "待发布", published: "已发布",
};
interface Props {
  items: ArticleListItem[]; busy: boolean; message: string; onCreate: () => void;
  onSelect: (item: ArticleListItem) => void; onPublish: (item: ArticleListItem) => void;
  onManage: (action: "trash" | "restore", items: ArticleListItem[]) => Promise<void>;
  onPermanentlyDelete: (items: ArticleListItem[]) => Promise<void>;
}

export function ArticleList({ items, busy, message, onCreate, onSelect, onPublish, onManage, onPermanentlyDelete }: Props) {
  const [view, setView] = useState<"active" | "trash">("active");
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmation, setConfirmation] = useState<{ action: "trash" | "empty" | "purge"; items: ArticleListItem[] } | null>(null);
  const permanent = confirmation?.action === "empty" || confirmation?.action === "purge";
  const [error, setError] = useState("");
  const viewItems = items.filter((item) => !!item.trashedAt === (view === "trash"));
  const filtered = viewItems.filter((item) => (filter === "all" || item.stage === filter) &&
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
  function switchView(next: "active" | "trash") { setView(next); setSelected(new Set()); setPage(1); setError(""); }
  function toggle(id: string) { setSelected((previous) => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
  async function manage(action: "trash" | "restore", targets: ArticleListItem[]) {
    setError("");
    try { await onManage(action, targets); setConfirmation(null); setSelected(new Set()); }
    catch (cause) { setConfirmation(null); setError(cause instanceof Error ? cause.message : "操作失败，请重试"); }
  }
  async function permanentlyDelete(targets: ArticleListItem[], clearAll: boolean) {
    setError("");
    try { await onPermanentlyDelete(targets); setConfirmation(null); setSelected(new Set()); if (clearAll) setPage(1); }
    catch (cause) { setConfirmation(null); setError(cause instanceof Error ? cause.message : "永久删除失败，请重试"); }
  }

  return <div className="article-index">
    <div className="article-index-toolbar"><p role={message ? "status" : undefined}>{message || "从一个想法开始，每篇文章都有独立的文稿与对话。"}</p>
      <button className="primary-button" type="button" disabled={busy} onClick={onCreate}>新建文章</button></div>
    {error && !confirmation && <p className="inline-message error" role="alert">{error}</p>}
    <section className={`article-index-panel${chosen.length ? " has-selection" : ""}`} aria-label="文章列表">
      <div className="article-index-filters"><div className="article-index-tabs" role="tablist" aria-label="文章视图">
        <button type="button" role="tab" aria-selected={view === "active"} onClick={() => switchView("active")}>全部文章 <span>{items.filter((item) => !item.trashedAt).length}</span></button>
        <button type="button" role="tab" aria-selected={view === "trash"} onClick={() => switchView("trash")}>回收站 <span>{items.filter((item) => item.trashedAt).length}</span></button></div>
        <input aria-label="搜索文章" placeholder="搜索标题或摘要" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); setSelected(new Set()); }} />
        <WorkbenchSelect label="文章状态" value={filter} onChange={(value) => { setFilter(value); setPage(1); setSelected(new Set()); }}
          options={[{ value: "all", label: "全部状态" }, ...Object.entries(articleStages).map(([value, label]) => ({ value,
            label: `${label} · ${viewItems.filter((item) => item.stage === value).length}` }))]} />
        {view === "trash" && <button type="button" className="secondary-button article-empty-trash" disabled={busy || !viewItems.length}
          onClick={() => { setError(""); setConfirmation({ action: "empty", items: [...viewItems] }); }}>清空回收站</button>}</div>
      <div className="article-index-columns"><label className="article-check-hit"><input type="checkbox" aria-label="选择本页文章" checked={pageSelected} disabled={busy || !rows.length}
        ref={(node) => { if (node) node.indeterminate = !pageSelected && rows.some((item) => selected.has(item.id)); }} onChange={() => setSelected((previous) => {
          const next = new Set(previous); for (const item of rows) { if (pageSelected) next.delete(item.id); else next.add(item.id); } return next;
        })} /></label><span>文章</span><span>状态</span><span>{view === "trash" ? "删除时间" : "最近更新"}</span><span>操作</span></div>
      <div className="article-index-rows">{rows.length ? rows.map((item) => <article key={item.id} className="article-list-item" data-selected={selected.has(item.id)} onClick={(event) => {
        if (view === "active" && !(event.target instanceof Element && event.target.closest("button, input, label, a"))) onSelect(item);
      }}>
        <label className="article-check-hit"><input type="checkbox" aria-label={`选择 ${item.title || "未命名文章"}`} disabled={busy} checked={selected.has(item.id)} onChange={() => toggle(item.id)} /></label>
        <div className="article-list-copy">{view === "active" ? <button type="button" disabled={busy} onClick={() => onSelect(item)}>{item.title || "未命名文章"}</button> : <strong>{item.title || "未命名文章"}</strong>}
          <span>{item.summary || (item.sourceRef ? "已关联来源资料" : "从想法与讨论开始")}</span></div>
        <span className={`article-stage ${item.stage}`}>{articleStages[item.stage]}</span>
        <time dateTime={item.trashedAt || item.updatedAt}>{new Date(item.trashedAt || item.updatedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>
        <div className="article-list-actions">{view === "trash" ? <>
          <button className="text-button" type="button" disabled={busy} onClick={() => void manage("restore", [item])}>恢复</button>
          <button className="text-button article-delete-button" type="button" disabled={busy} onClick={() => { setError(""); setConfirmation({ action: "purge", items: [item] }); }}>永久删除</button></> : <>
          {item.status === "final" ? <><button className="text-button" type="button" disabled={busy} onClick={() => onSelect(item)}>查看</button>
            <button className="text-button" type="button" disabled={busy} onClick={() => onPublish(item)}>前往发布中心</button></> :
            <button className="text-button" type="button" disabled={busy} onClick={() => onSelect(item)}>继续写作</button>}
          <button className="text-button article-delete-button" type="button" disabled={busy} onClick={() => { setError(""); setConfirmation({ action: "trash", items: [item] }); }}>删除</button></>}</div>
      </article>) : <div className="article-index-empty"><WorkspaceIcon name="article" size={27} /><strong>{view === "trash" ? "回收站里没有匹配的文章" : viewItems.length ? "没有匹配的文章" : "开始你的第一篇文章"}</strong>
        <span>{view === "trash" ? "删除的文章可以在这里恢复。" : viewItems.length ? "试试其他关键词或状态。" : "创建空白稿，和智能体边聊边写。"}</span></div>}</div>
      {chosen.length > 0 && <div className="article-bulk-toolbar" role="toolbar" aria-label="批量文章操作"><strong>已选择 {chosen.length} 篇</strong>
        {chosen.length < filtered.length && <button className="text-button" disabled={busy || filtered.length > 1_000} onClick={() => setSelected(new Set(filtered.map((item) => item.id)))}>选择全部筛选结果（{filtered.length}）</button>}
        {view === "trash" ? <><button className="secondary-button" disabled={busy} onClick={() => void manage("restore", chosen)}>批量恢复</button>
          <button className="secondary-button article-empty-trash" disabled={busy} onClick={() => { setError(""); setConfirmation({ action: "purge", items: chosen }); }}>批量永久删除</button></> : <>
          {chosen.length === 1 && chosen[0].status === "final" && <button className="secondary-button" disabled={busy} onClick={() => onPublish(chosen[0])}>前往发布中心</button>}
          <button className="secondary-button" disabled={busy} onClick={() => { setError(""); setConfirmation({ action: "trash", items: chosen }); }}>批量删除</button></>}
        <button className="text-button" disabled={busy} onClick={() => setSelected(new Set())}>清除选择</button></div>}
      <div className="source-pagination"><span>第 {currentPage} / {pages} 页 · 共 {filtered.length} 篇</span><div>
        <button className="text-button" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>上一页</button>
        <button className="text-button" disabled={currentPage >= pages} onClick={() => setPage(currentPage + 1)}>下一页</button></div></div>
    </section>
    {confirmation && <div className="modal-backdrop article-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setConfirmation(null); }}>
      <section className="confirm-modal" role="dialog" aria-modal="true" aria-label={confirmation.action === "empty" ? "清空文章回收站" : permanent ? "永久删除文章" : "移入文章回收站"}>
        <h2>{confirmation.action === "empty" ? `永久删除回收站中的 ${confirmation.items.length} 篇文章？` : permanent ? `永久删除所选的 ${confirmation.items.length} 篇文章？` : `将 ${confirmation.items.length} 篇文章移入回收站？`}</h2>
        {permanent ? <><p>{confirmation.action === "empty" ? "将清空整个回收站，不受当前搜索、状态或分页影响。" : "仅永久删除以下选中的文章，其他回收站文章保留。"}</p>
          <p>正文、历史版本、工作台对话与本地发布包将永久删除，无法恢复。知识库来源、博客发布工作区与已发布渠道的文章保留。</p></> :
          <p>正文、历史版本、对话和发布记录会保留，可以恢复。已发布渠道的内容不会下线。</p>}
        <ul className="article-delete-titles">{confirmation.items.slice(0, 3).map((item) => <li key={item.id}>{item.title || "未命名文章"}</li>)}</ul>
        {confirmation.items.length > 3 && <p>以及另外 {confirmation.items.length - 3} 篇文章。</p>}{error && <p className="inline-message error" role="alert">{error}</p>}
        <div className="action-row"><button className="secondary-button" autoFocus disabled={busy} onClick={() => setConfirmation(null)}>取消</button>
          <button className={`primary-button${permanent ? " danger-button" : ""}`} disabled={busy}
            onClick={() => void (permanent ? permanentlyDelete(confirmation.items, confirmation.action === "empty") : manage("trash", confirmation.items))}>
            {busy ? "处理中…" : permanent ? "永久删除" : "移入回收站"}</button></div></section></div>}
  </div>;
}
