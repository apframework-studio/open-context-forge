import { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, type KnowledgeDetail, type KnowledgeGraph as GraphData, type KnowledgeItem,
  type KnowledgeOverview, type KnowledgePage, type SourceAnalysis, type VaultList } from "../api";
import { KnowledgeGraph } from "./KnowledgeGraph";
import { KnowledgeMarkdown } from "./KnowledgeMarkdown";
import { WorkbenchSelect } from "../WorkbenchSelect";
import { PaneResizeHandle } from "../PaneResizeHandle";
import { useKnowledgeLayout } from "./useKnowledgeLayout";

interface Props { vaults: VaultList | null; onSettings: () => void }
type Tab = "overview" | "browse" | "graph";
type Folder = { vaultId: string; path: string; count: number };
type GraphLoad = { scope: string; data: GraphData | null; error?: string };
type BrowseLoad = { scope: string; data: KnowledgePage | null; error?: string };
type FolderLoad = { vaultId: string; items: Folder[]; error?: string };
const overviewLimits = ["10", "20", "50"];

function storedOverviewLimit() {
  try {
    const value = localStorage.getItem("ocf-knowledge-overview-limit");
    return value && overviewLimits.includes(value) ? value : "10";
  } catch { return "10"; }
}

function date(value: string | null) { return value ? new Date(value).toLocaleString("zh-CN") : "—"; }
function itemLabel(item: KnowledgeItem) { return item.format === "pdf" ? "PDF 文档" : item.format === "mdx" ? "MDX 文档" :
  item.format === "text" ? "文本文件" : item.format === "html" ? "HTML 文档" : item.kind === "source" ? "来源快照" : "普通笔记"; }
function itemLocation(item: KnowledgeItem) {
  if (item.kind === "source" && item.originalUrl) {
    try { return new URL(item.originalUrl).hostname.replace(/^www\./, ""); } catch { /* Show the vault path below. */ }
  }
  return `${item.vaultId} / ${item.path}`;
}

