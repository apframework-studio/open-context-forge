import { useEffect, useRef, useState } from "react";
import { api, type WritingMaterial, type WritingMaterialDetail, type WritingSelection } from "./api";
import { KnowledgeMarkdown } from "./screens/KnowledgeMarkdown";
import { WorkbenchSelect } from "./WorkbenchSelect";
import { quoteRangeForText, validQuoteRange } from "./writingQuote";
import { useLocale, type LocalizedError } from "./locale";

export interface RequestedWritingSource { materialId: string; turnId?: string; startLine?: number; token?: number }
interface Props { articleId: string; materials: WritingMaterial[]; requestedSource: RequestedWritingSource | null;
  onQuote: (selection: WritingSelection) => void }
function sourceHost(value: string | null): string { try { return value ? new URL(value).hostname : ""; } catch { return ""; } }

function MaterialText({ articleId, id, turnId, onDetail }: { articleId: string; id: string; turnId?: string; onDetail?: (detail: WritingMaterialDetail) => void }) {
  const { t, errorText } = useLocale();
  const [detail, setDetail] = useState<WritingMaterialDetail | null>(null); const [error, setError] = useState<LocalizedError | null>(null);
  const [notice, setNotice] = useState(false);
  useEffect(() => {
    let ignore = false; setDetail(null); setError(null); setNotice(false);
    void api<WritingMaterialDetail>(`/articles/${articleId}/materials/${encodeURIComponent(id)}${turnId ? `?turnId=${encodeURIComponent(turnId)}` : ""}`)
      .then((value) => { if (!ignore) { setDetail(value); onDetail?.(value); } }).catch((cause) => { if (!ignore) setError([cause, "资料快照读取失败", "Could not load the material snapshot"]); });
    return () => { ignore = true; };
  }, [articleId, id, turnId]);
  return <article className="article-reference-paper">{error ? <p className="inline-message error" role="alert">{errorText(...error)}</p> : detail ? <>
    <div className="article-material-location"><span className="tag">{detail.id}</span> {detail.vaultId} / {detail.path}{turnId && <span className="tag">{t("历史快照", "Historical snapshot")}</span>}</div>
    <h2>{detail.title}</h2>{detail.originalUrl && /^https?:\/\//i.test(detail.originalUrl) && sourceHost(detail.originalUrl) && <a className="text-button" href={detail.originalUrl} target="_blank" rel="noopener noreferrer">{t("原文链接", "Original source")} · {sourceHost(detail.originalUrl)}</a>}
    {notice && <p className="inline-message" role="status">{t("链接目标尚未加入本次阅读，请通过创作资料选入。原有知识库浏览仍可查看全部链接。", "Choose the linked item in Writing materials to read it here. You can also follow all links from the knowledge base.")}</p>}
    <KnowledgeMarkdown item={detail} onNavigate={() => setNotice(true)}
      onAnchor={(fragment) => { const heading = [...document.querySelectorAll<HTMLElement>(".article-reference-paper :is(h1,h2,h3,h4,h5,h6)")].find((node) => node.textContent?.trim() === fragment); heading?.scrollIntoView({ block: "start" }); }} />
  </> : <p className="muted">{t("资料读取中…", "Loading material…")}</p>}</article>;
}

export function ArticleMaterialReader({ articleId, materials, requestedSource, onQuote }: Props) {
  const { t } = useLocale();
  const [id, setId] = useState(materials[0]?.id ?? ""); const [turnId, setTurnId] = useState<string | undefined>();
  const [compare, setCompare] = useState(false); const [secondId, setSecondId] = useState(materials[1]?.id ?? "");
  const [detail, setDetail] = useState<WritingMaterialDetail | null>(null); const [quoteOpen, setQuoteOpen] = useState(false);
  const [start, setStart] = useState<number | "">(1); const [end, setEnd] = useState<number | "">(5);
  const [quoteNotice, setQuoteNotice] = useState(false);
  const reading = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (requestedSource) { setId(requestedSource.materialId); setTurnId(requestedSource.turnId); setCompare(false); setQuoteOpen(false); setStart(requestedSource.startLine ?? 1); }
  }, [requestedSource]);
  useEffect(() => {
    if (!materials.some((item) => item.id === id) && !turnId) setId(materials[0]?.id ?? "");
    if (secondId === id || !materials.some((item) => item.id === secondId)) setSecondId(materials.find((item) => item.id !== id)?.id ?? "");
  }, [materials, id, secondId, turnId]);
  useEffect(() => { setDetail(null); setQuoteOpen(false); reading.current?.scrollTo({ top: 0 }); }, [id, turnId]);
  const options = materials.map((item) => ({ value: item.id, label: `${item.id} ${item.title}` }));
  const lines = detail?.markdown.split("\n") ?? [];
  const canQuote = !!detail && !turnId && materials.some((item) => item.id === id);
  const validRange = validQuoteRange(start, end, lines.length);
  const requestedLine = requestedSource?.materialId === id && requestedSource.turnId === turnId && !compare ? requestedSource.startLine : undefined;
  function choose(value: string) { setId(value); setTurnId(undefined); setQuoteOpen(false); }
  function prepareQuote() {
    const selected = window.getSelection(); const text = selected?.toString().trim() ?? "";
    setQuoteNotice(false);
    if (text && selected?.anchorNode && reading.current?.contains(selected.anchorNode) && detail) {
      const range = selected.focusNode && reading.current.contains(selected.focusNode) ? quoteRangeForText(detail.markdown, text) : null;
      if (range) { setStart(range.startLine); setEnd(range.endLine); }
      else {
        setStart(""); setEnd("");
        setQuoteNotice(true);
      }
    } else { setStart(1); setEnd(Math.min(5, lines.length)); }
    setQuoteOpen(true);
  }
  return <section className="article-material-reader" aria-label={t("创作资料阅读", "Writing materials reader")}>
    <div className="article-reading-tools"><div className="article-material-mode"><button type="button" aria-pressed={!compare} onClick={() => setCompare(false)}>{t("单篇阅读", "Read one")}</button>
      <button type="button" aria-pressed={compare} disabled={materials.length < 2} onClick={() => { if (turnId) choose(materials[0].id); setCompare(true); }}>{t("对照阅读", "Compare")}</button></div>
      <button type="button" className="text-button" disabled={!canQuote || compare} onClick={prepareQuote}>{t("引用选段", "Quote a passage")}</button></div>
    {materials.length > 0 && <div className="article-reference-switcher"><WorkbenchSelect label={compare ? t("对照资料 A", "Compare material A") : t("选择阅读资料", "Choose material to read")} value={materials.some((item) => item.id === id) ? id : ""} onChange={choose}
      options={[...(!materials.some((item) => item.id === id) ? [{ value: "", label: turnId ? t("查看历史引用", "View historical citation") : t("选择资料", "Choose material") }] : []), ...options]} />
      {compare && <WorkbenchSelect label={t("对照资料 B", "Compare material B")} value={secondId} onChange={setSecondId} options={options.filter((item) => item.value !== id)} />}</div>}
    {detail && requestedLine && requestedLine >= 1 && requestedLine <= lines.length && <aside className="article-quote-box" aria-label={t("引用原文位置", "Cited source location")}>
      <strong>{turnId
        ? t(`历史引用起始于原文 L${requestedLine} · 以下为该处原文预览`, `Historical citation starts at line ${requestedLine} · Source preview`)
        : t(`引用起始于原文 L${requestedLine} · 以下为该处原文预览`, `Citation starts at line ${requestedLine} · Source preview`)}</strong>
      <pre>{lines.slice(requestedLine - 1, requestedLine + 4).map((line, index) => `L${requestedLine + index} ${line}`).join("\n")}</pre>
    </aside>}
    {quoteOpen && detail && <div className="article-quote-box"><strong>{id} · {t(`选择原文引用行（共 ${lines.length} 行）`, `Choose lines to quote (${lines.length} ${lines.length === 1 ? "line" : "lines"})`)}</strong>
      {quoteNotice && <p role="status">{t("所选文字无法唯一精确对应原文（可能含格式或重复内容）。请按原文行号手动选择引用范围，填写有效行号后才能引用。", "The selection has no unique match in the source. Enter a valid range using the source line numbers.")}</p>}
      <div><label>{t("开始行", "Start line")}<input aria-label={t("引用开始行", "Quote start line")} type="number" min={1} max={lines.length} value={start} onChange={(event) => setStart(event.target.value === "" ? "" : Number(event.target.value))} /></label>
      <label>{t("结束行", "End line")}<input aria-label={t("引用结束行", "Quote end line")} type="number" min={start || 1} max={lines.length} value={end} onChange={(event) => setEnd(event.target.value === "" ? "" : Number(event.target.value))} /></label>
      <button className="primary-button" disabled={!validRange} onClick={() => { if (validRange && typeof start === "number" && typeof end === "number") { onQuote({ materialId: id, startLine: start, endLine: end }); setQuoteOpen(false); } }}>{t("引用此选段", "Quote this passage")}</button>
      <button className="text-button" onClick={() => setQuoteOpen(false)}>{t("取消", "Cancel")}</button></div>
      {validRange && <pre>{lines.slice(Number(start) - 1, Number(end)).map((line, index) => `L${Number(start) + index} ${line}`).join("\n")}</pre>}
      {!validRange && <details><summary>{t("查看带行号的原文，手动确定范围", "Show line numbers to choose a range")}</summary><pre>{lines.map((line, index) => `L${index + 1} ${line}`).join("\n")}</pre></details>}
    </div>}
    <div ref={reading} className={`article-reference-pages${compare ? " compare" : ""}`}>
      {id ? <MaterialText articleId={articleId} id={id} turnId={turnId} onDetail={setDetail} /> : <div className="article-reader-empty"><h2>{t("先选资料，再开始讨论", "Choose materials to start the discussion")}</h2><p>{t("从多个知识库挑选文章与笔记，阅读、对照后带入对话。", "Read and compare articles and notes from your knowledge bases, then add them to the conversation.")}</p></div>}
      {compare && secondId && <MaterialText articleId={articleId} id={secondId} />}
    </div>
  </section>;
}
