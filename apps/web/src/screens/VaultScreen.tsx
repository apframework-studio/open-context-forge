import { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, type KnowledgeDetail, type KnowledgeGraph as GraphData, type KnowledgeItem,
  type KnowledgeOverview, type KnowledgePage, type SourceAnalysis, type VaultList } from "../api";
import { KnowledgeGraph } from "./KnowledgeGraph";
import { KnowledgeMarkdown } from "./KnowledgeMarkdown";
import { WorkbenchSelect } from "../WorkbenchSelect";
import { PaneResizeHandle } from "../PaneResizeHandle";
import { useLocale, type LocalizedError, type LocalizedNotice, type Translate } from "../locale";
import { useKnowledgeLayout } from "./useKnowledgeLayout";
import { indexIssueEnglish } from "./knowledgeIndexMessages";

interface Props { vaults: VaultList | null; onSettings: () => void }
type Tab = "overview" | "browse" | "graph";
type Folder = { vaultId: string; path: string; count: number };
type GraphLoad = { scope: string; data: GraphData | null; error?: LocalizedError };
type BrowseLoad = { scope: string; data: KnowledgePage | null; error?: LocalizedError };
type FolderLoad = { vaultId: string; items: Folder[]; error?: LocalizedError };
const overviewLimits = ["10", "20", "50"];

function storedOverviewLimit() {
  try {
    const value = localStorage.getItem("ocf-knowledge-overview-limit");
    return value && overviewLimits.includes(value) ? value : "10";
  } catch { return "10"; }
}

function itemLabel(item: KnowledgeItem, t: Translate) { return item.format === "pdf" ? t("PDF 文档", "PDF document") : item.format === "mdx" ? t("MDX 文档", "MDX document") :
  item.format === "text" ? t("文本文件", "Text file") : item.format === "html" ? t("HTML 文档", "HTML document") : item.kind === "source" ? t("来源快照", "Source snapshot") : t("普通笔记", "Note"); }
function itemLocation(item: KnowledgeItem) {
  if (item.kind === "source" && item.originalUrl) {
    try { return new URL(item.originalUrl).hostname.replace(/^www\./, ""); } catch { /* Show the vault path below. */ }
  }
  return `${item.vaultId} / ${item.path}`;
}

