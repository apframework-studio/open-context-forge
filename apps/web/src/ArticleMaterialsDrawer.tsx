import { useEffect, useRef, useState } from "react";
import { api, type KnowledgeDetail, type KnowledgeItem, type KnowledgePage, type VaultList,
  type WritingContext, type WritingMaterialRef } from "./api";
import { KnowledgeMarkdown } from "./screens/KnowledgeMarkdown";
import { useLocale, type LocalizedError } from "./locale";

interface Props { articleId: string; vaults: VaultList | null; context: WritingContext; onClose: () => void; onApply: (value: WritingContext) => void }
const key = (item: WritingMaterialRef) => `${item.vaultId}\0${item.path}`;

export function ArticleMaterialsDrawer({ articleId, vaults, context, onClose, onApply }: Props) {
  const { t, errorText } = useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const [vaultIds, setVaultIds] = useState(context.vaultIds);
  const [selected, setSelected] = useState(() => new Map<string, WritingMaterialRef>(context.materials.map((item) => [key(item), { vaultId: item.vaultId, path: item.path }])));
  const [kind, setKind] = useState("");
  const [input, setInput] = useState(""); const [q, setQ] = useState("");
  const [pageNumber, setPageNumber] = useState(1); const [page, setPage] = useState<KnowledgePage | null>(null);
  const [preview, setPreview] = useState<WritingMaterialRef | null>(null);
  const [detail, setDetail] = useState<KnowledgeDetail | null>(null);
  const [mobilePreview, setMobilePreview] = useState(false);
  const [error, setError] = useState<LocalizedError | null>(null); const [saving, setSaving] = useState(false);
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
      .catch((cause) => { if (!ignore) setError([cause, "资料读取失败", "Could not load the materials"]); });
    return () => { ignore = true; };
  }, [vaultIds, pageNumber, q, kind]);
  useEffect(() => {
    let ignore = false; setDetail(null);
    if (!preview) return;
    void api<KnowledgeDetail>(`/knowledge/items/${encodeURIComponent(preview.vaultId)}?path=${encodeURIComponent(preview.path)}`)
      .then((value) => { if (!ignore) setDetail(value); }).catch((cause) => { if (!ignore) setError([cause, "正文读取失败", "Could not load the material preview"]); });
    return () => { ignore = true; };
  }, [preview?.vaultId, preview?.path]);
  function toggleVault(id: string) {
    const next = vaultIds.includes(id) ? vaultIds.filter((value) => value !== id) : [...vaultIds, id];
    setVaultIds(next); setPageNumber(1); setError(null);
    setSelected((previous) => new Map([...previous].filter(([, value]) => next.includes(value.vaultId))));
    if (preview && !next.includes(preview.vaultId)) { setPreview(null); setMobilePreview(false); }
  }
  function toggleItem(item: KnowledgeItem) {
    setSelected((previous) => { const next = new Map(previous); if (next.has(key(item))) next.delete(key(item)); else next.set(key(item), { vaultId: item.vaultId, path: item.path }); return next; });
  }
  async function apply() {
    setSaving(true); setError(null);
    try {
      const value = await api<WritingContext>(`/articles/${articleId}/context`, { method: "PUT", body: {
        expectedRevision: context.revision, vaultIds, materials: [...selected.values()], skillEnabled: context.skillEnabled,
      } });
      if (mounted.current) onApply(value);
    } catch (cause) { if (mounted.current) setError([cause, "资料保存失败", "Could not save the materials"]); }
    finally { if (mounted.current) setSaving(false); }
  }
  const total = page?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / 20));
  return <dialog ref={dialog} className="article-material-dialog" aria-label={t("选择创作资料", "Choose materials")} onCancel={(event) => { event.preventDefault(); if (!saving) onClose(); }}>
    <header><div><strong>{t("选择创作资料", "Choose materials")}</strong><small>{t("多库选材，阅读后带入对话", "Choose materials from your knowledge bases to share in the conversation")}</small></div><button className="text-button" disabled={saving} onClick={onClose} aria-label={t("关闭选材窗口", "Close material picker")}>×</button></header>
    {error && <p className="inline-message error" role="alert">{errorText(...error)}</p>}
    <div className={`article-material-dialog-grid${mobilePreview ? " show-preview" : ""}`}>
      <aside className="article-material-vaults"><strong>{t("知识库 · 可多选", "Knowledge bases · Select any")}</strong>
        {vaults?.vaults.map((vault) => <label key={vault.id} title={vault.path}><input type="checkbox" aria-label={t(`选择知识库 ${vault.id}`, `Select knowledge base ${vault.id}`)} checked={vaultIds.includes(vault.id)} disabled={saving} onChange={() => toggleVault(vault.id)} /><span>{vault.id}</span></label>)}
        <small>{t("取消勾选会移出该库的待选资料，点击“带入对话”后生效。", "Clearing a knowledge base removes its selected materials when you add the selection to the conversation.")}</small></aside>
      <section className="article-material-candidates" aria-label={t("候选资料", "Available materials")}>
        <form className="article-material-search" onSubmit={(event) => { event.preventDefault(); setQ(input.trim()); setPageNumber(1); }}>
          <input aria-label={t("搜索创作资料", "Search writing materials")} placeholder={t("搜索标题、路径与正文", "Search title, path, and text")} value={input} onChange={(event) => setInput(event.target.value)} /><button className="secondary-button" type="submit">{t("搜索", "Search")}</button></form>
        <div className="article-material-kind" role="tablist" aria-label={t("选材类型", "Material types")}>{[["", t("全部内容", "All materials")], ["source", t("刚入库来源", "Imported sources")], ["note", t("库内文档", "Documents")]].map(([value, label]) =>
          <button key={value} role="tab" aria-selected={kind === value} onClick={() => { setKind(value); setPageNumber(1); }}>{label}</button>)}</div>
        <div className="article-material-candidate-rows">{!vaultIds.length ? <p className="muted">{t("先选择要用于创作的知识库。", "Choose a knowledge base to get started.")}</p> : !page ? <p className="muted">{t("资料读取中…", "Loading materials…")}</p> : !page.items.length ? <p className="muted">{t("没有匹配资料，可切换类型或搜索条件。", "No matching materials. Try a different type or search.")}</p> : page.items.map((item) =>
          <div key={key(item)} className={`article-material-candidate${preview && key(preview) === key(item) ? " active" : ""}`}>
            <label title={item.format === "pdf" ? t("PDF 可预览，暂不支持作为文本带入写作", "PDFs are available for preview only") : item.previewLimited ? t("超过文本写作引用大小上限", "This material exceeds the size limit for citations") : undefined}><input type="checkbox" aria-label={t(`选用 ${item.title}`, `Select ${item.title}`)} checked={selected.has(key(item))} disabled={saving || item.format === "pdf" || item.previewLimited} onChange={() => toggleItem(item)} /></label>
            <button type="button" onClick={() => { setPreview(item); setMobilePreview(true); }}><strong>{item.title}</strong><small>{item.vaultId} · {item.format === "pdf" ? t("PDF · 仅预览", "PDF · Preview only") : item.kind === "source" ? t("来源", "Source") : t("文档", "Document")}</small><span>{item.snippet}</span></button></div>)}</div>
        <div className="source-pagination"><span>{t(`第 ${pageNumber} / ${pageCount} 页 · ${total} 篇`, `Page ${pageNumber} of ${pageCount} · ${total} ${total === 1 ? "item" : "items"}`)}</span><div>
          <button className="text-button" disabled={pageNumber <= 1} onClick={() => setPageNumber((value) => value - 1)}>{t("上一页", "Previous")}</button>
          <button className="text-button" disabled={!page || pageNumber * 20 >= page.total} onClick={() => setPageNumber((value) => value + 1)}>{t("下一页", "Next")}</button></div></div>
      </section>
      <section className="article-material-preview" aria-label={t("选材正文预览", "Material preview")}><button type="button" className="text-button article-material-back" onClick={() => setMobilePreview(false)}>{t("‹ 返回资料列表", "‹ Back to materials")}</button>
        {detail ? <><div className="article-material-location">{detail.vaultId} / {detail.path}</div><h2>{detail.title}</h2>
          <KnowledgeMarkdown item={detail} onNavigate={(path) => setPreview({ vaultId: detail.vaultId, path })} onAnchor={() => undefined} /></> : <div className="article-reader-empty">{t("点击标题预览正文，勾选资料加入待选清单。", "Click a title to preview it. Use the checkbox to select it.")}</div>}</section>
    </div>
    <footer><span aria-live="polite">{t(`${vaultIds.length} 个知识库 · 已选 ${selected.size} 篇`, `${vaultIds.length} ${vaultIds.length === 1 ? "knowledge base" : "knowledge bases"} · ${selected.size} selected`)} · {selected.size > 30 ? t("每篇文章最多选用 30 篇资料", "Up to 30 materials per article") : t("尚未发送", "Ready to attach")}</span><div><button className="secondary-button" disabled={saving} onClick={onClose}>{t("取消", "Cancel")}</button>
      <button className="primary-button" disabled={saving || selected.size > 30} onClick={() => void apply()}>{saving ? t("保存中…", "Saving…") : t(`带入对话（${selected.size}）`, `Add to conversation (${selected.size})`)}</button></div></footer>
  </dialog>;
}