export function VaultScreen({ vaults, onSettings }: Props) {
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
  const [message, setMessage] = useState("");
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
      .catch((error) => { if (!cancelled) setMessage(error instanceof Error ? error.message : "知识库读取失败"); });
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
        error: error instanceof Error ? error.message : "内容列表读取失败" }));
    });
    const folderParams = vaultId === "all" ? "" : `?vaultId=${encodeURIComponent(vaultId)}`;
    void api<{ items: Folder[] }>(`/knowledge/folders${folderParams}`).then((result) => {
      if (cancelled) return;
      setFolderLoad((previous) => previous?.vaultId === vaultId && !previous.error &&
        JSON.stringify(previous.items) === JSON.stringify(result.items) ? previous : { vaultId, items: result.items });
    }).catch((error) => {
      if (!cancelled) setFolderLoad((previous) => ({ vaultId,
        items: previous?.vaultId === vaultId ? previous.items : [],
        error: error instanceof Error ? error.message : "目录读取失败" }));
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
        error: `图谱读取失败：${error instanceof Error ? error.message : String(error)}` });
    });
    return () => { cancelled = true; };
  }, [tab, graphScope, refreshKey]);

  function scrollToAnchor(fragment: string) {
    const reader = detailRef.current;
    if (!reader) return;
    const normalize = (value: string) => value.trim().normalize("NFC").toLocaleLowerCase().replace(/\s+/g, "-");
    const heading = [...reader.querySelectorAll<HTMLElement>(".knowledge-detail-header h2, .knowledge-markdown :is(h1,h2,h3,h4,h5,h6)")]
      .find((heading) => normalize(heading.textContent ?? "") === normalize(fragment));
    if (!heading) { setMessage(`已打开笔记，但未找到标题“${fragment}”。`); return; }
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
    setTab("browse"); setMobilePane("detail"); setFoldersOpen(false); setDetail(null); setAnalysis(null); setMessage("");
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
        setMessage(error instanceof Error ? error.message : "文件读取失败");
      }
    }
  }

  async function rescan() {
    setMessage("");
    try {
      const targets = vaultId === "all" ? vaults?.vaults.map((vault) => vault.id) ?? [] : [vaultId];
      await Promise.all(targets.map((id) => api(`/knowledge/${encodeURIComponent(id)}/rescan`, { method: "POST" })));
      setRefreshKey((value) => value + 1); setMessage("知识库已重新索引");
    } catch (error) { setMessage(error instanceof Error ? error.message : "重新索引失败"); }
  }

  function selectVault(id: string) {
    detailRequest.current += 1;
    setVaultId(id); setFolder(""); setPageNumber(1); setDetail(null); setGraphFocus("");
    setReadingFocus(false); setAnchor(null);
    setGraphQuery(""); setGraphSearchInput(""); setFoldersOpen(false);
  }

  const selectedSummary = overview?.vaults.find((vault) => vault.id === vaultId);
  const directories = useMemo(() => folders.filter((item) => item.count > 0 && (vaultId === "all" || item.vaultId === vaultId)), [folders, vaultId]);
  const overviewEntry = (item: KnowledgeItem) => <button key={`${item.vaultId}:${item.path}`} className="knowledge-recent-item" onClick={() => void openItem(item)}>
    <span className="knowledge-recent-main"><strong>{item.title}</strong><small>{itemLabel(item)} · {item.vaultId}</small></span>
    <time dateTime={item.importedAt ?? item.modifiedAt}>{item.kind === "note" ? "修改于" : item.importedAt ? "入库于" : "文件修改于"} {date(item.importedAt ?? item.modifiedAt)}</time>
  </button>;

  return <div className={`knowledge-workspace${tab === "graph" ? " graph-active" : tab === "browse" ? " browse-active" : ""}`}>
    <div className="knowledge-topline">
      <div className="knowledge-tabs" role="tablist" aria-label="知识库视图">
        {(["overview", "browse", "graph"] as const).map((value) => <button key={value} role="tab" aria-selected={tab === value}
          className={tab === value ? "active" : ""} onClick={() => setTab(value)}>{value === "overview" ? "概览" : value === "browse" ? "浏览" : "图谱"}</button>)}
      </div>
      <div className="knowledge-toolbar">
        <WorkbenchSelect className="knowledge-vault-select" label="选择知识库" value={vaultId} onChange={selectVault}
          options={[{ value: "all", label: "全部知识库" }, ...(vaults?.vaults.map((vault) => ({ value: vault.id, label: `${vault.id}${vault.isDefault ? " · 默认" : ""}` })) ?? [])]} />
        <form className="knowledge-search" onSubmit={(event) => { event.preventDefault(); setQ(searchInput.trim()); setPageNumber(1); setMobilePane("results"); setTab("browse"); }}>
          <input aria-label="搜索知识库" placeholder="搜索标题、路径与正文" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} />
          <button className="secondary-button" type="submit">搜索</button></form>
        <details className="knowledge-actions" ref={actionsRef}>
          <summary role="button" aria-label="更多操作" title="更多操作">···</summary>
          <div className="knowledge-actions-menu">
            <button type="button" onClick={() => { actionsRef.current?.removeAttribute("open"); void rescan(); }}>重新索引</button>
            <button type="button" onClick={() => { actionsRef.current?.removeAttribute("open"); onSettings(); }}>知识库连接设置</button>
          </div>
        </details>
      </div>
    </div>
    {message && <p className="inline-message" role="status">{message}</p>}
    {tab === "overview" && <div className="knowledge-overview">
      <section className="panel-card">
        <div className="section-heading"><div><span className="overline">LIBRARY STATUS</span><h2>{vaultId === "all" ? "全部知识库" : `${vaultId} 概览`}</h2></div></div>
        <div className="knowledge-stats">{(vaultId === "all" ? overview?.vaults : selectedSummary ? [selectedSummary] : [])?.map((vault) =>
          <article key={vault.id}><strong>{vault.id}</strong><span>{vault.kind === "built-in" ? "内置库" : "外部 Obsidian 库"} · {vault.path}</span>
            <span>{vault.sources} 篇来源 · {vault.notes} 份库内文档 · 库内分析文件 {vault.confirmedAnalyses}</span>
            <small>上次索引：{date(vault.indexedAt)}</small>{vault.errors.length > 0 && <small className="inline-message error">读取异常：{vault.errors.join("；")}</small>}</article>)}</div>
      </section>
      <div className="knowledge-overview-controls"><span>来源按入库时间、笔记按修改时间排序</span>
        <WorkbenchSelect label="每组显示" value={overviewLimit} onChange={setOverviewLimit}
          options={overviewLimits.map((limit) => ({ value: limit, label: `${limit} 条` }))} /></div>
      <section className="panel-card"><div className="section-heading"><div><span className="overline">RECENT SOURCES</span><h2>刚入库来源</h2></div></div>
        <div className="knowledge-recent-list">{overview?.recentSources.length ? overview.recentSources.map(overviewEntry) : <p className="muted">还没有已保存的来源快照。</p>}</div></section>
      <section className="panel-card"><div className="section-heading"><div><span className="overline">RECENT NOTES</span><h2>最近修改笔记</h2></div></div>
        <div className="knowledge-recent-list">{overview?.recentNotes.length ? overview.recentNotes.map(overviewEntry) : <p className="muted">还没有知识笔记。已保存来源仍可在“浏览”中查看。</p>}</div></section>
      {selectedSummary && <section className="panel-card"><div className="section-heading"><div><span className="overline">CURATED INDEX</span><h2>人工索引导读</h2></div></div>
        {selectedSummary.indexMarkdown ? <div className="markdown-body"><Markdown remarkPlugins={[remarkGfm]} skipHtml>{selectedSummary.indexMarkdown}</Markdown></div> :
          <p className="muted">该知识库尚未配置人工索引文件；文件和来源已经自动索引。</p>}</section>}
    </div>}
    {tab === "browse" && <div ref={panes.ref} style={panes.style} data-layout={panes.layout.wide ? "wide" : "compact"}
      className={`knowledge-browser panel-card pane-${mobilePane}${foldersOpen ? " folder-open" : ""}${readingFocus ? " reading-focus" : ""}${panes.preference.foldersHidden ? " folders-collapsed" : ""}${panes.preference.listHidden ? " list-collapsed" : ""}`}>
      <div className="knowledge-mobile-nav"><button className={mobilePane === "folders" ? "active" : ""} onClick={() => setMobilePane("folders")}>目录</button>
        <button className={mobilePane === "results" ? "active" : ""} onClick={() => setMobilePane("results")}>列表</button>
        <button className={mobilePane === "detail" ? "active" : ""} disabled={!detail} onClick={() => setMobilePane("detail")}>详情</button></div>
      <aside id="knowledge-folders" className="knowledge-folders" aria-label="知识库目录" onKeyDown={(event) => { if (event.key === "Escape") closeDirectory(); }}><div className="knowledge-folders-heading"><h3 title={folderError ? `目录更新失败，将自动重试：${folderError}` : undefined}>文件夹</h3>
        <button className="text-button knowledge-folder-close" onClick={closeDirectory} aria-label="关闭目录">收起</button></div>
        <div className="knowledge-folder-list">
        <button className={!folder ? "active" : ""} onClick={() => { setFolder(""); setFoldersOpen(false); setPageNumber(1); setMobilePane("results"); }}>全部文件</button>
        {directories.map((item) => <button key={`${item.vaultId}:${item.path}`} className={folder === item.path && vaultId === item.vaultId ? "active" : ""}
          title={`${item.vaultId} / ${item.path || "根目录"}`} aria-label={`${item.vaultId} / ${item.path || "根目录"}`}
          style={{ paddingLeft: 8 + (item.path ? Math.min(4, item.path.split("/").length) * 12 : 0) }}
          onClick={() => { selectVault(item.vaultId); setFolder(item.path); setFoldersOpen(false); setMobilePane("results"); }}>
          <span className="knowledge-folder-name">{item.path.split("/").filter(Boolean).at(-1) || item.vaultId}</span><small title="包含子目录的文档数；不含图片">{item.count}</small></button>)}</div></aside>
      <PaneResizeHandle className="knowledge-folder-resize" label="调整目录宽度" controls="knowledge-folders" value={panes.layout.folderWidth}
        min={panes.layout.minFolder} max={panes.layout.maxFolder} onChange={(folders) => panes.update({ folders })} onReset={() => panes.update({ folders: undefined })} />
      <section id="knowledge-results" className="knowledge-results"><div className="knowledge-results-top">
        <button className="knowledge-folder-toggle" type="button" onClick={toggleDirectory}
          aria-expanded={directoryVisible} aria-label={directoryVisible ? "隐藏目录" : "显示目录"}>目录</button>
        <strong title={folder || "全部内容"}>{folder ? folder.split("/").at(-1) : "全部内容"}</strong><span title={browseError ? `列表更新失败，将自动重试：${browseError}` : undefined}>{page?.total ?? 0} 项</span>
        <button type="button" className="text-button knowledge-list-close" title="收起列表" aria-label="收起资料列表" disabled={!detail} onClick={toggleList}>‹</button></div>
        <div className="knowledge-filter-row">
        <WorkbenchSelect label="内容类型" value={kind} onChange={(value) => { setKind(value); setPageNumber(1); }}
          options={[{ value: "", label: "全部类型" }, { value: "source", label: "来源快照" }, { value: "note", label: "库内文档" }]} />
        <WorkbenchSelect label="排序" value={sort} onChange={(value) => { setSort(value); setPageNumber(1); }}
          options={[{ value: "recent", label: "最近入库" }, { value: "modified", label: "最近修改" }, { value: "title", label: "标题" }]} /></div>
        <details className="knowledge-extra-filters"><summary>更多筛选{analysisStatus || modifiedDays ? " · 已启用" : ""}</summary>
          <div><WorkbenchSelect label="分析状态" value={analysisStatus} onChange={(value) => { setAnalysisStatus(value); setPageNumber(1); }}
            options={[{ value: "", label: "全部分析文件" }, { value: "none", label: "无分析文件" }, { value: "analyzed", label: "有分析文件" }]} />
          <WorkbenchSelect label="修改时间" value={modifiedDays} onChange={(value) => { setModifiedDays(value); setPageNumber(1); }}
            options={[{ value: "", label: "不限修改时间" }, { value: "7", label: "最近 7 天" }, { value: "30", label: "最近 30 天" }]} />
          </div></details>{q && <div className="knowledge-list-meta">{page?.total ?? 0} 项 · 搜索“{q}”</div>}
        <div className="knowledge-item-list">{page?.items.length ? page.items.map((item) => <button key={`${item.vaultId}:${item.path}`}
          className={`knowledge-item ${detail?.path === item.path && detail.vaultId === item.vaultId ? "active" : ""}`} onClick={() => void openItem(item)}>
          <span className={`knowledge-kind ${item.kind}`}>{itemLabel(item)}</span><strong>{item.title}</strong>
          <small title={`${item.vaultId} / ${item.path}`}>{itemLocation(item)}</small>{item.kind === "note" && item.snippet && <p>{item.snippet}</p>}
          <time>{date(item.importedAt ?? item.modifiedAt)}</time>
          {item.analysisStatus && <span className="tag">有分析文件</span>}</button>) :
            <p className="source-empty">{browseError && !page ? `内容读取失败，将自动重试：${browseError}` : page ? "没有匹配内容。可尝试清除筛选或重新索引。" : "内容读取中…"}</p>}</div>
        {page && <div className="source-pagination"><span>第 {pageNumber} / {Math.max(1, Math.ceil(page.total / page.pageSize))} 页</span><div>
          <button className="text-button" disabled={pageNumber <= 1} onClick={() => setPageNumber((value) => value - 1)}>上一页</button>
          <button className="text-button" disabled={pageNumber * page.pageSize >= page.total} onClick={() => setPageNumber((value) => value + 1)}>下一页</button></div></div>}</section>
      <PaneResizeHandle className="knowledge-list-resize" label="调整列表宽度" controls="knowledge-results" value={panes.layout.listWidth}
        min={panes.layout.minList} max={panes.layout.maxList} onChange={(list) => panes.update({ list })} onReset={() => panes.update({ list: undefined })} />
      <section className="knowledge-detail" aria-label="内容详情" ref={detailRef}>
        <div className="knowledge-reader-toolbar"><div className="knowledge-pane-toggles">
          <button type="button" aria-label={directoryVisible ? "收起目录" : "显示目录"} aria-expanded={directoryVisible} className="text-button" onClick={toggleDirectory}>目录</button>
          <button type="button" aria-label={listVisible ? "收起列表" : "显示列表"} aria-expanded={listVisible} className="text-button" onClick={toggleList}>列表</button></div>
          <span title={detail ? `${detail.vaultId} / ${detail.path}` : undefined}>{detail ? `${detail.vaultId} / ${detail.path}` : "选择内容开始阅读"}</span>
          {detail && <>
          {detail.format !== "pdf" && !detail.previewLimited && <button type="button" className="text-button" aria-pressed={readerView === "markdown"} onClick={() => setReaderView((view) => view === "reading" ? "markdown" : "reading")}>
            {readerView === "reading" ? "查看 Markdown" : "阅读正文"}</button>}
          <button type="button" className="text-button knowledge-focus-toggle" aria-pressed={readingFocus} onClick={() => setReadingFocus((focused) => !focused)}>
            {readingFocus ? "退出专注" : "专注阅读"}</button></>}
        </div>{detail ? <>
        <div className="knowledge-detail-header"><h2>{detail.title}</h2>
          <div className="knowledge-document-byline"><span className={`knowledge-kind ${detail.kind}`}>{itemLabel(detail)}</span>
            <small>{detail.author || detail.vaultId} · {date(detail.importedAt ?? detail.modifiedAt)}</small></div></div>
        <div className="knowledge-detail-actions">
          {detail.originalUrl && /^https?:\/\//i.test(detail.originalUrl) && <a className="text-button" href={detail.originalUrl} target="_blank" rel="noopener noreferrer">查看原始网页</a>}
          {detail.kind === "note" && <a className="text-button" href={`obsidian://open?path=${encodeURIComponent(detail.absolutePath)}`}>在 Obsidian 打开</a>}</div>
        <details className="knowledge-context"><summary>资料信息与关联 <span>出链 {detail.outlinks.length} · 反向链接 {detail.backlinks.length}{analysis ? " · 有智能摘要" : ""}</span></summary>
        <div className="knowledge-context-body"><button className="text-button" onClick={() => void navigator.clipboard.writeText(detail.absolutePath)}>复制本机路径</button>
        <dl className="knowledge-meta"><dt>本机路径</dt><dd>{detail.absolutePath}</dd><dt>{detail.kind === "source" ? "入库时间" : "修改时间"}</dt><dd>{date(detail.importedAt ?? detail.modifiedAt)}</dd>
          {detail.originalUrl && <><dt>原始来源</dt><dd>{/^https?:\/\//i.test(detail.originalUrl) ?
            <a href={detail.originalUrl} target="_blank" rel="noopener noreferrer">{detail.originalUrl}</a> : detail.originalUrl}</dd></>}
          {detail.kind === "source" && <><dt>归属</dt><dd>{detail.authorship === "third_party" ? "第三方来源" : detail.authorship === "self" ? "本人内容" : "未知"}{detail.author ? ` · ${detail.author}` : ""}</dd></>}
          {detail.fingerprint && <><dt>内容指纹</dt><dd><code>{detail.fingerprint}</code></dd></>}</dl>
        {analysis && <div className="analysis-card"><strong>来源分析文件</strong><p>{analysis.summary}</p>
          <ul>{analysis.mainPoints.map((point, index) => <li key={index}>{point.claim}</li>)}</ul></div>}
        <div className="knowledge-link-groups"><div><strong>出链 {detail.outlinks.length}</strong>{detail.outlinks.map((link) => <button key={`${link.to}:${link.line}`}
          className="text-button" onClick={() => void openItem({ vaultId: detail.vaultId, path: link.to } as KnowledgeItem)}>{link.to} · L{link.line}</button>)}</div>
          <div><strong>反向链接 {detail.backlinks.length}</strong>{detail.backlinks.map((link) => <button key={`${link.from}:${link.line}`} className="text-button"
            onClick={() => void openItem({ vaultId: detail.vaultId, path: link.from } as KnowledgeItem)}>{link.from} · L{link.line}</button>)}</div></div>
        {!!detail.issues.length && <p className="knowledge-issues">未解析链接：{detail.issues.map((issue) => `${issue.target}（${issue.reason === "ambiguous" ? "目标有歧义" : "目标不存在"}）`).join("、")}</p>}
        </div></details>
        {readerView === "markdown" ? <pre className="knowledge-document-source">{detail.markdown}</pre> :
          <KnowledgeMarkdown key={`${detail.vaultId}:${detail.path}`} item={detail} onNavigate={(path, fragment) => void openItem({ vaultId: detail.vaultId, path }, fragment)} onAnchor={scrollToAnchor} />}
      </> : <div className="knowledge-detail-empty">选择来源或笔记，查看原文、智能摘要和可验证链接。</div>}</section>
    </div>}
    {tab === "graph" && <section className="panel-card knowledge-graph-panel">
      {graph ? <KnowledgeGraph graph={graph} title={`${graphVaultId} 关系图谱`}
        tools={<>
          <WorkbenchSelect label="图谱节点类型" value={graphKind} onChange={setGraphKind}
            options={[{ value: "", label: "全部节点" }, { value: "source", label: "来源" }, { value: "note", label: "笔记" }]} />
          <form className="knowledge-graph-search" onSubmit={(event) => { event.preventDefault(); setGraphQuery(graphSearchInput.trim()); setGraphFocus(""); }}>
            <input aria-label="定位图谱节点" placeholder="输入标题或路径定位节点" value={graphSearchInput} onChange={(event) => setGraphSearchInput(event.target.value)} />
            <button className="secondary-button" type="submit">定位</button>
            <button className="text-button" type="button" onClick={() => { setGraphSearchInput(""); setGraphQuery(""); setGraphFocus(""); }}>清除</button></form>
        </>}
        onNode={(item) => void openItem(item)} onFocus={setGraphFocus} onResetFocus={() => setGraphFocus("")} /> :
        <div className="knowledge-graph-placeholder" role={graphError ? "alert" : "status"}>
          <strong>{graphVaultId} 关系图谱</strong><span>{graphError ?? "关系图谱加载中…"}</span>
        </div>}
    </section>}
  </div>;
}