export function VaultScreen({ vaults, onSettings }: Props) {
  const { locale, t, errorText, noticeText } = useLocale();
  const date = (value: string | null) => value ? new Date(value).toLocaleString(locale) : "—";
  const [vaultId, setVaultId] = useState("all");
  const [tab, setTab] = useState<Tab>("overview");
  const panes = useKnowledgeLayout(tab === "browse");
  const [overview, setOverview] = useState<KnowledgeOverview | null>(null);
  const [overviewLimit, setOverviewLimit] = useState(storedOverviewLimit);
  const [browseLoad, setBrowseLoad] = useState<BrowseLoad | null>(null);
  const [folderLoad, setFolderLoad] = useState<FolderLoad | null>(null);
  const [graphLoad, setGraphLoad] = useState<GraphLoad | null>(null);
  const [detail, setDetail] = useState<KnowledgeDetail | null>(null);
  const [analysis, setAnalysis] = useState<SourceAnalysis | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  const [folder, setFolder] = useState("");
  const [analysisStatus, setAnalysisStatus] = useState("");
  const [sort, setSort] = useState("recent");
  const [modifiedDays, setModifiedDays] = useState("");
  const [pageNumber, setPageNumber] = useState(1);
  const [graphKind, setGraphKind] = useState("");
  const [graphFocus, setGraphFocus] = useState("");
  const [graphSearchInput, setGraphSearchInput] = useState("");
  const [graphQuery, setGraphQuery] = useState("");
  const [mobilePane, setMobilePane] = useState<"folders" | "results" | "detail">("results");
  const [foldersOpen, setFoldersOpen] = useState(false);
  const [readingFocus, setReadingFocus] = useState(false);
  const [readerView, setReaderView] = useState<"reading" | "markdown">("reading");
  const [anchor, setAnchor] = useState<string | null>(null);
  const [message, setMessage] = useState<LocalizedNotice | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const detailRef = useRef<HTMLElement>(null);
  const detailRequest = useRef(0);
  const actionsRef = useRef<HTMLDetailsElement>(null);
  const graphVaultId = vaultId === "all" ? vaults?.defaultVaultId ?? "default" : vaultId;
  const graphScope = JSON.stringify([graphVaultId, graphKind, graphQuery, graphFocus]);
  const graph = graphLoad?.scope === graphScope ? graphLoad.data : null;
  const graphError = graphLoad?.scope === graphScope ? graphLoad.error : undefined;
  // A refresh has the same scope as the visible results; a new query must not show old results.
  const browseScope = JSON.stringify([vaultId, pageNumber, sort, q, kind, folder, analysisStatus, modifiedDays]);
  const page = browseLoad?.scope === browseScope ? browseLoad.data : null;
  const browseError = browseLoad?.scope === browseScope ? browseLoad.error : undefined;
  const folders = folderLoad?.vaultId === vaultId ? folderLoad.items : [];
  const folderError = folderLoad?.vaultId === vaultId ? folderLoad.error : undefined;
  const directoryVisible = !readingFocus && (panes.layout.wide ? panes.layout.foldersVisible : foldersOpen);
  const listVisible = !readingFocus && panes.layout.listVisible;

  function toggleDirectory() {
    if (readingFocus) {
      setReadingFocus(false); panes.update({ foldersHidden: false }); setFoldersOpen(true);
    } else if (panes.layout.wide) panes.update({ foldersHidden: !panes.preference.foldersHidden });
    else setFoldersOpen((open) => !open);
  }
  function closeDirectory() { setFoldersOpen(false); setMobilePane("results"); if (panes.layout.wide) panes.update({ foldersHidden: true }); }
  function toggleList() {
    if (readingFocus) { setReadingFocus(false); panes.update({ listHidden: false }); }
    else panes.update({ listHidden: !panes.preference.listHidden });
  }

  useEffect(() => {
    const timer = window.setInterval(() => setRefreshKey((value) => value + 1), 10_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (tab !== "overview") return;
    let cancelled = false;
    const params = new URLSearchParams({ limit: overviewLimit });
    if (vaultId !== "all") params.set("vaultId", vaultId);
    void api<KnowledgeOverview>(`/knowledge/overview?${params}`).then((result) => { if (!cancelled) setOverview(result); })
      .catch((error) => { if (!cancelled) setMessage([error, "知识库读取失败", "Could not load the vault"]); });
    return () => { cancelled = true; };
  }, [tab, vaultId, vaults, overviewLimit, refreshKey]);

  useEffect(() => {
    try { localStorage.setItem("ocf-knowledge-overview-limit", overviewLimit); } catch { /* Optional display preference. */ }
  }, [overviewLimit]);

  useEffect(() => {
    if (tab !== "browse") return;
    let cancelled = false;
    const params = new URLSearchParams({ page: String(pageNumber), pageSize: "30", sort });
    if (vaultId !== "all") params.set("vaultId", vaultId);
    if (q) params.set("q", q);
    if (kind) params.set("kind", kind);
    if (folder) params.set("folder", folder);
    if (analysisStatus) params.set("analysisStatus", analysisStatus);
    if (modifiedDays) params.set("modifiedSince", new Date(Date.now() - Number(modifiedDays) * 86_400_000).toISOString());
    void api<KnowledgePage>(`/knowledge/items?${params}`).then((result) => {
      if (cancelled) return;
      setBrowseLoad((previous) => previous?.scope === browseScope && !previous.error &&
        JSON.stringify(previous.data) === JSON.stringify(result) ? previous : { scope: browseScope, data: result });
    }).catch((error) => {
      if (!cancelled) setBrowseLoad((previous) => ({ scope: browseScope,
        data: previous?.scope === browseScope ? previous.data : null,
        error: [error, "内容列表读取失败", "Could not load the list"] }));
    });
    const folderParams = vaultId === "all" ? "" : `?vaultId=${encodeURIComponent(vaultId)}`;
    void api<{ items: Folder[] }>(`/knowledge/folders${folderParams}`).then((result) => {
      if (cancelled) return;
      setFolderLoad((previous) => previous?.vaultId === vaultId && !previous.error &&
        JSON.stringify(previous.items) === JSON.stringify(result.items) ? previous : { vaultId, items: result.items });
    }).catch((error) => {
      if (!cancelled) setFolderLoad((previous) => ({ vaultId,
        items: previous?.vaultId === vaultId ? previous.items : [],
        error: [error, "目录读取失败", "Could not load folders"] }));
    });
    return () => { cancelled = true; };
  }, [tab, vaultId, pageNumber, sort, q, kind, folder, analysisStatus, modifiedDays, browseScope, refreshKey]);

  useEffect(() => {
    if (tab !== "graph") return;
    let cancelled = false;
    const params = new URLSearchParams();
    if (graphQuery) params.set("q", graphQuery);
    if (graphKind) params.set("kind", graphKind);
    if (graphFocus) params.set("focus", graphFocus);
    void api<GraphData>(`/knowledge/graph/${encodeURIComponent(graphVaultId)}?${params}`).then((result) => {
      if (!cancelled) setGraphLoad({ scope: graphScope, data: result });
    }).catch((error) => {
      if (!cancelled) setGraphLoad({ scope: graphScope, data: null,
        error: [error, "图谱读取失败", "Could not load the graph"] });
    });
    return () => { cancelled = true; };
  }, [tab, graphScope, refreshKey]);

  function scrollToAnchor(fragment: string) {
    const reader = detailRef.current;
    if (!reader) return;
    const normalize = (value: string) => value.trim().normalize("NFC").toLocaleLowerCase().replace(/\s+/g, "-");
    const heading = [...reader.querySelectorAll<HTMLElement>(".knowledge-detail-header h2, .knowledge-markdown :is(h1,h2,h3,h4,h5,h6)")]
      .find((heading) => normalize(heading.textContent ?? "") === normalize(fragment));
    if (!heading) { setMessage([`已打开笔记，但未找到标题“${fragment}”。`, `The note opened, but the heading “${fragment}” could not be found.`]); return; }
    if (getComputedStyle(reader).overflowY === "auto") reader.scrollTo({ top: reader.scrollTop + heading.getBoundingClientRect().top - reader.getBoundingClientRect().top - 60 });
    else heading.scrollIntoView({ block: "start" });
  }

  useEffect(() => {
    if (!detail || !anchor || readerView !== "reading") return;
    scrollToAnchor(anchor); setAnchor(null);
  }, [detail, anchor, readerView]);

  useEffect(() => () => { detailRequest.current += 1; }, []);

  async function openItem(item: Pick<KnowledgeItem, "vaultId" | "path">, fragment?: string) {
    const request = ++detailRequest.current;
    setTab("browse"); setMobilePane("detail"); setFoldersOpen(false); setDetail(null); setAnalysis(null); setMessage(null);
    setReaderView("reading"); setAnchor(fragment ?? null);
    detailRef.current?.scrollTo({ top: 0 });
    try {
      const result = await api<KnowledgeDetail>(`/knowledge/items/${encodeURIComponent(item.vaultId)}?path=${encodeURIComponent(item.path)}`);
      if (request !== detailRequest.current) return;
      setDetail(result);
      if (result.kind === "source" && result.analysisStatus) {
        const params = new URLSearchParams({ vaultId: item.vaultId, snapshot: item.path });
        void api<SourceAnalysis>(`/sources/analysis?${params}`).then((result) => {
          if (request === detailRequest.current) setAnalysis(result);
        }).catch(() => undefined);
      }
    } catch (error) {
      if (request === detailRequest.current) {
        setReadingFocus(false); setMobilePane("results"); panes.update({ listHidden: false });
        setMessage([error, "文件读取失败", "Could not read the file"]);
      }
    }
  }

  async function rescan() {
    setMessage(null);
    try {
      const targets = vaultId === "all" ? vaults?.vaults.map((vault) => vault.id) ?? [] : [vaultId];
      await Promise.all(targets.map((id) => api(`/knowledge/${encodeURIComponent(id)}/rescan`, { method: "POST" })));
      setRefreshKey((value) => value + 1); setMessage(["知识库已重新索引", "Vault reindexed"]);
    } catch (error) { setMessage([error, "重新索引失败", "Could not reindex the vault"]); }
  }

  function selectVault(id: string) {
    detailRequest.current += 1;
    setVaultId(id); setFolder(""); setPageNumber(1); setDetail(null); setGraphFocus("");
    setReadingFocus(false); setAnchor(null);
    setGraphQuery(""); setGraphSearchInput(""); setFoldersOpen(false);
  }

  const selectedSummary = overview?.vaults.find((vault) => vault.id === vaultId);
  const directories = useMemo(() => folders.filter((item) => item.count > 0 && (vaultId === "all" || item.vaultId === vaultId)), [folders, vaultId]);
  const pageCount = page ? Math.max(1, Math.ceil(page.total / page.pageSize)) : 1;
  const totalItems = page?.total ?? 0;
  const graphTitle = t(`${graphVaultId} 关系图谱`, `${graphVaultId} link graph`);
  const browseErrorText = browseError && errorText(...browseError);
  const folderErrorText = folderError && errorText(...folderError);
  const overviewEntry = (item: KnowledgeItem) => <button key={`${item.vaultId}:${item.path}`} className="knowledge-recent-item" onClick={() => void openItem(item)}>
    <span className="knowledge-recent-main"><strong>{item.title}</strong><small>{itemLabel(item, t)} · {item.vaultId}</small></span>
    <time dateTime={item.importedAt ?? item.modifiedAt}>{item.kind === "note" ? t("修改于", "Modified") : item.importedAt ? t("入库于", "Filed") : t("文件修改于", "File modified")} {date(item.importedAt ?? item.modifiedAt)}</time>
  </button>;

  return <div className={`knowledge-workspace${tab === "graph" ? " graph-active" : tab === "browse" ? " browse-active" : ""}`}>
    <div className="knowledge-topline">
      <div className="knowledge-tabs" role="tablist" aria-label={t("知识库视图", "Knowledge views")}>
        {(["overview", "browse", "graph"] as const).map((value) => <button key={value} role="tab" aria-selected={tab === value}
          className={tab === value ? "active" : ""} onClick={() => setTab(value)}>{value === "overview" ? t("概览", "Overview") : value === "browse" ? t("浏览", "Browse") : t("图谱", "Graph")}</button>)}
      </div>
      <div className="knowledge-toolbar">
        <WorkbenchSelect className="knowledge-vault-select" label={t("选择知识库", "Choose vault")} value={vaultId} onChange={selectVault}
          options={[{ value: "all", label: t("全部知识库", "All vaults") }, ...(vaults?.vaults.map((vault) => ({ value: vault.id, label: `${vault.id}${vault.isDefault ? t(" · 默认", " · Default") : ""}` })) ?? [])]} />
        <form className="knowledge-search" onSubmit={(event) => { event.preventDefault(); setQ(searchInput.trim()); setPageNumber(1); setMobilePane("results"); setTab("browse"); }}>
          <input aria-label={t("搜索知识库", "Search knowledge")} placeholder={t("搜索标题、路径与正文", "Search titles, paths, and text")} value={searchInput} onChange={(event) => setSearchInput(event.target.value)} />
          <button className="secondary-button" type="submit">{t("搜索", "Search")}</button></form>
        <details className="knowledge-actions" ref={actionsRef}>
          <summary role="button" aria-label={t("更多操作", "More actions")} title={t("更多操作", "More actions")}>…</summary>
          <div className="knowledge-actions-menu">
            <button type="button" onClick={() => { actionsRef.current?.removeAttribute("open"); void rescan(); }}>{t("重新索引", "Reindex")}</button>
            <button type="button" onClick={() => { actionsRef.current?.removeAttribute("open"); onSettings(); }}>{t("知识库连接设置", "Vault connections")}</button>
          </div>
        </details>
      </div>
    </div>
    {message && <p className="inline-message" role="status">{noticeText(message)}</p>}
    {tab === "overview" && <div className="knowledge-overview">
      <section className="panel-card">
        <div className="section-heading"><div><span className="overline">LIBRARY STATUS</span><h2>{vaultId === "all" ? t("全部知识库", "All vaults") : t(`${vaultId} 概览`, `${vaultId} overview`)}</h2></div></div>
        <div className="knowledge-stats">{(vaultId === "all" ? overview?.vaults : selectedSummary ? [selectedSummary] : [])?.map((vault) =>
          <article key={vault.id}><strong>{vault.id}</strong><span>{vault.kind === "built-in" ? t("内置库", "Built-in vault") : t("外部 Obsidian 库", "External Obsidian vault")} · {vault.path}</span>
            <span>{t(`${vault.sources} 篇来源 · ${vault.notes} 份库内文档 · 库内分析文件 ${vault.confirmedAnalyses}`,
              `${vault.sources} ${vault.sources === 1 ? "source" : "sources"} · ${vault.notes} ${vault.notes === 1 ? "document" : "documents"} · ${vault.confirmedAnalyses} ${vault.confirmedAnalyses === 1 ? "analysis file" : "analysis files"}`)}</span>
            <small>{t(`上次索引：${date(vault.indexedAt)}`, `Last indexed ${date(vault.indexedAt)}`)}</small>
            {vault.errors.length > 0 && <small className="inline-message error">{t(`读取异常：${vault.errors.join("；")}`,
              `Indexing issues · ${vault.errors.map(indexIssueEnglish).join(" · ")}`)}</small>}</article>)}</div>
      </section>
      <div className="knowledge-overview-controls"><span>{t("来源按入库时间、笔记按修改时间排序", "Sources sorted by filing date, notes by modification date")}</span>
        <WorkbenchSelect label={t("每组显示", "Items per group")} value={overviewLimit} onChange={setOverviewLimit}
          options={overviewLimits.map((limit) => ({ value: limit, label: t(`${limit} 条`, limit) }))} /></div>
      <section className="panel-card"><div className="section-heading"><div><span className="overline">RECENT SOURCES</span><h2>{t("刚入库来源", "Recently filed sources")}</h2></div></div>
        <div className="knowledge-recent-list">{overview?.recentSources.length ? overview.recentSources.map(overviewEntry) : <p className="muted">{t("还没有已保存的来源快照。", "No source snapshots yet.")}</p>}</div></section>
      <section className="panel-card"><div className="section-heading"><div><span className="overline">RECENT NOTES</span><h2>{t("最近修改笔记", "Recently modified notes")}</h2></div></div>
        <div className="knowledge-recent-list">{overview?.recentNotes.length ? overview.recentNotes.map(overviewEntry) : <p className="muted">{t("还没有知识笔记。已保存来源仍可在“浏览”中查看。", "No notes yet. Open Browse to see your saved sources.")}</p>}</div></section>
      {selectedSummary && <section className="panel-card"><div className="section-heading"><div><span className="overline">CURATED INDEX</span><h2>{t("人工索引导读", "Curated index")}</h2></div></div>
        {selectedSummary.indexMarkdown ? <div className="markdown-body"><Markdown remarkPlugins={[remarkGfm]} skipHtml>{selectedSummary.indexMarkdown}</Markdown></div> :
          <p className="muted">{t("该知识库尚未配置人工索引文件；文件和来源已经自动索引。", "This vault uses automatic indexing for files and sources.")}</p>}</section>}
    </div>}
    {tab === "browse" && <div ref={panes.ref} style={panes.style} data-layout={panes.layout.wide ? "wide" : "compact"}
      className={`knowledge-browser panel-card pane-${mobilePane}${foldersOpen ? " folder-open" : ""}${readingFocus ? " reading-focus" : ""}${panes.preference.foldersHidden ? " folders-collapsed" : ""}${panes.preference.listHidden ? " list-collapsed" : ""}`}>
      <div className="knowledge-mobile-nav"><button className={mobilePane === "folders" ? "active" : ""} onClick={() => setMobilePane("folders")}>{t("目录", "Folders")}</button>
        <button className={mobilePane === "results" ? "active" : ""} onClick={() => setMobilePane("results")}>{t("列表", "List")}</button>
        <button className={mobilePane === "detail" ? "active" : ""} disabled={!detail} onClick={() => setMobilePane("detail")}>{t("详情", "Details")}</button></div>
      <aside id="knowledge-folders" className="knowledge-folders" aria-label={t("知识库目录", "Vault folders")} onKeyDown={(event) => { if (event.key === "Escape") closeDirectory(); }}><div className="knowledge-folders-heading"><h3 title={folderErrorText ? t(`目录更新失败，将自动重试：${folderErrorText}`, `Folder refresh failed. Retrying automatically. ${folderErrorText}`) : undefined}>{t("文件夹", "Folders")}</h3>
        <button className="text-button knowledge-folder-close" onClick={closeDirectory} aria-label={t("关闭目录", "Close folders")}>{t("收起", "Close")}</button></div>
        <div className="knowledge-folder-list">
        <button className={!folder ? "active" : ""} onClick={() => { setFolder(""); setFoldersOpen(false); setPageNumber(1); setMobilePane("results"); }}>{t("全部文件", "All files")}</button>
        {directories.map((item) => <button key={`${item.vaultId}:${item.path}`} className={folder === item.path && vaultId === item.vaultId ? "active" : ""}
          title={`${item.vaultId} / ${item.path || t("根目录", "Root folder")}`} aria-label={`${item.vaultId} / ${item.path || t("根目录", "Root folder")}`}
          style={{ paddingLeft: 8 + (item.path ? Math.min(4, item.path.split("/").length) * 12 : 0) }}
          onClick={() => { selectVault(item.vaultId); setFolder(item.path); setFoldersOpen(false); setMobilePane("results"); }}>
          <span className="knowledge-folder-name">{item.path.split("/").filter(Boolean).at(-1) || item.vaultId}</span><small title={t("包含子目录的文档数；不含图片", "Documents in this folder and its subfolders")}>{item.count}</small></button>)}</div></aside>
      <PaneResizeHandle className="knowledge-folder-resize" label={t("调整目录宽度", "Resize folder pane")} controls="knowledge-folders" value={panes.layout.folderWidth}
        min={panes.layout.minFolder} max={panes.layout.maxFolder} onChange={(folders) => panes.update({ folders })} onReset={() => panes.update({ folders: undefined })} />
      <section id="knowledge-results" className="knowledge-results"><div className="knowledge-results-top">
        <button className="knowledge-folder-toggle" type="button" onClick={toggleDirectory}
          aria-expanded={directoryVisible} aria-label={directoryVisible ? t("隐藏目录", "Hide folders") : t("显示目录", "Show folders")}>{t("目录", "Folders")}</button>
        <strong title={folder || t("全部内容", "All content")}>{folder ? folder.split("/").at(-1) : t("全部内容", "All content")}</strong>
        <span title={browseErrorText ? t(`列表更新失败，将自动重试：${browseErrorText}`, `List refresh failed. Retrying automatically. ${browseErrorText}`) : undefined}>
          {t(`${totalItems} 项`, `${totalItems} ${totalItems === 1 ? "item" : "items"}`)}</span>
        <button type="button" className="text-button knowledge-list-close" title={t("收起列表", "Collapse list")} aria-label={t("收起资料列表", "Collapse item list")} disabled={!detail} onClick={toggleList}>‹</button></div>
        <div className="knowledge-filter-row">
        <WorkbenchSelect label={t("内容类型", "Content type")} value={kind} onChange={(value) => { setKind(value); setPageNumber(1); }}
          options={[{ value: "", label: t("全部类型", "All types") }, { value: "source", label: t("来源快照", "Source snapshot") }, { value: "note", label: t("库内文档", "Vault documents") }]} />
        <WorkbenchSelect label={t("排序", "Sort by")} value={sort} onChange={(value) => { setSort(value); setPageNumber(1); }}
          options={[{ value: "recent", label: t("最近入库", "Recently filed") }, { value: "modified", label: t("最近修改", "Recently modified") }, { value: "title", label: t("标题", "Title") }]} /></div>
        <details className="knowledge-extra-filters"><summary>{t("更多筛选", "More filters")}{analysisStatus || modifiedDays ? t(" · 已启用", " · Active") : ""}</summary>
          <div><WorkbenchSelect label={t("分析状态", "Analysis status")} value={analysisStatus} onChange={(value) => { setAnalysisStatus(value); setPageNumber(1); }}
            options={[{ value: "", label: t("全部分析文件", "Any analysis status") }, { value: "none", label: t("无分析文件", "Without analysis") }, { value: "analyzed", label: t("有分析文件", "Analysis available") }]} />
          <WorkbenchSelect label={t("修改时间", "Modified")} value={modifiedDays} onChange={(value) => { setModifiedDays(value); setPageNumber(1); }}
            options={[{ value: "", label: t("不限修改时间", "Any time") }, { value: "7", label: t("最近 7 天", "Past 7 days") }, { value: "30", label: t("最近 30 天", "Past 30 days") }]} />
          </div></details>{q && <div className="knowledge-list-meta">{t(`${totalItems} 项 · 搜索“${q}”`, `${totalItems} ${totalItems === 1 ? "result" : "results"} for “${q}”`)}</div>}
        <div className="knowledge-item-list">{page?.items.length ? page.items.map((item) => <button key={`${item.vaultId}:${item.path}`}
          className={`knowledge-item ${detail?.path === item.path && detail.vaultId === item.vaultId ? "active" : ""}`} onClick={() => void openItem(item)}>
          <span className={`knowledge-kind ${item.kind}`}>{itemLabel(item, t)}</span><strong>{item.title}</strong>
          <small title={`${item.vaultId} / ${item.path}`}>{itemLocation(item)}</small>{item.kind === "note" && item.snippet && <p>{item.snippet}</p>}
          <time>{date(item.importedAt ?? item.modifiedAt)}</time>
          {item.analysisStatus && <span className="tag">{t("有分析文件", "Analysis available")}</span>}</button>) :
            <p className="source-empty">{browseErrorText && !page ? t(`内容读取失败，将自动重试：${browseErrorText}`,
              `Could not load content. Retrying automatically. ${browseErrorText}`) : page ? t("没有匹配内容。可尝试清除筛选或重新索引。", "No results. Try clearing filters or reindexing.") : t("内容读取中…", "Loading content…")}</p>}</div>
        {page && <div className="source-pagination"><span>{t(`第 ${pageNumber} / ${pageCount} 页`, `Page ${pageNumber} of ${pageCount}`)}</span><div>
          <button className="text-button" disabled={pageNumber <= 1} onClick={() => setPageNumber((value) => value - 1)}>{t("上一页", "Previous")}</button>
          <button className="text-button" disabled={pageNumber * page.pageSize >= page.total} onClick={() => setPageNumber((value) => value + 1)}>{t("下一页", "Next")}</button></div></div>}</section>
      <PaneResizeHandle className="knowledge-list-resize" label={t("调整列表宽度", "Resize list pane")} controls="knowledge-results" value={panes.layout.listWidth}
        min={panes.layout.minList} max={panes.layout.maxList} onChange={(list) => panes.update({ list })} onReset={() => panes.update({ list: undefined })} />
      <section className="knowledge-detail" aria-label={t("内容详情", "Content details")} ref={detailRef}>
        <div className="knowledge-reader-toolbar"><div className="knowledge-pane-toggles">
          <button type="button" aria-label={directoryVisible ? t("收起目录", "Collapse folders") : t("显示目录", "Show folders")} aria-expanded={directoryVisible} className="text-button" onClick={toggleDirectory}>{t("目录", "Folders")}</button>
          <button type="button" aria-label={listVisible ? t("收起列表", "Collapse list") : t("显示列表", "Show list")} aria-expanded={listVisible} className="text-button" onClick={toggleList}>{t("列表", "List")}</button></div>
          <span title={detail ? `${detail.vaultId} / ${detail.path}` : undefined}>{detail ? `${detail.vaultId} / ${detail.path}` : t("选择内容开始阅读", "Select an item to read")}</span>
          {detail && <>
          {detail.format !== "pdf" && !detail.previewLimited && <button type="button" className="text-button" aria-pressed={readerView === "markdown"} onClick={() => setReaderView((view) => view === "reading" ? "markdown" : "reading")}>
            {readerView === "reading" ? t("查看 Markdown", "View Markdown") : t("阅读正文", "Read document")}</button>}
          <button type="button" className="text-button knowledge-focus-toggle" aria-pressed={readingFocus} onClick={() => setReadingFocus((focused) => !focused)}>
            {readingFocus ? t("退出专注", "Exit focus mode") : t("专注阅读", "Focus mode")}</button></>}
        </div>{detail ? <>
        <div className="knowledge-detail-header"><h2>{detail.title}</h2>
          <div className="knowledge-document-byline"><span className={`knowledge-kind ${detail.kind}`}>{itemLabel(detail, t)}</span>
            <small>{detail.author || detail.vaultId} · {date(detail.importedAt ?? detail.modifiedAt)}</small></div></div>
        <div className="knowledge-detail-actions">
          {detail.originalUrl && /^https?:\/\//i.test(detail.originalUrl) && <a className="text-button" href={detail.originalUrl} target="_blank" rel="noopener noreferrer">{t("查看原始网页", "View original page")}</a>}
          {detail.kind === "note" && <a className="text-button" href={`obsidian://open?path=${encodeURIComponent(detail.absolutePath)}`}>{t("在 Obsidian 打开", "Open in Obsidian")}</a>}</div>
        <details className="knowledge-context"><summary>{t("资料信息与关联", "Details and links")} <span>
          {t(`出链 ${detail.outlinks.length} · 反向链接 ${detail.backlinks.length}`, `Outgoing ${detail.outlinks.length} · Backlinks ${detail.backlinks.length}`)}
          {analysis ? t(" · 有智能摘要", " · Smart summary available") : ""}</span></summary>
        <div className="knowledge-context-body"><button className="text-button" onClick={() => void navigator.clipboard.writeText(detail.absolutePath)}>{t("复制本机路径", "Copy local path")}</button>
        <dl className="knowledge-meta"><dt>{t("本机路径", "Local path")}</dt><dd>{detail.absolutePath}</dd><dt>{detail.kind === "source" ? t("入库时间", "Filed") : t("修改时间", "Modified")}</dt><dd>{date(detail.importedAt ?? detail.modifiedAt)}</dd>
          {detail.originalUrl && <><dt>{t("原始来源", "Original source")}</dt><dd>{/^https?:\/\//i.test(detail.originalUrl) ?
            <a href={detail.originalUrl} target="_blank" rel="noopener noreferrer">{detail.originalUrl}</a> : detail.originalUrl}</dd></>}
          {detail.kind === "source" && <><dt>{t("归属", "Authorship")}</dt><dd>{detail.authorship === "third_party" ? t("第三方来源", "Third-party source") : detail.authorship === "self" ? t("本人内容", "My own content") : t("未知", "Unknown")}{detail.author ? ` · ${detail.author}` : ""}</dd></>}
          {detail.fingerprint && <><dt>{t("内容指纹", "Content fingerprint")}</dt><dd><code>{detail.fingerprint}</code></dd></>}</dl>
        {analysis && <div className="analysis-card"><strong>{t("来源分析文件", "Source analysis")}</strong><p>{analysis.summary}</p>
          <ul>{analysis.mainPoints.map((point, index) => <li key={index}>{point.claim}</li>)}</ul></div>}
        <div className="knowledge-link-groups"><div><strong>{t("出链", "Outgoing links")} {detail.outlinks.length}</strong>{detail.outlinks.map((link) => <button key={`${link.to}:${link.line}`}
          className="text-button" onClick={() => void openItem({ vaultId: detail.vaultId, path: link.to } as KnowledgeItem)}>{link.to} · L{link.line}</button>)}</div>
          <div><strong>{t("反向链接", "Backlinks")} {detail.backlinks.length}</strong>{detail.backlinks.map((link) => <button key={`${link.from}:${link.line}`} className="text-button"
            onClick={() => void openItem({ vaultId: detail.vaultId, path: link.from } as KnowledgeItem)}>{link.from} · L{link.line}</button>)}</div></div>
        {!!detail.issues.length && <p className="knowledge-issues">{t("未解析链接：", "Unresolved links · ")}{detail.issues.map((issue) => {
          const reason = issue.reason === "ambiguous" ? t("目标有歧义", "Ambiguous target") : t("目标不存在", "Missing target");
          return t(`${issue.target}（${reason}）`, `${issue.target} (${reason})`);
        }).join(t("、", ", "))}</p>}
        </div></details>
        {readerView === "markdown" ? <pre className="knowledge-document-source">{detail.markdown}</pre> :
          <KnowledgeMarkdown key={`${detail.vaultId}:${detail.path}`} item={detail} onNavigate={(path, fragment) => void openItem({ vaultId: detail.vaultId, path }, fragment)} onAnchor={scrollToAnchor} />}
      </> : <div className="knowledge-detail-empty">{t("选择来源或笔记，查看原文、智能摘要和可验证链接。", "Select a source or note to read it and view its summary and verified links.")}</div>}</section>
    </div>}
    {tab === "graph" && <section className="panel-card knowledge-graph-panel">
      {graph ? <KnowledgeGraph graph={graph} title={graphTitle}
        tools={<>
          <WorkbenchSelect label={t("图谱节点类型", "Graph node type")} value={graphKind} onChange={setGraphKind}
            options={[{ value: "", label: t("全部节点", "All nodes") }, { value: "source", label: t("来源", "Sources") }, { value: "note", label: t("笔记", "Notes") }]} />
          <form className="knowledge-graph-search" onSubmit={(event) => { event.preventDefault(); setGraphQuery(graphSearchInput.trim()); setGraphFocus(""); }}>
            <input aria-label={t("定位图谱节点", "Find graph nodes")} placeholder={t("输入标题或路径定位节点", "Find nodes by title or path")} value={graphSearchInput} onChange={(event) => setGraphSearchInput(event.target.value)} />
            <button className="secondary-button" type="submit">{t("定位", "Find")}</button>
            <button className="text-button" type="button" onClick={() => { setGraphSearchInput(""); setGraphQuery(""); setGraphFocus(""); }}>{t("清除", "Clear")}</button></form>
        </>}
        onNode={(item) => void openItem(item)} onFocus={setGraphFocus} onResetFocus={() => setGraphFocus("")} /> :
        <div className="knowledge-graph-placeholder" role={graphError ? "alert" : "status"}>
          <strong>{graphTitle}</strong><span>{graphError ? errorText(...graphError) : t("关系图谱加载中…", "Loading link graph…")}</span>
        </div>}
    </section>}
  </div>;
}
