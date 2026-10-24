import { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, type KnowledgeDetail, type KnowledgeGraph as GraphData, type KnowledgeItem,
  type KnowledgeOverview, type KnowledgePage, type SourceAnalysis, type VaultList } from "../api";
import { KnowledgeGraph } from "./KnowledgeGraph";
import { readingMarkdown } from "./readingMarkdown";

interface Props { vaults: VaultList | null; onSettings: () => void }
type Tab = "overview" | "browse" | "graph";
type Folder = { vaultId: string; path: string; count: number };

function date(value: string | null) { return value ? new Date(value).toLocaleString("zh-CN") : "—"; }
function itemLabel(item: KnowledgeItem) { return item.kind === "source" ? "来源快照" : "普通笔记"; }
function itemLocation(item: KnowledgeItem) {
  if (item.kind === "source" && item.originalUrl) {
    try { return new URL(item.originalUrl).hostname.replace(/^www\./, ""); } catch { /* Show the vault path below. */ }
  }
  return `${item.vaultId} / ${item.path}`;
}

export function VaultScreen({ vaults, onSettings }: Props) {
  const [vaultId, setVaultId] = useState("all");
  const [tab, setTab] = useState<Tab>("overview");
  const [overview, setOverview] = useState<KnowledgeOverview | null>(null);
  const [page, setPage] = useState<KnowledgePage | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [graph, setGraph] = useState<GraphData | null>(null);
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
  const [mobilePane, setMobilePane] = useState<"folders" | "results" | "detail">("results");
  const [foldersOpen, setFoldersOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const detailRef = useRef<HTMLElement>(null);
  const graphVaultId = vaultId === "all" ? vaults?.defaultVaultId ?? "default" : vaultId;

  useEffect(() => {
    const timer = window.setInterval(() => setRefreshKey((value) => value + 1), 10_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const params = vaultId === "all" ? "" : `?vaultId=${encodeURIComponent(vaultId)}`;
    void api<KnowledgeOverview>(`/knowledge/overview${params}`).then((result) => { if (!cancelled) setOverview(result); })
      .catch((error) => { if (!cancelled) setMessage(error instanceof Error ? error.message : "知识库读取失败"); });
    return () => { cancelled = true; };
  }, [vaultId, vaults, refreshKey]);

  useEffect(() => {
    if (tab !== "browse") return;
    let cancelled = false;
    setPage(null);
    const params = new URLSearchParams({ page: String(pageNumber), pageSize: "30", sort });
    if (vaultId !== "all") params.set("vaultId", vaultId);
    if (q) params.set("q", q);
    if (kind) params.set("kind", kind);
    if (folder) params.set("folder", folder);
    if (analysisStatus) params.set("analysisStatus", analysisStatus);
    if (modifiedDays) params.set("modifiedSince", new Date(Date.now() - Number(modifiedDays) * 86_400_000).toISOString());
    void api<KnowledgePage>(`/knowledge/items?${params}`).then((result) => { if (!cancelled) setPage(result); })
      .catch((error) => { if (!cancelled) setMessage(error instanceof Error ? error.message : "内容列表读取失败"); });
    const folderParams = vaultId === "all" ? "" : `?vaultId=${encodeURIComponent(vaultId)}`;
    void api<{ items: Folder[] }>(`/knowledge/folders${folderParams}`).then((result) => { if (!cancelled) setFolders(result.items); });
    return () => { cancelled = true; };
  }, [tab, vaultId, pageNumber, sort, q, kind, folder, analysisStatus, modifiedDays, refreshKey]);

  useEffect(() => {
    if (tab !== "graph") return;
    let cancelled = false;
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (graphKind) params.set("kind", graphKind);
    if (graphFocus) params.set("focus", graphFocus);
    void api<GraphData>(`/knowledge/graph/${encodeURIComponent(graphVaultId)}?${params}`).then((result) => { if (!cancelled) setGraph(result); })
      .catch((error) => { if (!cancelled) setMessage(error instanceof Error ? error.message : "图谱读取失败"); });
    return () => { cancelled = true; };
  }, [tab, graphVaultId, q, graphKind, graphFocus, refreshKey]);

  async function openItem(item: KnowledgeItem) {
    setTab("browse"); setMobilePane("detail"); setFoldersOpen(false); setDetail(null); setAnalysis(null); setMessage("");
    detailRef.current?.scrollTo({ top: 0 });
    try {
      const result = await api<KnowledgeDetail>(`/knowledge/items/${encodeURIComponent(item.vaultId)}?path=${encodeURIComponent(item.path)}`);
      setDetail(result);
      if (result.kind === "source" && result.analysisStatus) {
        const params = new URLSearchParams({ vaultId: item.vaultId, snapshot: item.path });
        void api<SourceAnalysis>(`/sources/analysis?${params}`).then(setAnalysis).catch(() => undefined);
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : "文件读取失败"); }
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
    setVaultId(id); setFolder(""); setPageNumber(1); setDetail(null); setGraphFocus(""); setFoldersOpen(false);
  }

  const selectedSummary = overview?.vaults.find((vault) => vault.id === vaultId);
  const directories = useMemo(() => folders.filter((item) => vaultId === "all" || item.vaultId === vaultId), [folders, vaultId]);
  const overviewEntry = (item: KnowledgeItem) => <button key={`${item.vaultId}:${item.path}`} className="knowledge-recent-item" onClick={() => void openItem(item)}>
    <span className={`knowledge-kind ${item.kind}`}>{itemLabel(item)}</span><strong>{item.title}</strong><small>{item.vaultId} / {item.path}</small>
  </button>;

  return <div className="knowledge-workspace">
    <div className="knowledge-toolbar">
      <label className="knowledge-vault-select"><span className="sr-only">知识库</span><select aria-label="选择知识库" value={vaultId} onChange={(event) => selectVault(event.target.value)}>
        <option value="all">全部知识库</option>{vaults?.vaults.map((vault) => <option key={vault.id} value={vault.id}>{vault.id}{vault.isDefault ? " · 默认" : ""}</option>)}
      </select></label>
      <form className="knowledge-search" onSubmit={(event) => { event.preventDefault(); setQ(searchInput.trim()); setPageNumber(1); setMobilePane("results"); setTab("browse"); }}>
        <input aria-label="搜索知识库" placeholder="搜索标题、路径与正文" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} />
        <button className="secondary-button" type="submit">搜索</button></form>
      <button className="text-button" onClick={() => void rescan()}>重新索引</button>
      <button className="text-button" onClick={onSettings}>知识库连接设置</button>
    </div>
    <div className="knowledge-tabs" role="tablist" aria-label="知识库视图">
      {(["overview", "browse", "graph"] as const).map((value) => <button key={value} role="tab" aria-selected={tab === value}
        className={tab === value ? "active" : ""} onClick={() => setTab(value)}>{value === "overview" ? "概览" : value === "browse" ? "浏览" : "图谱"}</button>)}
    </div>
    {message && <p className="inline-message" role="status">{message}</p>}
    {tab === "overview" && <div className="knowledge-overview">
      <section className="panel-card">
        <div className="section-heading"><div><span className="overline">LIBRARY STATUS</span><h2>{vaultId === "all" ? "全部知识库" : `${vaultId} 概览`}</h2></div></div>
        <div className="knowledge-stats">{(vaultId === "all" ? overview?.vaults : selectedSummary ? [selectedSummary] : [])?.map((vault) =>
          <article key={vault.id}><strong>{vault.id}</strong><span>{vault.kind === "built-in" ? "内置库" : "外部 Obsidian 库"} · {vault.path}</span>
            <span>{vault.sources} 篇来源 · {vault.notes} 篇笔记 · 库内分析文件 {vault.confirmedAnalyses}</span>
            <small>上次索引：{date(vault.indexedAt)}</small>{vault.errors.length > 0 && <small className="inline-message error">读取异常：{vault.errors.join("；")}</small>}</article>)}</div>
      </section>
      <section className="panel-card"><div className="section-heading"><div><span className="overline">RECENT SOURCES</span><h2>刚入库来源</h2></div></div>
        <div className="knowledge-recent-list">{overview?.recentSources.length ? overview.recentSources.map(overviewEntry) : <p className="muted">还没有已保存的来源快照。</p>}</div></section>
      <section className="panel-card"><div className="section-heading"><div><span className="overline">RECENT NOTES</span><h2>最近修改笔记</h2></div></div>
        <div className="knowledge-recent-list">{overview?.recentNotes.length ? overview.recentNotes.map(overviewEntry) : <p className="muted">还没有知识笔记。已保存来源仍可在“浏览”中查看。</p>}</div></section>
      {selectedSummary && <section className="panel-card"><div className="section-heading"><div><span className="overline">CURATED INDEX</span><h2>人工索引导读</h2></div></div>
        {selectedSummary.indexMarkdown ? <div className="markdown-body"><Markdown remarkPlugins={[remarkGfm]} skipHtml>{selectedSummary.indexMarkdown}</Markdown></div> :
          <p className="muted">该知识库尚未配置人工索引文件；文件和来源已经自动索引。</p>}</section>}
    </div>}
    {tab === "browse" && <div className={`knowledge-browser panel-card pane-${mobilePane}${foldersOpen ? " folder-open" : ""}`}>
      <div className="knowledge-mobile-nav"><button className={mobilePane === "folders" ? "active" : ""} onClick={() => setMobilePane("folders")}>目录</button>
        <button className={mobilePane === "results" ? "active" : ""} onClick={() => setMobilePane("results")}>列表</button>
        <button className={mobilePane === "detail" ? "active" : ""} disabled={!detail} onClick={() => setMobilePane("detail")}>详情</button></div>
      <aside className="knowledge-folders" aria-label="知识库目录"><div className="knowledge-folders-heading"><h3>文件夹</h3>
        <button className="text-button knowledge-folder-close" onClick={() => setFoldersOpen(false)} aria-label="关闭目录">收起</button></div>
        <div className="knowledge-folder-list">
        <button className={!folder ? "active" : ""} onClick={() => { setFolder(""); setFoldersOpen(false); setPageNumber(1); setMobilePane("results"); }}>全部文件</button>
        {directories.map((item) => <button key={`${item.vaultId}:${item.path}`} className={folder === item.path && vaultId === item.vaultId ? "active" : ""}
          title={`${item.vaultId} / ${item.path || "根目录"}`} aria-label={`${item.vaultId} / ${item.path || "根目录"}`}
          style={{ paddingLeft: 8 + Math.min(4, item.path.split("/").length) * 8 }}
          onClick={() => { selectVault(item.vaultId); setFolder(item.path); setFoldersOpen(false); setMobilePane("results"); }}>{item.path.split("/").filter(Boolean).at(-1) || item.vaultId} <small>{item.count}</small></button>)}</div></aside>
      <section className="knowledge-results"><div className="knowledge-results-top">
        <button className="knowledge-folder-toggle" type="button" onClick={() => setFoldersOpen((open) => !open)}
          aria-expanded={foldersOpen} aria-label={foldersOpen ? "隐藏目录" : "显示目录"}>目录</button>
        <strong title={folder || "全部内容"}>{folder || "全部内容"}</strong><span>{page?.total ?? 0} 项</span></div>
        <div className="knowledge-filter-row">
        <select aria-label="内容类型" value={kind} onChange={(event) => { setKind(event.target.value); setPageNumber(1); }}>
          <option value="">全部类型</option><option value="source">来源快照</option><option value="note">知识笔记</option></select>
        <select aria-label="排序" value={sort} onChange={(event) => { setSort(event.target.value); setPageNumber(1); }}>
          <option value="recent">最近入库</option><option value="modified">最近修改</option><option value="title">标题</option></select></div>
        <details className="knowledge-extra-filters"><summary>更多筛选{analysisStatus || modifiedDays ? " · 已启用" : ""}</summary>
          <div><select aria-label="分析状态" value={analysisStatus} onChange={(event) => { setAnalysisStatus(event.target.value); setPageNumber(1); }}>
            <option value="">全部分析文件</option><option value="none">无分析文件</option><option value="analyzed">有分析文件</option></select>
          <select aria-label="修改时间" value={modifiedDays} onChange={(event) => { setModifiedDays(event.target.value); setPageNumber(1); }}>
          <option value="">不限修改时间</option><option value="7">最近 7 天</option><option value="30">最近 30 天</option></select>
          </div></details>{q && <div className="knowledge-list-meta">{page?.total ?? 0} 项 · 搜索“{q}”</div>}
        <div className="knowledge-item-list">{page?.items.length ? page.items.map((item) => <button key={`${item.vaultId}:${item.path}`}
          className={`knowledge-item ${detail?.path === item.path && detail.vaultId === item.vaultId ? "active" : ""}`} onClick={() => void openItem(item)}>
          <span className={`knowledge-kind ${item.kind}`}>{itemLabel(item)}</span><strong>{item.title}</strong>
          <small title={`${item.vaultId} / ${item.path}`}>{itemLocation(item)}</small>{item.kind === "note" && item.snippet && <p>{item.snippet}</p>}
          <time>{date(item.importedAt ?? item.modifiedAt)}</time>
          {item.analysisStatus && <span className="tag">有分析文件</span>}</button>) :
            <p className="source-empty">{page ? "没有匹配内容。可尝试清除筛选或重新索引。" : "内容读取中…"}</p>}</div>
        {page && <div className="source-pagination"><span>第 {pageNumber} / {Math.max(1, Math.ceil(page.total / page.pageSize))} 页</span><div>
          <button className="text-button" disabled={pageNumber <= 1} onClick={() => setPageNumber((value) => value - 1)}>上一页</button>
          <button className="text-button" disabled={pageNumber * page.pageSize >= page.total} onClick={() => setPageNumber((value) => value + 1)}>下一页</button></div></div>}</section>
      <section className="knowledge-detail" aria-label="内容详情" ref={detailRef}>{detail ? <>
        <div className="knowledge-detail-header"><span className={`knowledge-kind ${detail.kind}`}>{itemLabel(detail)}</span><h2>{detail.title}</h2>
          <small>{detail.author || detail.vaultId} · {date(detail.importedAt ?? detail.modifiedAt)}</small></div>
        <div className="knowledge-detail-actions">
          {detail.originalUrl && /^https?:\/\//i.test(detail.originalUrl) && <a className="text-button" href={detail.originalUrl} target="_blank" rel="noopener noreferrer">查看原始网页</a>}
          {detail.kind === "note" && <a className="text-button" href={`obsidian://open?path=${encodeURIComponent(detail.absolutePath)}`}>在 Obsidian 打开</a>}</div>
        <details className="knowledge-context"><summary>资料信息与关联 <span>出链 {detail.outlinks.length} · 反向链接 {detail.backlinks.length}{analysis ? " · 有分析卡" : ""}</span></summary>
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
        {detail.kind === "source" && <details className="knowledge-raw"><summary>查看原始 Markdown</summary><pre>{detail.markdown}</pre></details>}
        </div></details>
        <div className="markdown-body knowledge-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml
          components={{ img: ({ alt }) => <span>[图片：{alt || "无描述"}]</span>, a: ({ href, children }) => href?.startsWith("https://") || href?.startsWith("http://") ?
            <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span> }}>{readingMarkdown(detail)}</Markdown></div>
      </> : <div className="knowledge-detail-empty">选择来源或笔记，查看原文、分析卡和可验证链接。</div>}</section>
    </div>}
    {tab === "graph" && <section className="panel-card knowledge-graph-panel">
      <div className="section-heading"><div><span className="overline">VERIFIED LINKS</span><h2>{graphVaultId} 关系图谱</h2></div>
        <select aria-label="图谱节点类型" value={graphKind} onChange={(event) => setGraphKind(event.target.value)}><option value="">全部节点</option><option value="source">来源</option><option value="note">笔记</option></select></div>
      <p className="muted">只展示 Markdown 链接与来源引用。点击节点查看详情；没有连线的来源仍保留。</p>
      <form className="knowledge-graph-search" onSubmit={(event) => { event.preventDefault(); setQ(graphSearchInput.trim()); setGraphFocus(""); }}>
        <input aria-label="定位图谱节点" placeholder="输入标题或路径定位节点" value={graphSearchInput} onChange={(event) => setGraphSearchInput(event.target.value)} />
        <button className="secondary-button" type="submit">定位</button>
        <button className="text-button" type="button" onClick={() => { setGraphSearchInput(""); setQ(""); setGraphFocus(""); }}>清除</button></form>
      {graph && <KnowledgeGraph graph={graph} onNode={(item) => void openItem(item)} onFocus={setGraphFocus} onResetFocus={() => setGraphFocus("")} />}
    </section>}
  </div>;
}
