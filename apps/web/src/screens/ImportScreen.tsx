import { useEffect, useRef, useState } from "react";
import { ApiError, api, type ImportBatch, type ImportItem, type ImportItemsPage, type ImportPolicy,
  type AnalysisJob, type AnalysisJobsPage, type SourceAnalysis, type SourceRef, type VaultList } from "../api";
import { WorkspaceIcon } from "../WorkspaceIcon";
import { WorkbenchSelect } from "../WorkbenchSelect";

interface Props { vaults: VaultList | null; onImported: (source: SourceRef) => void; onCaptureSettings: () => void }
type View = "pending" | "recent" | "all" | "trash";
type Action = "file" | "shelve" | "restore" | "trash" | "purge";
const tabs: { id: View; label: string }[] = [
  { id: "pending", label: "待整理" }, { id: "recent", label: "最近处理" },
  { id: "all", label: "全部资料" }, { id: "trash", label: "回收站" },
];
const itemKey = (item: Pick<ImportItem, "batchId" | "captureId">) => `${item.batchId}\u0000${item.captureId}`;
const activeJob = (job: AnalysisJob) => job.status === "queued" || job.status === "running";
function storedView(): View {
  try {
    const value = sessionStorage.getItem("ocf-source-view");
    return tabs.some((tab) => tab.id === value) ? value as View : "pending";
  } catch { return "pending"; }
}
function storedExpanded(): string | null {
  try { return sessionStorage.getItem("ocf-source-expanded"); } catch { return null; }
}
function storedFilters() {
  const empty = { page: 1, searchInput: "", search: "", statusFilter: "", analysisFilter: "", vaultFilter: "" };
  try {
    const value = JSON.parse(sessionStorage.getItem("ocf-source-filters") ?? "null") as Partial<typeof empty> | null;
    if (!value || typeof value !== "object") return empty;
    return { page: Number.isInteger(value.page) && value.page! > 0 ? value.page! : 1,
      searchInput: typeof value.searchInput === "string" ? value.searchInput : "",
      search: typeof value.search === "string" ? value.search : "",
      statusFilter: typeof value.statusFilter === "string" ? value.statusFilter : "",
      analysisFilter: value.analysisFilter === "proposed" || value.analysisFilter === "confirmed" ? "analyzed" :
        value.analysisFilter === "none" || value.analysisFilter === "analyzed" ? value.analysisFilter : "",
      vaultFilter: typeof value.vaultFilter === "string" ? value.vaultFilter : "" };
  } catch { return empty; }
}
const date = (value?: string | null) => value ? new Date(value).toLocaleString("zh-CN") : "—";
function sourceDomain(url: string) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "来源网站"; }
}
function itemStatus(item: ImportItem) {
  if (item.disposition === "trashed") return "回收站";
  if (item.disposition === "shelved") return "已搁置";
  if (item.status === "processing") return "入库中";
  if (item.status === "ready" && item.autoVaultId) return "排队入库";
  return { ready: "待整理", incomplete: "内容不完整", failed: "入库失败", imported: "已入库" }[item.status];
}

