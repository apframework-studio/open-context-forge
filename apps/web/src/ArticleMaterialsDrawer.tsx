import { useEffect, useRef, useState } from "react";
import { api, type KnowledgeDetail, type KnowledgeItem, type KnowledgePage, type VaultList,
  type WritingContext, type WritingMaterialRef } from "./api";
import { KnowledgeMarkdown } from "./screens/KnowledgeMarkdown";

interface Props { articleId: string; vaults: VaultList | null; context: WritingContext; onClose: () => void; onApply: (value: WritingContext) => void }
const key = (item: WritingMaterialRef) => `${item.vaultId}\0${item.path}`;

export function ArticleMaterialsDrawer({ articleId, vaults, context, onClose, onApply }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [vaultIds, setVaultIds] = useState(context.vaultIds);
  const [selected, setSelected] = useState(() => new Map<string, WritingMaterialRef>(context.materials.map((item) => [key(item), { vaultId: item.vaultId, path: item.path }])));
  const [kind, setKind] = useState("");
  const [input, setInput] = useState(""); const [q, setQ] = useState("");
  const [pageNumber, setPageNumber] = useState(1); const [page, setPage] = useState<KnowledgePage | null>(null);
  const [preview, setPreview] = useState<WritingMaterialRef | null>(null);
  const [detail, setDetail] = useState<KnowledgeDetail | null>(null);
  const [mobilePreview, setMobilePreview] = useState(false);
  const [error, setError] = useState(""); const [saving, setSaving] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const opener = document.activeElement;
    dialog.current?.showModal();
    return () => { mounted.current = false; dialog.current?.close(); if (opener instanceof HTMLElement && opener.isConnected) opener.focus(); };
  }, []);
  useEffect(() => {
    let ignore = false; setPage(null);
    if (!vaultIds.length) return;
    const params = new URLSearchParams({ vaultIds: vaultIds.join(","), page: String(pageNumber), pageSize: "20", sort: "recent" });
    if (q) params.set("q", q); if (kind) params.set("kind", kind);
    void api<KnowledgePage>(`/knowledge/items?${params}`).then((value) => { if (!ignore) setPage(value); })
      .catch((cause) => { if (!ignore) setError(cause instanceof Error ? cause.message : "资料读取失败"); });
    return () => { ignore = true; };
  }, [vaultIds, pageNumber, q, kind]);
  useEffect(() => {
    let ignore = false; setDetail(null);
    if (!preview) return;
    void api<KnowledgeDetail>(`/knowledge/items/${encodeURIComponent(preview.vaultId)}?path=${encodeURIComponent(preview.path)}`)
      .then((value) => { if (!ignore) setDetail(value); }).catch((cause) => { if (!ignore) setError(cause instanceof Error ? cause.message : "正文读取失败"); });
    return () => { ignore = true; };
  }, [preview?.vaultId, preview?.path]);
  function toggleVault(id: string) {
    const next = vaultIds.includes(id) ? vaultIds.filter((value) => value !== id) : [...vaultIds, id];
    setVaultIds(next); setPageNumber(1); setError("");
    setSelected((previous) => new Map([...previous].filter(([, value]) => next.includes(value.vaultId))));
    if (preview && !next.includes(preview.vaultId)) { setPreview(null); setMobilePreview(false); }
  }
  function toggleItem(item: KnowledgeItem) {
    setSelected((previous) => { const next = new Map(previous); if (next.has(key(item))) next.delete(key(item)); else next.set(key(item), { vaultId: item.vaultId, path: item.path }); return next; });
  }
  async function apply() {
    setSaving(true); setError("");
    try {
      const value = await api<WritingContext>(`/articles/${articleId}/context`, { method: "PUT", body: {
        expectedRevision: context.revision, vaultIds, materials: [...selected.values()], skillEnabled: context.skillEnabled,
      } });
      if (mounted.current) onApply(value);
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "资料保存失败"); }
    finally { if (mounted.current) setSaving(false); }
  }
  return <dialog ref={dialog} className="article-material-dialog" aria-label="选择创作资料" onCancel={(event) => { event.preventDefault(); if (!saving) onClose(); }}>
    <header><div><strong>选择创作资料</strong><small>多库选材，阅读后带入对话</small></div><button className="text-button" disabled={saving} onClick={onClose} aria-label="关闭选材窗口">×</button></header>
    {error && <p className="inline-message error" role="alert">{error}</p>}
    <div className={`article-material-dialog-grid${mobilePreview ? " show-preview" : ""}`}>
      <aside className="article-material-vaults"><strong>知识库 · 可多选</strong>
        {vaults?.vaults.map((vault) => <label key={vault.id} title={vault.path}><input type="checkbox" aria-label={`选择知识库 ${vault.id}`} checked={vaultIds.includes(vault.id)} disabled={saving} onChange={() => toggleVault(vault.id)} /><span>{vault.id}</span></label>)}
        <small>取消勾选会移出该库的待选资料，点击“带入对话”后生效。</small></aside>
      <section className="article-material-candidates" aria-label="候选资料">
        <form className="article-material-search" onSubmit={(event) => { event.preventDefault(); setQ(input.trim()); setPageNumber(1); }}>
          <input aria-label="搜索创作资料" placeholder="搜索标题、路径与正文" value={input} onChange={(event) => setInput(event.target.value)} /><button className="secondary-button" type="submit">搜索</button></form>
        <div className="article-material-kind" role="tablist" aria-label="选材类型">{[["", "全部内容"], ["source", "刚入库来源"], ["note", "知识笔记"]].map(([value, label]) =>
          <button key={value} role="tab" aria-selected={kind === value} onClick={() => { setKind(value); setPageNumber(1); }}>{value === "note" ? "库内文档" : label}</button>)}</div>
        <div className="article-material-candidate-rows">{!vaultIds.length ? <p className="muted">先选择要用于创作的知识库。</p> : !page ? <p className="muted">资料读取中…</p> : !page.items.length ? <p className="muted">没有匹配资料，可切换类型或搜索条件。</p> : page.items.map((item) =>
          <div key={key(item)} className={`article-material-candidate${preview && key(preview) === key(item) ? " active" : ""}`}>
            <label title={item.format === "pdf" ? "PDF 可预览，暂不支持作为文本带入写作" : item.previewLimited ? "超过文本写作引用大小上限" : undefined}><input type="checkbox" aria-label={`选用 ${item.title}`} checked={selected.has(key(item))} disabled={saving || item.format === "pdf" || item.previewLimited} onChange={() => toggleItem(item)} /></label>
            <button type="button" onClick={() => { setPreview(item); setMobilePreview(true); }}><strong>{item.title}</strong><small>{item.vaultId} · {item.format === "pdf" ? "PDF · 仅预览" : item.kind === "source" ? "来源" : "文档"}</small><span>{item.snippet}</span></button></div>)}</div>
        <div className="source-pagination"><span>第 {pageNumber} / {Math.max(1, Math.ceil((page?.total ?? 0) / 20))} 页 · {page?.total ?? 0} 篇</span><div>
          <button className="text-button" disabled={pageNumber <= 1} onClick={() => setPageNumber((value) => value - 1)}>上一页</button>
          <button className="text-button" disabled={!page || pageNumber * 20 >= page.total} onClick={() => setPageNumber((value) => value + 1)}>下一页</button></div></div>
      </section>
      <section className="article-material-preview" aria-label="选材正文预览"><button type="button" className="text-button article-material-back" onClick={() => setMobilePreview(false)}>‹ 返回资料列表</button>
        {detail ? <><div className="article-material-location">{detail.vaultId} / {detail.path}</div><h2>{detail.title}</h2>
          <KnowledgeMarkdown item={detail} onNavigate={(path) => setPreview({ vaultId: detail.vaultId, path })} onAnchor={() => undefined} /></> : <div className="article-reader-empty">点击标题预览正文，勾选资料加入待选清单。</div>}</section>
    </div>
    <footer><span aria-live="polite">{vaultIds.length} 个知识库 · 已选 {selected.size} 篇 · {selected.size > 30 ? "每篇文章最多选用 30 篇资料" : "尚未发送"}</span><div><button className="secondary-button" disabled={saving} onClick={onClose}>取消</button>
      <button className="primary-button" disabled={saving || selected.size > 30} onClick={() => void apply()}>{saving ? "保存中…" : `带入对话（${selected.size}）`}</button></div></footer>
  </dialog>;
}