export function ImportScreen({ vaults, onImported, onCaptureSettings }: Props) {
  const [initialFilters] = useState(storedFilters);
  const [targetVaultId, setTargetVaultId] = useState("");
  const [policy, setPolicy] = useState<ImportPolicy | null>(null);
  const [policyMode, setPolicyMode] = useState<ImportPolicy["mode"]>("manual");
  const [policyVaultId, setPolicyVaultId] = useState("");
  const [policyOpen, setPolicyOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [importMessage, setImportMessage] = useState("");
  const [importProgress, setImportProgress] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const dropButton = useRef<HTMLButtonElement>(null);
  const [view, setView] = useState<View>(storedView);
  const [page, setPage] = useState(initialFilters.page);
  const [searchInput, setSearchInput] = useState(initialFilters.searchInput);
  const [search, setSearch] = useState(initialFilters.search);
  const [statusFilter, setStatusFilter] = useState(initialFilters.statusFilter);
  const [analysisFilter, setAnalysisFilter] = useState(initialFilters.analysisFilter);
  const [vaultFilter, setVaultFilter] = useState(initialFilters.vaultFilter);
  const [list, setList] = useState<ImportItemsPage | null>(null);
  const [selected, setSelected] = useState<Record<string, ImportItem>>({});
  const [expanded, setExpanded] = useState<string | null>(storedExpanded);
  const [detailPane, setDetailPane] = useState<"original" | "analysis">("original");
  const [editingVaults, setEditingVaults] = useState<ImportItem | null>(null);
  const [draftVaultIds, setDraftVaultIds] = useState<string[]>([]);
  const [vaultError, setVaultError] = useState("");
  const [cards, setCards] = useState<Record<string, SourceAnalysis>>({});
  const [jobs, setJobs] = useState<AnalysisJob[]>([]);
  const jobsRef = useRef<AnalysisJob[]>([]);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    try { sessionStorage.setItem("ocf-source-filters", JSON.stringify({ page, searchInput, search,
      statusFilter, analysisFilter, vaultFilter })); } catch { /* Optional list state. */ }
  }, [page, searchInput, search, statusFilter, analysisFilter, vaultFilter]);

  useEffect(() => {
    if (!importOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dropButton.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) setImportOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener("keydown", closeOnEscape); };
  }, [importOpen, busy]);

  useEffect(() => {
    if (vaults && !targetVaultId) setTargetVaultId(vaults.defaultVaultId);
    if (vaults && !policyVaultId) setPolicyVaultId(vaults.defaultVaultId);
  }, [vaults, targetVaultId, policyVaultId]);
  useEffect(() => {
    void api<ImportPolicy>("/imports/policy").then((value) => {
      setPolicy(value); setPolicyMode(value.mode); if (value.vaultId) setPolicyVaultId(value.vaultId);
    }).catch((error) => setMessage(error instanceof Error ? error.message : "读取规则失败"));
  }, []);

  function listPath(nextPage: number, nextPageSize: number) {
    const params = new URLSearchParams({ view, page: String(nextPage), pageSize: String(nextPageSize) });
    if (search) params.set("q", search);
    if (statusFilter) params.set("status", statusFilter);
    if (analysisFilter) params.set("analysis", analysisFilter);
    if (vaultFilter) params.set("vaultId", vaultFilter);
    return `/imports/items?${params}`;
  }
  useEffect(() => {
    let cancelled = false;
    void api<ImportItemsPage>(listPath(page, 20)).then((value) => { if (!cancelled) setList(value); })
      .catch((error) => { if (!cancelled) setMessage(error instanceof Error ? error.message : "读取资料失败"); });
    return () => { cancelled = true; };
  }, [view, page, search, statusFilter, analysisFilter, vaultFilter, revision]);
  useEffect(() => {
    if (!list?.counts.autoQueued) return;
    const timer = window.setInterval(() => setRevision((value) => value + 1), 2000);
    return () => window.clearInterval(timer);
  }, [list?.counts.autoQueued]);
  useEffect(() => {
    let cancelled = false;
    void api<AnalysisJobsPage>("/analysis/jobs").then((value) => {
      if (cancelled) return;
      const merged = [...value.jobs, ...jobsRef.current.filter((job) => !value.jobs.some((next) => next.id === job.id))].slice(0, 200);
      jobsRef.current = merged; setJobs(merged);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!jobs.some(activeJob)) return;
    const timer = window.setInterval(() => { void pollJobs(); }, 2_000);
    return () => window.clearInterval(timer);
  }, [jobs]);
  const refresh = () => setRevision((value) => value + 1);
  const rows = list?.items ?? [];
  const chosen = Object.values(selected);
  const fileable = chosen.filter((item) => item.status !== "incomplete" && item.status !== "processing" &&
    item.disposition !== "trashed" && !item.vaults?.some((membership) => membership.vaultId === targetVaultId));
  const shelvable = chosen.filter((item) => item.status !== "imported" && item.status !== "processing" && item.disposition === "active");
  const trashable = chosen.filter((item) => item.status !== "imported" && item.status !== "processing" && item.disposition !== "trashed");
  const pageSelected = rows.length > 0 && rows.every((item) => !!selected[itemKey(item)]);
  function showExpanded(next: string | null) {
    setExpanded(next);
    try {
      if (next) sessionStorage.setItem("ocf-source-expanded", next);
      else sessionStorage.removeItem("ocf-source-expanded");
    } catch { /* The page remains usable without storage. */ }
  }
  function toggleExpanded(item: ImportItem) {
    const id = itemKey(item);
    const open = expanded === id;
    showExpanded(open ? null : id);
    if (!open) { setDetailPane("original"); void loadCard(item); }
  }
  function switchView(next: View) {
    setView(next); setPage(1); setSelected({}); showExpanded(null);
    try { sessionStorage.setItem("ocf-source-view", next); } catch { /* Optional view preference. */ }
  }
  async function pollJobs() {
    try {
      const value = await api<AnalysisJobsPage>("/analysis/jobs");
      const previous = jobsRef.current;
      jobsRef.current = value.jobs; setJobs(value.jobs);
      const completed = previous.filter((job) => activeJob(job) && value.jobs.some((next) => next.id === job.id && next.status === "completed"));
      if (completed.length) setCards((current) => {
        const next = { ...current };
        for (const job of completed) delete next[itemKey(job)];
        return next;
      });
      if (previous.some((job) => activeJob(job) && value.jobs.some((next) => next.id === job.id && !activeJob(next)))) refresh();
    } catch { /* List and saved cards remain available if task status cannot refresh. */ }
  }
  function toggle(item: ImportItem) {
    setSelected((current) => { const copy = { ...current }; const id = itemKey(item);
      if (copy[id]) delete copy[id]; else copy[id] = item; return copy; });
  }
  function togglePage() {
    setSelected((current) => { const copy = { ...current };
      for (const item of rows) { if (pageSelected) delete copy[itemKey(item)]; else copy[itemKey(item)] = item; }
      return copy; });
  }
  async function selectAllResults() {
    if (!list?.total) return;
    setBusy(true); setMessage("");
    try {
      const picked: Record<string, ImportItem> = {};
      for (let next = 1; next <= Math.ceil(list.total / 100); next++) {
        const batch = await api<ImportItemsPage>(listPath(next, 100));
        for (const item of batch.items) picked[itemKey(item)] = item;
      }
      setSelected(picked); setMessage(`已选择 ${Object.keys(picked).length} 篇筛选结果`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "选择失败"); }
    finally { setBusy(false); }
  }
  async function upload(files: File[]) {
    if (!files.length || busy) return;
    setBusy(true); setImportMessage(""); setMessage("");
    let imported = 0;
    let skipped = 0;
    const failed: string[] = [];
    try {
      for (const [index, file] of files.entries()) {
        setImportProgress(`正在导入 ${index + 1}/${files.length}：${file.name}`);
        try {
          const form = new FormData(); form.append("file", file);
          const batch = await api<ImportBatch>("/imports/preflight", { method: "POST", body: form });
          imported += batch.candidates.length;
          skipped += batch.skippedFiles ?? 0;
        } catch (error) { failed.push(`${file.name}：${error instanceof Error ? error.message : "导入失败"}`); }
      }
      if (imported) {
        setSearch(""); setSearchInput(""); setSelected({}); setPage(1); setView("pending"); showExpanded(null);
        try { sessionStorage.setItem("ocf-source-view", "pending"); } catch { /* Optional view preference. */ }
        refresh();
      }
      const summary = `已导入 ${imported} 篇${policy?.mode === "auto-file" && imported ? "，后台正在自动入库" : imported ? "，已加入待整理" : ""}` +
        (skipped ? `；跳过 ${skipped} 个不支持的文件` : "");
      if (failed.length) setImportMessage(`${summary}；${failed.length} 个文件失败：${failed.join("；")}`);
      else { setImportOpen(false); setMessage(summary); }
    } finally { setImportProgress(""); setBusy(false); }
  }
  async function savePolicy() {
    setBusy(true); setMessage("");
    try {
      const saved = await api<ImportPolicy>("/imports/policy", { method: "PUT",
        body: { mode: policyMode, vaultId: policyMode === "auto-file" ? policyVaultId : null } });
      setPolicy(saved); setPolicyOpen(false); setMessage("新资料处理规则已保存");
    } catch (error) { setMessage(error instanceof Error ? error.message : "保存失败"); }
    finally { setBusy(false); }
  }
  async function action(name: Action, items: ImportItem[]) {
    if (!items.length) return;
    if (name === "trash" && !window.confirm(`将 ${items.length} 篇资料移入回收站？`)) return;
    if (name === "purge" && !window.confirm(`永久删除 ${items.length} 篇采集资料和分析卡？此操作不可恢复。`)) return;
    setBusy(true); setMessage("");
    let succeeded = 0; let syncWarnings = 0; const errors: string[] = [];
    try {
      for (let offset = 0; offset < items.length; offset += 100) {
        const part = items.slice(offset, offset + 100);
        const response = await api<{ results: { ok: boolean; error?: string; vaultId?: string; snapshot?: string; analysisSyncError?: boolean }[] }>(
          "/imports/items/actions", { method: "POST", body: { action: name, vaultId: targetVaultId,
            items: part.map((item) => ({ batchId: item.batchId, captureId: item.captureId })) } });
        for (const result of response.results) {
          if (result.ok) { succeeded++;
            if (name === "file" && result.vaultId && result.snapshot) onImported({ vaultId: result.vaultId, snapshot: result.snapshot });
            if (result.analysisSyncError) syncWarnings++;
          } else if (result.error) errors.push(new ApiError(409, result.error).message);
        }
      }
      setSelected({}); refresh();
      setMessage(`已处理 ${succeeded} 篇${syncWarnings ? `；${syncWarnings} 张分析卡未写入知识库，请展开资料检查` : ""}${errors.length ? `；${errors.length} 篇失败：${[...new Set(errors)].join("、")}` : ""}`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "操作失败"); }
    finally { setBusy(false); }
  }
  function openVaultEditor(item: ImportItem) {
    setVaultError("");
    setEditingVaults(item);
    setDraftVaultIds((item.vaults ?? []).map((membership) => membership.vaultId));
  }
  async function saveVaults() {
    if (!editingVaults) return;
    setBusy(true); setMessage("");
    try {
      const result = await api<{ vaults: ImportItem["vaults"]; errors: { vaultId: string; error: string }[] }>(
        `/imports/${editingVaults.batchId}/items/${encodeURIComponent(editingVaults.captureId)}/vaults`,
        { method: "PUT", body: { vaultIds: draftVaultIds } });
      const previous = new Set((editingVaults.vaults ?? []).map((membership) => membership.vaultId));
      let added = 0;
      for (const membership of result.vaults) {
        if (!previous.has(membership.vaultId)) {
          added++;
          onImported({ vaultId: membership.vaultId, snapshot: membership.snapshot });
        }
      }
      refresh();
      if (result.errors.length) {
        setVaultError(`部分知识库写入失败：${result.errors.map((error) => `${error.vaultId}（${new ApiError(409, error.error).message}）`).join("、")}`);
      } else {
        setEditingVaults(null);
        setMessage(`已新增 ${added} 个知识库关联`);
      }
    } catch (error) { setVaultError(error instanceof Error ? error.message : "添加知识库失败"); }
    finally { setBusy(false); }
  }
  async function loadCard(item: ImportItem) {
    const id = itemKey(item); if (cards[id]) return;
    try {
      const card = await api<SourceAnalysis>(`/imports/${item.batchId}/items/${encodeURIComponent(item.captureId)}/analysis`);
      setCards((current) => ({ ...current, [id]: card }));
    } catch {
      if (!item.vaultId || !item.snapshot) return;
      try {
        const params = new URLSearchParams({ vaultId: item.vaultId, snapshot: item.snapshot });
        const card = await api<SourceAnalysis>(`/sources/analysis?${params}`);
        setCards((current) => ({ ...current, [id]: card }));
      } catch { /* Card is optional. */ }
    }
  }
  useEffect(() => {
    if (!expanded || cards[expanded]) return;
    const item = rows.find((row) => itemKey(row) === expanded);
    if (item?.analysisStatus) void loadCard(item);
  }, [expanded, list?.items, cards]);
  async function queueAnalysis(items: ImportItem[]) {
    if (!items.length || busy) return;
    setBusy(true); setMessage("");
    const accepted: AnalysisJob[] = [];
    try {
      for (let offset = 0; offset < items.length; offset += 100) {
        const part = items.slice(offset, offset + 100);
        const result = await api<AnalysisJobsPage>("/analysis/jobs", { method: "POST",
          body: { items: part.map(({ batchId, captureId }) => ({ batchId, captureId })) } });
        accepted.push(...result.jobs);
      }
      const merged = [...accepted, ...jobsRef.current.filter((job) => !accepted.some((next) => next.id === job.id))].slice(0, 200);
      jobsRef.current = merged; setJobs(merged);
      setSelected({});
      setMessage(`已提交 ${accepted.length} 篇分析任务，可继续处理其他资料`);
    } catch (error) {
      if (accepted.length) {
        const merged = [...accepted, ...jobsRef.current.filter((job) => !accepted.some((next) => next.id === job.id))].slice(0, 200);
        jobsRef.current = merged; setJobs(merged);
      }
      setMessage(`${accepted.length ? `已提交 ${accepted.length} 篇；` : ""}${error instanceof Error ? error.message : "提交分析任务失败"}`);
    }
    finally { setBusy(false); }
  }
  const latestJobs = [...new Map(jobs.slice().reverse().map((job) => [itemKey(job), job])).values()];
  const activeCount = latestJobs.filter(activeJob).length;
  const recentCompleted = latestJobs.filter((job) => job.status === "completed" &&
    Date.now() - new Date(job.updatedAt).getTime() < 24 * 60 * 60 * 1000).length;
  const failedCount = latestJobs.filter((job) => job.status === "failed").length;

  return <div className="screen-stack source-workbench">
    <section className="panel-card intake-toolbar">
      <div className="source-toolbar-main"><p className="source-explainer">导入资料、检查来源，形成可回查的分析。</p>
        <div className="intake-actions"><button className="text-button source-policy-trigger" type="button" aria-expanded={policyOpen}
          aria-controls="source-policy-editor" onClick={() => setPolicyOpen((open) => !open)}>入库规则 <span>· {policy?.mode === "auto-file" ? `自动入库至 ${policy.vaultId}` : "先放待整理"}</span></button>
          <button className="text-button capture-settings-link" type="button" onClick={onCaptureSettings}>采集设置</button>
          <button className="primary-button" onClick={() => { setImportMessage(""); setImportOpen(true); }} aria-haspopup="dialog">导入资料</button></div></div>
      {policyOpen && <div id="source-policy-editor" className="intake-drawer policy-editor"><label>采集后如何处理<select value={policyMode}
        onChange={(event) => setPolicyMode(event.target.value as ImportPolicy["mode"])}><option value="manual">先放待整理</option><option value="auto-file">自动直接入库</option></select></label>
        {policyMode === "auto-file" && <label>自动入库目标<select value={policyVaultId} onChange={(event) => setPolicyVaultId(event.target.value)}>
          {vaults?.vaults.map((vault) => <option key={vault.id} value={vault.id}>{vault.id}</option>)}</select></label>}
        <button className="primary-button" disabled={busy || (policyMode === "auto-file" && !policyVaultId)} onClick={() => void savePolicy()}>保存规则</button>
        <small>分析卡按需生成；内容不完整或写入失败的资料仍留在待整理。</small></div>}
      {message && <p className="inline-message" role="status">{message}</p>}
    </section>
    {importOpen && <div className="modal-backdrop import-modal-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) setImportOpen(false);
    }}>
      <section className="import-modal" role="dialog" aria-modal="true" aria-labelledby="import-dialog-title">
        <div className="import-modal-head"><div><h2 id="import-dialog-title">导入资料</h2><p>选择文件或拖到下方，导入后统一进入资料列表。</p></div>
          <button className="import-modal-close" type="button" disabled={busy} aria-label="关闭导入弹窗" onClick={() => setImportOpen(false)}>×</button></div>
        <input ref={fileInput} className="sr-only" type="file" aria-label="选择文件" multiple
          accept=".md,.markdown,.mdown,.txt,.text,.html,.htm,.zip,text/plain,text/html,application/zip"
          onChange={(event) => { void upload(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ""; }} />
        <button ref={dropButton} className={`import-dropzone${dropActive ? " active" : ""}`} type="button" disabled={busy}
          onClick={() => fileInput.current?.click()}
          onDragEnter={(event) => { event.preventDefault(); setDropActive(true); }}
          onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setDropActive(true); }}
          onDragLeave={(event) => { event.preventDefault(); setDropActive(false); }}
          onDrop={(event) => { event.preventDefault(); setDropActive(false); void upload(Array.from(event.dataTransfer.files)); }}>
          <span className="import-dropzone-icon"><WorkspaceIcon name="publish" size={28} /></span>
          <strong>拖拽文件到这里</strong><span>或点击选择文件，可一次选择多个</span>
        </button>
        <p className="import-modal-formats">支持 Markdown、HTML、TXT、ZIP。普通 ZIP 会识别其中的多篇文本；Clipper ZIP 继续按原格式导入。</p>
        {importProgress && <p className="import-modal-progress" role="status">{importProgress}</p>}
        {importMessage && <p className="inline-message error import-modal-error" role="alert">{importMessage}</p>}
      </section>
    </div>}

    {editingVaults && <div className="modal-backdrop import-modal-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) setEditingVaults(null);
    }}><section className="import-modal source-vault-modal" role="dialog" aria-modal="true" aria-labelledby="source-vault-title">
      <div className="import-modal-head"><div><h2 id="source-vault-title">添加到知识库</h2>
        <p className="source-vault-subtitle">{editingVaults.title}</p></div>
        <button className="import-modal-close" type="button" disabled={busy} aria-label="关闭知识库选择" onClick={() => setEditingVaults(null)}>×</button></div>
      <div className="source-vault-options" role="group" aria-label="选择要加入的知识库">{vaults?.vaults.map((vault) =>
        <label key={vault.id}><input type="checkbox" checked={draftVaultIds.includes(vault.id)}
          disabled={busy || !!editingVaults.vaults?.some((entry) => entry.vaultId === vault.id) || editingVaults.status === "incomplete"}
          onChange={(event) => setDraftVaultIds((current) => event.target.checked ? [...current, vault.id] : current.filter((id) => id !== vault.id))} />
          <span>{vault.id}</span><small>{editingVaults.vaults?.some((entry) => entry.vaultId === vault.id) ? "已入库" : "可添加"}</small></label>)}</div>
      <p className="source-vault-note">已入库的关联不可在这里取消；后续删除将在知识库中统一处理文件和索引。</p>
      {vaultError && <p className="inline-message error" role="alert">{vaultError}</p>}
      <div className="source-vault-footer"><button className="secondary-button" type="button" disabled={busy} onClick={() => setEditingVaults(null)}>取消</button>
        <button className="primary-button" type="button" disabled={busy || !draftVaultIds.some((id) => !editingVaults.vaults?.some((entry) => entry.vaultId === id))}
          onClick={() => void saveVaults()}>{busy ? "入库中…" : "确认入库"}</button></div>
    </section></div>}

    <section className={`panel-card source-list-panel${chosen.length ? " has-selection" : ""}`} aria-label="资料列表">
      <div className="source-board-header"><div className="source-tabs" role="tablist" aria-label="资料视图">{tabs.map((tab) => <button key={tab.id} role="tab" aria-selected={view === tab.id}
        className={view === tab.id ? "active" : ""} onClick={() => switchView(tab.id)}>{tab.label} <span>{list?.counts[tab.id] ?? ""}</span></button>)}</div>
        <div className="source-board-meta">{activeCount > 0 && <span>分析中 {activeCount}</span>}
          {recentCompleted > 0 && <span>最近完成 {recentCompleted}</span>}
          {failedCount > 0 && <span>分析失败 {failedCount}</span>}
          {!!list?.counts.autoQueued && <span>自动入库排队 {list.counts.autoQueued}</span>}
          <span className="count-pill">当前结果 {list?.total ?? 0} 篇</span></div></div>
      <div className="source-filters"><form onSubmit={(event) => { event.preventDefault(); setSearch(searchInput.trim()); setPage(1); }}>
        <input aria-label="搜索资料" placeholder="搜索标题、文件名或来源" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} />
        <button className="secondary-button" type="submit">搜索</button></form>
        <WorkbenchSelect label="资料状态" value={statusFilter} onChange={(value) => { setStatusFilter(value); setPage(1); }}
          options={[{ value: "", label: "全部状态" }, { value: "ready", label: "可处理" }, { value: "processing", label: "入库中" },
            { value: "incomplete", label: "内容不完整" }, { value: "failed", label: "入库失败" }, { value: "imported", label: "已入库" }]} />
        <WorkbenchSelect label="分析卡状态" value={analysisFilter} onChange={(value) => { setAnalysisFilter(value); setPage(1); }}
          options={[{ value: "", label: "全部分析状态" }, { value: "none", label: "未分析" }, { value: "analyzed", label: "已分析" }]} />
        <WorkbenchSelect label="已入库知识库" value={vaultFilter} onChange={(value) => { setVaultFilter(value); setPage(1); }}
          options={[{ value: "", label: "全部知识库" }, ...(vaults?.vaults.map((vault) => ({ value: vault.id, label: vault.id })) ?? [])]} /></div>
      <div className="source-list-head"><label><input type="checkbox" aria-label="选择当前页" checked={pageSelected} onChange={togglePage} /><span className="source-head-desktop">资料</span><span className="source-head-mobile">选择本页</span></label>
        <span>导入时间</span><span>处理状态</span><span>分析卡</span><span>操作</span></div>
      {rows.length === 0 ? <div className="source-empty">{view === "pending" ? "没有待整理资料。导入文件后会显示在这里。" : "当前筛选下没有资料。"}</div> :
        <div className="source-rows">{rows.map((item) => {
          const id = itemKey(item), card = cards[id], open = expanded === id;
          const hasAnalysis = !!card || !!item.analysisStatus;
          const job = latestJobs.find((entry) => entry.batchId === item.batchId && entry.captureId === item.captureId);
          const jobRunning = !!job && activeJob(job);
          return <article className="source-row" key={id}>
            <div className="source-row-main" onClick={(event) => {
              if (event.target instanceof Element && event.target.closest("button, a, input, label, select, textarea")) return;
              toggleExpanded(item);
            }}><div className="source-name"><label className="source-select-hit"><input type="checkbox" aria-label={`选择 ${item.title}`} checked={!!selected[id]} onChange={() => toggle(item)} /></label>
              <div><button className="source-title" aria-expanded={open} onClick={() => toggleExpanded(item)}>{item.title}</button>
                {item.originalUrl ? <div className="source-origin"><a href={item.originalUrl} title={item.originalUrl} target="_blank" rel="noreferrer">原文链接</a>
                  <span title={sourceDomain(item.originalUrl)}>{sourceDomain(item.originalUrl)}</span></div> :
                  <span className="local-source">本地文件 · {item.sourceFilename ?? "未命名文件"}</span>}</div></div>
              <time>{date(item.createdAt)}</time><span className={`tag ${item.status === "incomplete" || item.status === "failed" ? "warning" : "success"}`}>{itemStatus(item)}</span>
              <span className={`tag source-analysis-state ${hasAnalysis ? "success" : "neutral"}`}>{hasAnalysis ? "已分析" : "未分析"}</span>
              <div className="source-row-actions"><button className="text-button" onClick={() => toggleExpanded(item)}>{open ? "收起" : "查看"}</button>
                {item.disposition === "trashed" ? <><button className="text-button" disabled={busy} onClick={() => void action("restore", [item])}>恢复</button>
                  <button className="text-button" disabled={busy} onClick={() => void action("purge", [item])}>永久删除</button></> : <>
                  <button className="text-button" title="添加到知识库" disabled={busy || item.status === "processing"} onClick={() => openVaultEditor(item)}>{item.vaults?.length ? "追加" : "入库"}</button>
                  <button className="text-button" aria-label={hasAnalysis ? "重新分析" : "生成分析卡"} disabled={busy || jobRunning}
                    onClick={() => void queueAnalysis([item])}>{jobRunning ? "分析中" : "分析卡"}</button>
                  {item.status !== "imported" && item.status !== "processing" && <button className="text-button" disabled={busy} onClick={() => void action(item.disposition === "shelved" ? "restore" : "shelve", [item])}>{item.disposition === "shelved" ? "重新整理" : "搁置"}</button>}</>}</div></div>
            {open && <div className="source-detail"><div className="source-detail-meta"><span>{item.originalUrl ? "抓取" : "导入"}：{date(item.capturedAt)}</span><span>知识库：{item.vaults?.length ? item.vaults.map((entry) => entry.vaultId).join("、") : "未入库"}</span><span>批次：{item.batchId.slice(0, 8)}</span></div>
              {item.warnings.length > 0 && <p className="inline-message">预检提示：{item.warnings.join("、")}</p>}
              {item.errorCode && <p className="inline-message error">处理失败：{item.errorCode}</p>}
              {job?.status === "failed" && <p className="inline-message error">分析任务失败：{new ApiError(409, job.errorCode ?? "UNEXPECTED_ERROR").message}。可以重试。</p>}
              <div className={`source-detail-layout${card ? " has-card" : ""}`} data-pane={detailPane}>
                {card && <div className="source-detail-tabs" role="tablist" aria-label="资料详情内容">
                  <button type="button" role="tab" aria-selected={detailPane === "original"} onClick={() => setDetailPane("original")}>资料正文</button>
                  <button type="button" role="tab" aria-selected={detailPane === "analysis"} onClick={() => setDetailPane("analysis")}>来源分析卡</button>
                </div>}
                <section className="source-original" aria-label={`${item.title} 资料正文`}><strong>资料正文</strong><pre>{item.markdown}</pre></section>
                {card && <section className="analysis-card" aria-label={`${item.title} 来源分析卡`}><div className="candidate-top"><strong>来源分析卡</strong>
                <span className="tag success">已分析</span></div>
                <p>{card.summary}</p><ul>{card.mainPoints.map((point, index) => <li key={index}><strong>{point.claim}</strong><small>{point.kind === "article_statement" ? "作者陈述" : point.kind === "inference" ? "原文推断" : "未确定"}</small>
                  {point.evidence.map((evidence, index2) => <div className="evidence" key={index2}>L{evidence.startLine}–L{evidence.endLine} · {evidence.excerpt}</div>)}</li>)}</ul>
                {card.limitations.length > 0 && <p>局限：{card.limitations.join("；")}</p>}
                <p>建议：{card.recommendation} · {card.reason}</p>
                <button className="secondary-button" disabled={busy || jobRunning} onClick={() => void queueAnalysis([item])}>重新分析</button></section>}
              </div>
              <div className="source-detail-actions">
                {item.status !== "imported" && item.status !== "processing" && item.disposition !== "trashed" && <button className="text-button" disabled={busy} onClick={() => void action("trash", [item])}>移入回收站</button>}</div></div>}
          </article>;
        })}</div>}
      {list && <div className="source-pagination"><span>第 {page} / {Math.max(1, Math.ceil(list.total / list.pageSize))} 页 · 共 {list.total} 篇</span>
        <div><button className="text-button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>上一页</button>
          <button className="text-button" disabled={page * list.pageSize >= list.total} onClick={() => setPage((value) => value + 1)}>下一页</button></div></div>}
    </section>
    {chosen.length > 0 && <div className="bulk-toolbar" role="toolbar" aria-label="批量资料操作"><strong>已选择 {chosen.length} 篇</strong>
      {chosen.length < (list?.total ?? 0) && <button className="text-button bulk-select-all" disabled={busy} onClick={() => void selectAllResults()}>选择全部筛选结果（{list?.total ?? 0}）</button>}
      <WorkbenchSelect className="workbench-select-bulk" label="批量入库目标" title={targetVaultId} value={targetVaultId}
        onChange={setTargetVaultId} options={vaults?.vaults.map((vault) => ({ value: vault.id, label: vault.id })) ?? []} />
      <button className="secondary-button" disabled={busy || !fileable.length} onClick={() => void action("file", fileable)}>批量入库</button>
      <button className="secondary-button" disabled={busy || !chosen.some((item) => item.disposition !== "trashed")} onClick={() => void queueAnalysis(chosen.filter((item) => item.disposition !== "trashed"))}>批量生成分析卡</button>
      {view === "trash" ? <><button className="secondary-button" disabled={busy} onClick={() => void action("restore", chosen)}>恢复</button>
        <button className="text-button" disabled={busy} onClick={() => void action("purge", chosen)}>永久删除</button></> : <>
        <button className="secondary-button" disabled={busy || !shelvable.length} onClick={() => void action("shelve", shelvable)}>搁置</button>
        <button className="text-button" disabled={busy || !trashable.length} onClick={() => void action("trash", trashable)}>移入回收站</button></>}
      <button className="text-button" onClick={() => setSelected({})}>清除选择</button></div>}
  </div>;
}
