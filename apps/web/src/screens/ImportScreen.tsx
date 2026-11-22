import { useEffect, useRef, useState } from "react";
import { ApiError, api, type Article, type ImportBatch, type ImportItem, type ImportItemsPage, type ImportPolicy,
  type AnalysisJob, type AnalysisJobsPage, type SourceAnalysis, type VaultList, type WritingMaterialRef } from "../api";
import type { MaintenanceJob, MaintenanceJobsPage } from "../api";
import type { FilingJob, FilingJobsPage } from "../api";
import { WorkspaceIcon } from "../WorkspaceIcon";
import { WorkbenchSelect } from "../WorkbenchSelect";
import { useLocale, type LocalizedNotice, type Translate } from "../locale";
import { KnowledgeMarkdown } from "./KnowledgeMarkdown";

interface Props { vaults: VaultList | null; onOpenArticle: (articleId: string) => void; onCaptureSettings: () => void }
type SourceMessage = LocalizedNotice | { format: (locale: Pick<ReturnType<typeof useLocale>, "t" | "errorText">) => string };
interface ImportReceipt { jobIds: string[]; summary: [string, string]; needsReview: number }
type View = "pending" | "recent" | "all" | "trash";
type Action = "file" | "shelve" | "restore" | "trash" | "purge";
const tabs: { id: View; label: [string, string] }[] = [
  { id: "pending", label: ["待整理", "To organize"] }, { id: "recent", label: ["最近处理", "Recently processed"] },
  { id: "all", label: ["全部资料", "All sources"] }, { id: "trash", label: ["回收站", "Trash"] },
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
const sourceCount = (count: number) => `${count} ${count === 1 ? "source" : "sources"}`;
const fileCount = (count: number) => `${count} ${count === 1 ? "file" : "files"}`;
function sourceDomain(url: string, t: Translate) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return t("来源网站", "Source website"); }
}
function itemStatus(item: ImportItem, filing: FilingJob | undefined, t: Translate) {
  if (item.disposition === "trashed") return t("回收站", "Trash");
  if (item.disposition === "shelved") return t("已搁置", "Shelved");
  if (item.status === "processing") return t("入库中", "Filing");
  if (filing?.status === "running") return t("入库中", "Filing");
  if (filing?.status === "queued" || filing?.status === "retry_wait") return t("排队入库", "Queued for filing");
  if (filing?.status === "needs_attention") return t("入库待检查", "Filing needs review");
  if (item.status === "ready" && item.autoVaultId) return t("排队入库", "Queued for filing");
  return { ready: t("待整理", "To organize"), incomplete: t("内容不完整", "Incomplete"), failed: t("入库失败", "Filing failed"), imported: t("已入库", "Filed") }[item.status];
}

function importSummary(imported: number, skipped: number, manual: boolean): [string, string] {
  return [
    `已导入 ${imported} 篇${imported && manual ? "，已加入待整理" : ""}${skipped ? `；跳过 ${skipped} 个不支持的文件` : ""}`,
    `Imported ${sourceCount(imported)}${imported && manual ? " into “To organize”" : ""}.${skipped ? ` Skipped ${skipped} unsupported ${skipped === 1 ? "file" : "files"}.` : ""}`,
  ];
}

export function ImportScreen({ vaults, onOpenArticle, onCaptureSettings }: Props) {
  const { locale, t, errorText, noticeText } = useLocale();
  const date = (value?: string | null) => value ? new Date(value).toLocaleString(locale) : "—";
  const display = (message: SourceMessage) => "format" in message ? message.format({ t, errorText }) : noticeText(message);
  const authorshipLabels = { self: t("本人原创", "My own work"), third_party: t("第三方文章", "Third-party content"), unknown: t("待确认", "Unconfirmed") };
  const authorshipOptions = (["unknown", "self", "third_party"] as const).map((value) => ({ value, label: authorshipLabels[value] }));
  const evidenceLabels = { clipper: t("采集插件", "Clipper"), frontmatter: t("前置属性", "Front matter"),
    html_meta: t("HTML 元数据", "HTML metadata"), json_ld: "JSON-LD", byline: t("署名行", "Byline") };
  const filingLabels = { queued: t("排队中", "Queued"), running: t("进行中", "In progress"), retry_wait: t("等待重试", "Waiting to retry"),
    completed: t("已完成", "Completed"), needs_attention: t("需要人工检查", "Needs review"), cancelled: t("已取消", "Cancelled") };
  const maintenanceLabels = { ...filingLabels, completed: t("已写入笔记", "Notes written"), skipped: t("已分析", "Analyzed"),
    failed: t("失败", "Failed"), blocked: t("助手暂不可用", "Assistant unavailable") };
  const recommendationLabels = { compile_now: t("立即编译", "Compile now"), defer: t("暂缓处理", "Defer"),
    keep_raw_only: t("仅保留原文", "Keep source only"), ask_user: t("需要用户确认", "Ask the user") };
  const splitList = t("、", ", ");
  const [initialFilters] = useState(storedFilters);
  const [targetVaultId, setTargetVaultId] = useState("");
  const [policy, setPolicy] = useState<ImportPolicy | null>(null);
  const [policyMode, setPolicyMode] = useState<ImportPolicy["mode"]>("manual");
  const [policyVaultId, setPolicyVaultId] = useState("");
  const [policyAuthorship, setPolicyAuthorship] = useState<ImportPolicy["defaultAuthorship"]>("unknown");
  const [uploadAuthorship, setUploadAuthorship] = useState("");
  const [policyOpen, setPolicyOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [importMessage, setImportMessage] = useState<SourceMessage | null>(null);
  const [importProgress, setImportProgress] = useState<LocalizedNotice | null>(null);
  const [receipt, setReceipt] = useState<ImportReceipt | null>(null);
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
  const [editingMetadata, setEditingMetadata] = useState<ImportItem | null>(null);
  const [draftAuthor, setDraftAuthor] = useState("");
  const [draftAuthorship, setDraftAuthorship] = useState<ImportItem["authorship"]>("unknown");
  const [metadataError, setMetadataError] = useState<LocalizedNotice | null>(null);
  const [draftVaultIds, setDraftVaultIds] = useState<string[]>([]);
  const [vaultError, setVaultError] = useState<SourceMessage | null>(null);
  const [cards, setCards] = useState<Record<string, SourceAnalysis>>({});
  const [jobs, setJobs] = useState<AnalysisJob[]>([]);
  const [maintenanceJobs, setMaintenanceJobs] = useState<MaintenanceJob[]>([]);
  const [filingJobs, setFilingJobs] = useState<FilingJob[]>([]);
  const filingRef = useRef<FilingJob[]>([]);
  const jobsRef = useRef<AnalysisJob[]>([]);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<SourceMessage | null>(null);
  const mounted = useRef(false);
  const editingEvidence = editingMetadata?.authorEvidence;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

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
      setPolicy(value); setPolicyMode(value.mode); setPolicyAuthorship(value.defaultAuthorship);
      if (value.vaultId) setPolicyVaultId(value.vaultId);
    }).catch((error) => setMessage([error, "读取规则失败", "Could not load import rules"]));
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
      .catch((error) => { if (!cancelled) setMessage([error, "读取资料失败", "Could not load sources"]); });
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
    let cancelled = false;
    const load = () => { void api<FilingJobsPage>("/imports/filing-jobs").then((value) => {
      if (cancelled) return;
      const previous = new Map(filingRef.current.map((job) => [job.id, job.status]));
      filingRef.current = value.jobs;
      setFilingJobs(value.jobs);
      if (value.jobs.some((job) => previous.get(job.id) !== job.status)) refresh();
    }).catch(() => undefined); };
    load();
    const timer = window.setInterval(load, 3_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);
  useEffect(() => {
    if (!jobs.some(activeJob)) return;
    const timer = window.setInterval(() => { void pollJobs(); }, 2_000);
    return () => window.clearInterval(timer);
  }, [jobs]);
  useEffect(() => {
    let cancelled = false;
    const load = () => { void api<MaintenanceJobsPage>("/maintenance/jobs").then((value) => {
      if (!cancelled) setMaintenanceJobs(value.jobs);
    }).catch(() => undefined); };
    load();
    const timer = window.setInterval(load, 3_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);
  const refresh = () => setRevision((value) => value + 1);
  const rows = list?.items ?? [];
  const chosen = Object.values(selected).map((item) => rows.find((row) => itemKey(row) === itemKey(item)) ?? item);
  const fileable = chosen.filter((item) => item.status !== "incomplete" && item.status !== "processing" &&
    item.disposition !== "trashed" && !item.vaults?.some((membership) => membership.vaultId === targetVaultId) &&
    !filingJobs.some((job) => job.batchId === item.batchId && job.captureId === item.captureId &&
      job.vaultId === targetVaultId && ["queued", "running", "retry_wait"].includes(job.status)));
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
  function viewFiledSources() {
    setSearch(""); setSearchInput(""); setAnalysisFilter(""); setVaultFilter(""); setStatusFilter("imported");
    switchView("recent");
  }
  function writingMaterial(item: ImportItem): WritingMaterialRef | null {
    if (item.disposition === "trashed") return null;
    const sources = item.vaults?.length ? item.vaults : item.vaultId && item.snapshot ?
      [{ vaultId: item.vaultId, snapshot: item.snapshot }] : [];
    const available = sources.filter((source) => !vaults || vaults.vaults.some((vault) => vault.id === source.vaultId));
    const source = available.find((entry) => entry.vaultId === vaultFilter) ??
      available.find((entry) => entry.vaultId === item.vaultId) ?? available[0];
    return source ? { vaultId: source.vaultId, path: source.snapshot } : null;
  }
  async function startArticle(items: ImportItem[]) {
    if (busy || !items.length || items.length > 30) return;
    const selectedMaterials = items.map(writingMaterial);
    if (selectedMaterials.some((material) => !material)) return;
    const materials = [...new Map(selectedMaterials.flatMap((material) => material ?
      [[JSON.stringify([material.vaultId, material.path]), material] as const] : [])).values()];
    setBusy(true); setMessage(null); setReceipt(null);
    try {
      const article = await api<Article>("/articles", { method: "POST", body: { materials } });
      if (mounted.current) onOpenArticle(article.id);
    } catch (error) {
      if (mounted.current) setMessage([error, "新建文章失败，请重试。", "Could not create the article. Try again."]);
    } finally { if (mounted.current) setBusy(false); }
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
    setBusy(true); setMessage(null);
    try {
      const picked: Record<string, ImportItem> = {};
      for (let next = 1; next <= Math.ceil(list.total / 100); next++) {
        const batch = await api<ImportItemsPage>(listPath(next, 100));
        for (const item of batch.items) picked[itemKey(item)] = item;
      }
      const count = Object.keys(picked).length;
      setSelected(picked); setMessage([`已选择 ${count} 篇筛选结果`, `Selected ${sourceCount(count)} from the results`]);
    } catch (error) { setMessage([error, "选择失败", "Could not select the matching sources"]); }
    finally { setBusy(false); }
  }
  async function upload(files: File[]) {
    if (!files.length || busy) return;
    setBusy(true); setImportMessage(null); setMessage(null); setReceipt(null);
    let imported = 0;
    let skipped = 0;
    const jobIds: string[] = [];
    const failed: { name: string; error: unknown }[] = [];
    try {
      for (const [index, file] of files.entries()) {
        setImportProgress([`正在导入 ${index + 1}/${files.length}：${file.name}`, `Importing ${index + 1} of ${files.length} · ${file.name}`]);
        try {
          const form = new FormData(); form.append("file", file);
          const batch = await api<ImportBatch>("/imports/preflight", { method: "POST", body: form,
            headers: uploadAuthorship ? { "x-ocf-authorship": uploadAuthorship } : undefined });
          imported += batch.candidates.length;
          skipped += batch.skippedFiles ?? 0;
          jobIds.push(...(batch.filingJobIds ?? []));
        } catch (error) { failed.push({ name: file.name, error }); }
      }
      if (imported) {
        setSearch(""); setSearchInput(""); setStatusFilter(""); setAnalysisFilter(""); setVaultFilter("");
        switchView(jobIds.length ? "all" : "pending");
        refresh();
      }
      const summary = importSummary(imported, skipped, !jobIds.length);
      if (jobIds.length) setReceipt({ jobIds, summary, needsReview: imported - jobIds.length });
      if (failed.length) setImportMessage({ format: ({ t, errorText }) => {
        const details = failed.map(({ name, error }) => `${name}${t("：", " · ")}${errorText(error, "导入失败", "Import failed")}`).join(t("；", " / "));
        return t(`${summary[0]}；${failed.length} 个文件失败：${details}`, `${summary[1]} Could not import ${fileCount(failed.length)}. ${details}`);
      } });
      else { setImportOpen(false); if (!jobIds.length) setMessage(summary); }
    } finally { setImportProgress(null); setBusy(false); }
  }
  async function savePolicy() {
    setBusy(true); setMessage(null);
    try {
      const saved = await api<ImportPolicy>("/imports/policy", { method: "PUT",
        body: { mode: policyMode, vaultId: policyMode === "auto-file" ? policyVaultId : null,
          defaultAuthorship: policyAuthorship } });
      setPolicy(saved); setPolicyOpen(false); setMessage(["新资料处理规则已保存", "Import rules saved"]);
    } catch (error) { setMessage([error, "保存失败", "Could not save import rules"]); }
    finally { setBusy(false); }
  }
  async function action(name: Action, items: ImportItem[]) {
    if (!items.length) return;
    if (name === "purge" && !window.confirm(t(`永久删除 ${items.length} 篇采集资料和智能摘要？此操作不可恢复。`,
      `Permanently delete ${sourceCount(items.length)} and the associated smart summaries?`))) return;
    setBusy(true); setMessage(null); setReceipt(null);
    let succeeded = 0; const errors: string[] = [];
    try {
      for (let offset = 0; offset < items.length; offset += 100) {
        const part = items.slice(offset, offset + 100);
        const response = await api<{ results: { ok: boolean; error?: string; vaultId?: string; jobId?: string }[] }>(
          "/imports/items/actions", { method: "POST", body: { action: name, vaultId: targetVaultId,
            items: part.map((item) => ({ batchId: item.batchId, captureId: item.captureId })) } });
        for (const result of response.results) {
          if (result.ok) succeeded++;
          else if (result.error) errors.push(result.error);
        }
      }
      setSelected({}); refresh();
      if (name === "file") void refreshMaintenance();
      const summary: [string, string] = name === "trash" ?
        [`已将 ${succeeded} 篇资料移入回收站，可随时恢复`, `Moved ${sourceCount(succeeded)} to trash. You can restore them at any time.`] : name === "file" ?
          [`已加入入库队列 ${succeeded} 篇`, `Queued ${sourceCount(succeeded)} for filing.`] :
          [`已处理 ${succeeded} 篇`, `Processed ${sourceCount(succeeded)}.`];
      setMessage(errors.length ? { format: ({ t, errorText }) => {
        const details = [...new Set(errors.map((code) => errorText(new ApiError(409, code), "操作失败", "The action failed")))].join(t("、", " / "));
        return t(`${summary[0]}；${errors.length} 篇失败：${details}`, `${summary[1]} Failed for ${sourceCount(errors.length)}. ${details}`);
      } } : summary);
    } catch (error) { setMessage([error, "操作失败", "The action failed"]); }
    finally { setBusy(false); }
  }
  function openVaultEditor(item: ImportItem) {
    setVaultError(null);
    setEditingVaults(item);
    setDraftVaultIds((item.vaults ?? []).map((membership) => membership.vaultId));
  }
  async function saveVaults() {
    if (!editingVaults) return;
    setBusy(true); setMessage(null);
    try {
      const result = await api<{ vaults: ImportItem["vaults"]; jobs: FilingJob[]; errors: { vaultId: string; error: string }[] }>(
        `/imports/${editingVaults.batchId}/items/${encodeURIComponent(editingVaults.captureId)}/vaults`,
        { method: "PUT", body: { vaultIds: draftVaultIds } });
      refresh();
      void refreshMaintenance();
      if (result.errors.length) {
        setVaultError({ format: ({ t, errorText }) => {
          const details = result.errors.map(({ error, vaultId }) => {
            const reason = errorText(new ApiError(409, error), "添加知识库失败", "Filing failed");
            return t(`${vaultId}（${reason}）`, `${vaultId} (${reason})`);
          }).join(t("、", " / "));
          return t(`部分知识库写入失败：${details}`, `Could not file in some vaults. ${details}`);
        } });
      } else {
        setEditingVaults(null);
        const count = result.jobs.length;
        setMessage([`已加入 ${count} 个知识库入库队列`, `Queued for filing in ${count} ${count === 1 ? "vault" : "vaults"}`]);
      }
    } catch (error) { setVaultError([error, "添加知识库失败", "Could not add the source to the vault"]); }
    finally { setBusy(false); }
  }
  function openMetadataEditor(item: ImportItem) {
    setEditingMetadata(item);
    setDraftAuthor(item.author ?? "");
    setDraftAuthorship(item.authorship);
    setMetadataError(null);
  }
  async function saveMetadata() {
    if (!editingMetadata) return;
    setBusy(true); setMetadataError(null);
    try {
      await api(`/imports/${editingMetadata.batchId}/items/${encodeURIComponent(editingMetadata.captureId)}/metadata`, {
        method: "PATCH", body: { expectedVersion: editingMetadata.metadataVersion,
          author: draftAuthor.trim() || null, authorship: draftAuthorship } });
      setEditingMetadata(null);
      refresh();
      setMessage(["来源信息已更新", "Source details updated"]);
    } catch (error) { setMetadataError([error, "保存来源信息失败", "Could not save source details"]); }
    finally { setBusy(false); }
  }
  async function refreshMaintenance() {
    try { setMaintenanceJobs((await api<MaintenanceJobsPage>("/maintenance/jobs")).jobs); }
    catch { /* Source list remains usable if maintenance status is unavailable. */ }
  }
  async function filingAction(id: string, action: "inspect" | "cancel") {
    setMessage(null);
    try {
      await api(`/imports/filing-jobs/${encodeURIComponent(id)}/${action}`, { method: "POST" });
      setFilingJobs((await api<FilingJobsPage>("/imports/filing-jobs")).jobs);
      refresh();
    } catch (error) { setMessage([error, "处理入库任务失败", "Could not update the filing job"]); }
  }
  async function startMaintenance(vaultId: string, fingerprint: string) {
    setMessage(null);
    try {
      await api("/maintenance/jobs", { method: "POST", body: { vaultId, fingerprint } });
      await refreshMaintenance(); setMessage(["已提交知识维护任务", "Knowledge maintenance queued"]);
    } catch (error) { setMessage([error, "提交知识维护失败", "Could not submit knowledge maintenance"]); }
  }
  async function retryMaintenance(id: string) {
    setMessage(null);
    try {
      await api(`/maintenance/jobs/${encodeURIComponent(id)}/retry`, { method: "POST" });
      await refreshMaintenance(); setMessage(["已重新提交知识维护任务", "Knowledge maintenance requeued"]);
    } catch (error) { setMessage([error, "重试知识维护失败", "Could not retry knowledge maintenance"]); }
  }
  async function cancelMaintenance(id: string) {
    setMessage(null);
    try {
      await api(`/maintenance/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
      await refreshMaintenance(); setMessage(["已取消知识维护任务", "Knowledge maintenance cancelled"]);
    } catch (error) { setMessage([error, "取消知识维护失败", "Could not cancel knowledge maintenance"]); }
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
    setBusy(true); setMessage(null);
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
      setMessage([`已提交 ${accepted.length} 篇分析任务，可继续处理其他资料`, `Queued ${sourceCount(accepted.length)} for analysis.`]);
    } catch (error) {
      if (accepted.length) {
        const merged = [...accepted, ...jobsRef.current.filter((job) => !accepted.some((next) => next.id === job.id))].slice(0, 200);
        jobsRef.current = merged; setJobs(merged);
      }
      if (accepted.length) setMessage({ format: ({ t, errorText }) =>
        t(`已提交 ${accepted.length} 篇；`, `Queued ${sourceCount(accepted.length)} for analysis. `) +
          errorText(error, "提交分析任务失败", "Could not submit the remaining analysis jobs") });
      else setMessage([error, "提交分析任务失败", "Could not submit analysis jobs"]);
    }
    finally { setBusy(false); }
  }
  const latestJobs = [...new Map(jobs.slice().reverse().map((job) => [itemKey(job), job])).values()];
  const activeCount = latestJobs.filter(activeJob).length;
  const recentCompleted = latestJobs.filter((job) => job.status === "completed" &&
    Date.now() - new Date(job.updatedAt).getTime() < 24 * 60 * 60 * 1000).length;
  const failedCount = latestJobs.filter((job) => job.status === "failed").length;
  const receiptIds = new Set(receipt?.jobIds);
  const receiptJobs = filingJobs.filter((job) => receiptIds.has(job.id));
  const filedCount = receiptJobs.filter((job) => job.status === "completed").length;
  const stoppedCount = receiptJobs.filter((job) => job.status === "needs_attention" || job.status === "cancelled").length;
  const needsReview = (receipt?.needsReview ?? 0) + stoppedCount;
  const waitingCount = receiptIds.size - filedCount - stoppedCount;
  const filtered = !!(search || statusFilter || analysisFilter || vaultFilter);
  const hasRows = rows.length > 0;
  const total = list?.total ?? 0;
  const pageCount = list ? Math.max(1, Math.ceil(list.total / list.pageSize)) : 1;
  const policyVault = policy?.vaultId === vaults?.defaultVaultId ? t("默认知识库", "default vault") : policy?.vaultId;
  function openImport() { setImportMessage(null); setImportOpen(true); }
  function resetFilters() { setSearch(""); setSearchInput(""); setStatusFilter(""); setAnalysisFilter(""); setVaultFilter(""); setPage(1); }

  return <div className="screen-stack source-workbench">
    <section className="panel-card intake-toolbar">
      <div className="source-toolbar-main"><h1 className="source-heading">{t("资料与分析", "Sources & Analysis")}</h1>
        <div className="intake-actions"><button className="text-button source-policy-trigger" type="button" aria-expanded={policyOpen}
          aria-controls="source-policy-editor" onClick={() => setPolicyOpen((open) => !open)}>{t("入库规则", "Import rules")} <span>{policy?.mode === "auto-file" ?
            t(`自动入库至 ${policyVault}`, `Auto-file to ${policyVault}`) : policy ? t("先放待整理", "Review before filing") : ""}</span></button>
          <button className="text-button capture-settings-link" type="button" onClick={onCaptureSettings}>{t("采集设置", "Capture settings")}</button>
          <button className="primary-button" onClick={openImport} aria-haspopup="dialog">{t("导入资料", "Import sources")}</button></div></div>
      {policyOpen && <div id="source-policy-editor" className="intake-drawer policy-editor"><div className="select-field"><span>{t("采集后如何处理", "After capture")}</span>
        <WorkbenchSelect label={t("采集后如何处理", "After capture")} value={policyMode} onChange={(value) => setPolicyMode(value as ImportPolicy["mode"])}
          options={[{ value: "manual", label: t("先放待整理", "Review before filing") }, { value: "auto-file", label: t("自动直接入库", "File automatically") }]} /></div>
        {policyMode === "auto-file" && <div className="select-field"><span>{t("自动入库目标", "File to")}</span>
          <WorkbenchSelect label={t("自动入库目标", "File to")} value={policyVaultId} onChange={setPolicyVaultId}
            options={vaults?.vaults.map((vault) => ({ value: vault.id, label: vault.id })) ?? []} /></div>}
        <div className="select-field"><span>{t("原文默认归属", "Default authorship")}</span>
          <WorkbenchSelect label={t("原文默认归属", "Default authorship")} value={policyAuthorship} onChange={(value) => setPolicyAuthorship(value as ImportPolicy["defaultAuthorship"])}
            options={authorshipOptions} /></div>
        <button className="primary-button" disabled={busy || (policyMode === "auto-file" && !policyVaultId)} onClick={() => void savePolicy()}>{t("保存规则", "Save rules")}</button>
        <small>{t("智能摘要按需生成；内容不完整或写入失败的资料仍留在待整理。", "Generate smart summaries on demand. Incomplete sources and failed imports stay in “To organize”.")}</small></div>}
      {message && <p className="inline-message" role="status">{display(message)}</p>}
      {receipt && !message && <div className="source-import-receipt">
        <p role="status">{noticeText(receipt.summary)}{filedCount > 0 ? t(`，已入库 ${filedCount} 篇`, ` Filed ${sourceCount(filedCount)}.`) : ""}
          {waitingCount > 0 ? t(`，${waitingCount} 篇正在入库`, ` Filing ${sourceCount(waitingCount)}.`) : ""}
          {needsReview ? t(`，${needsReview} 篇需检查`, ` ${sourceCount(needsReview)} ${needsReview === 1 ? "needs" : "need"} review.`) : ""}</p>
        {filedCount > 0 && <button className="text-button" onClick={viewFiledSources}>{t("查看已入库资料", "View filed sources")}</button>}
        {needsReview > 0 && <button className="text-button" onClick={() => { resetFilters(); switchView("pending"); }}>{t("查看待整理资料", "View sources to organize")}</button>}
      </div>}
    </section>
    {importOpen && <div className="modal-backdrop import-modal-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) setImportOpen(false);
    }}>
      <section className="import-modal" role="dialog" aria-modal="true" aria-labelledby="import-dialog-title">
        <div className="import-modal-head"><div><h2 id="import-dialog-title">{t("导入资料", "Import sources")}</h2><p>{t("选择文件或拖到下方，导入后统一进入资料列表。", "Choose files or drop them below to add them to your source list.")}</p></div>
          <button className="import-modal-close" type="button" disabled={busy} aria-label={t("关闭导入弹窗", "Close import dialog")} onClick={() => setImportOpen(false)}>×</button></div>
        <input ref={fileInput} className="sr-only" type="file" aria-label={t("选择文件", "Choose files")} multiple
          accept=".md,.markdown,.mdown,.txt,.text,.html,.htm,.zip,text/plain,text/html,application/zip"
          onChange={(event) => { void upload(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ""; }} />
        <div className="select-field"><span>{t("本批原文归属", "Authorship for this import")}</span>
          <WorkbenchSelect label={t("本批原文归属", "Authorship for this import")} value={uploadAuthorship} onChange={setUploadAuthorship}
            options={[{ value: "", label: t("按入库规则", "Use import rules") }, ...authorshipOptions]} /></div>
        <button ref={dropButton} className={`import-dropzone${dropActive ? " active" : ""}`} type="button" disabled={busy}
          onClick={() => fileInput.current?.click()}
          onDragEnter={(event) => { event.preventDefault(); setDropActive(true); }}
          onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setDropActive(true); }}
          onDragLeave={(event) => { event.preventDefault(); setDropActive(false); }}
          onDrop={(event) => { event.preventDefault(); setDropActive(false); void upload(Array.from(event.dataTransfer.files)); }}>
          <span className="import-dropzone-icon"><WorkspaceIcon name="publish" size={28} /></span>
          <strong>{t("拖拽文件到这里", "Drop files here")}</strong><span>{t("或点击选择文件，可一次选择多个", "Or click to select one or more files")}</span>
        </button>
        <p className="import-modal-formats">{t("支持 Markdown、HTML、TXT、ZIP。普通 ZIP 会识别其中的多篇文本；Clipper ZIP 继续按原格式导入。", "Supports Markdown, HTML, TXT, and ZIP. A ZIP can contain multiple documents or a Clipper export.")}</p>
        {importProgress && <p className="import-modal-progress" role="status">{noticeText(importProgress)}</p>}
        {importMessage && <p className="inline-message error import-modal-error" role="alert">{display(importMessage)}</p>}
      </section>
    </div>}

    {editingVaults && <div className="modal-backdrop import-modal-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) setEditingVaults(null);
    }}><section className="import-modal source-vault-modal" role="dialog" aria-modal="true" aria-labelledby="source-vault-title">
      <div className="import-modal-head"><div><h2 id="source-vault-title">{t("添加到知识库", "Add to vault")}</h2>
        <p className="source-vault-subtitle">{editingVaults.title}</p></div>
        <button className="import-modal-close" type="button" disabled={busy} aria-label={t("关闭知识库选择", "Close vault picker")} onClick={() => setEditingVaults(null)}>×</button></div>
      <div className="source-vault-options" role="group" aria-label={t("选择要加入的知识库", "Choose destination vaults")}>{vaults?.vaults.map((vault) =>
        <label key={vault.id}><input type="checkbox" checked={draftVaultIds.includes(vault.id)}
          disabled={busy || !!editingVaults.vaults?.some((entry) => entry.vaultId === vault.id) || editingVaults.status === "incomplete"}
          onChange={(event) => setDraftVaultIds((current) => event.target.checked ? [...current, vault.id] : current.filter((id) => id !== vault.id))} />
          <span>{vault.id}</span><small>{editingVaults.vaults?.some((entry) => entry.vaultId === vault.id) ? t("已入库", "Filed") : t("可添加", "Available")}</small></label>)}</div>
      <p className="source-vault-note">{t("已入库的关联不可在这里取消；后续删除将在知识库中统一处理文件和索引。", "Manage removal from a vault in Knowledge to update both the files and the index.")}</p>
      {vaultError && <p className="inline-message error" role="alert">{display(vaultError)}</p>}
      <div className="source-vault-footer"><button className="secondary-button" type="button" disabled={busy} onClick={() => setEditingVaults(null)}>{t("取消", "Cancel")}</button>
        <button className="primary-button" type="button" disabled={busy || !draftVaultIds.some((id) => !editingVaults.vaults?.some((entry) => entry.vaultId === id))}
          onClick={() => void saveVaults()}>{busy ? t("入库中…", "Adding…") : t("确认入库", "Add to selected vaults")}</button></div>
    </section></div>}

    {editingMetadata && <div className="modal-backdrop import-modal-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) setEditingMetadata(null);
    }}><section className="import-modal source-vault-modal" role="dialog" aria-modal="true" aria-labelledby="source-metadata-title">
      <div className="import-modal-head"><div><h2 id="source-metadata-title">{t("修正来源信息", "Edit source details")}</h2><p>{editingMetadata.title}</p></div>
        <button className="import-modal-close" type="button" disabled={busy} aria-label={t("关闭来源信息", "Close source details")} onClick={() => setEditingMetadata(null)}>×</button></div>
      <label>{t("文章署名", "Byline")}<input value={draftAuthor} onChange={(event) => setDraftAuthor(event.target.value)} placeholder={t("原文作者", "Original author")} /></label>
      <small>{t("提取依据：", "Byline evidence · ")}{editingEvidence ? evidenceLabels[editingEvidence.kind] : t("未发现明确署名", "No byline found")}
        {editingEvidence?.location ? ` · ${editingEvidence.location}` : ""}</small>
      <div className="select-field"><span>{t("原文归属", "Authorship")}</span><WorkbenchSelect label={t("原文归属", "Authorship")} value={draftAuthorship}
        onChange={(value) => setDraftAuthorship(value as ImportItem["authorship"])}
        options={authorshipOptions} /></div>
      {metadataError && <p className="inline-message error" role="alert">{noticeText(metadataError)}</p>}
      <div className="action-row"><button className="secondary-button" disabled={busy} onClick={() => setEditingMetadata(null)}>{t("取消", "Cancel")}</button>
        <button className="primary-button" disabled={busy} onClick={() => void saveMetadata()}>{t("保存来源信息", "Save source details")}</button></div>
    </section></div>}

    <section className={`panel-card source-list-panel${hasRows ? "" : " is-empty"}${chosen.length ? " has-selection" : ""}`} aria-label={t("资料列表", "Source list")}>
      <div className="source-board-header"><div className="source-tabs" role="tablist" aria-label={t("资料视图", "Source views")}>{tabs.map((tab) => <button key={tab.id} role="tab" aria-selected={view === tab.id}
        className={view === tab.id ? "active" : ""} onClick={() => switchView(tab.id)}>{t(...tab.label)} <span>{list?.counts[tab.id] ?? ""}</span></button>)}</div>
        <div className="source-board-meta">{activeCount > 0 && <span>{t(`摘要生成中 ${activeCount}`, `Generating summaries · ${activeCount}`)}</span>}
          {recentCompleted > 0 && <span>{t(`摘要近期完成 ${recentCompleted}`, `Recent summaries · ${recentCompleted}`)}</span>}
          {failedCount > 0 && <span>{t(`摘要生成失败 ${failedCount}`, `Failed summaries · ${failedCount}`)}</span>}
          {!!list?.counts.autoQueued && !receipt && <span>{t(`正在入库 ${list.counts.autoQueued} 篇`, `Filing ${sourceCount(list.counts.autoQueued)}`)}</span>}
          {hasRows && filtered && <span className="count-pill">{t(`找到 ${total} 篇`, `Found ${sourceCount(total)}`)}</span>}</div></div>
      {(hasRows || filtered) && <div className="source-filters"><form onSubmit={(event) => { event.preventDefault(); setSearch(searchInput.trim()); setPage(1); }}>
        <input aria-label={t("搜索资料", "Search sources")} placeholder={t("搜索标题、文件名或来源", "Search titles, filenames, or origins")} value={searchInput} onChange={(event) => setSearchInput(event.target.value)} />
        <button className="secondary-button" type="submit">{t("搜索", "Search")}</button></form>
        <WorkbenchSelect label={t("资料状态", "Source status")} value={statusFilter} onChange={(value) => { setStatusFilter(value); setPage(1); }}
          options={[{ value: "", label: t("全部状态", "All statuses") }, { value: "ready", label: t("可处理", "Ready") }, { value: "processing", label: t("入库中", "Filing") },
            { value: "incomplete", label: t("内容不完整", "Incomplete") }, { value: "failed", label: t("入库失败", "Filing failed") }, { value: "imported", label: t("已入库", "Filed") }]} />
        <WorkbenchSelect label={t("摘要状态", "Summary status")} value={analysisFilter} onChange={(value) => { setAnalysisFilter(value); setPage(1); }}
          options={[{ value: "", label: t("全部摘要状态", "Any summary status") }, { value: "none", label: t("未生成", "No summary") }, { value: "analyzed", label: t("已生成", "Generated") }]} />
        <WorkbenchSelect label={t("已入库知识库", "Filed in vault")} value={vaultFilter} onChange={(value) => { setVaultFilter(value); setPage(1); }}
          options={[{ value: "", label: t("全部知识库", "All vaults") }, ...(vaults?.vaults.map((vault) => ({ value: vault.id, label: vault.id })) ?? [])]} /></div>}
      {hasRows && <div className="source-list-head"><label><input type="checkbox" aria-label={t("选择当前页", "Select current page")} checked={pageSelected} onChange={togglePage} /><span className="source-head-desktop">{t("资料", "Source")}</span><span className="source-head-mobile">{t("选择本页", "Select this page")}</span></label>
        <span>{t("导入时间", "Imported")}</span><span>{t("处理状态", "Status")}</span><span>{t("智能摘要", "Smart summary")}</span><span>{t("操作", "Actions")}</span></div>}
      {!hasRows ? <div className="source-empty">
        {!list ? <p role="status">{t("正在读取资料…", "Loading sources…")}</p> : <>
          <span className="source-empty-icon"><WorkspaceIcon name="sources" size={24} /></span>
          <h2>{filtered ? t("没有匹配的资料", "No matching sources") : view === "trash" ? t("回收站为空", "Trash is empty") :
            view === "pending" ? t("没有待整理的资料", "No sources to organize") : view === "recent" ? t("最近没有处理过的资料", "No recently processed sources") : t("还没有导入资料", "No sources imported yet")}</h2>
          {!filtered && view === "pending" && list.counts.all > 0 && <p>{t("从已有资料中勾选来源，开始写文章。", "Select existing sources to start an article.")}</p>}
          {filtered ? <button className="secondary-button" onClick={resetFilters}>{t("清除筛选", "Clear filters")}</button> :
            view !== "trash" && (list.counts.all > 0 && view !== "all" ?
              <button className="secondary-button" onClick={() => switchView("all")}>{t("查看全部资料", "View all sources")}</button> :
              <button className="secondary-button" onClick={openImport}>{t("导入第一份资料", "Import your first source")}</button>)}
        </>}
      </div> :
        <div className="source-rows">{rows.map((item) => {
          const id = itemKey(item), card = cards[id], open = expanded === id;
          const hasAnalysis = !!card || !!item.analysisStatus;
          const job = latestJobs.find((entry) => entry.batchId === item.batchId && entry.captureId === item.captureId);
          const jobRunning = !!job && activeJob(job);
          const sourceFilings = filingJobs.filter((entry) => entry.batchId === item.batchId && entry.captureId === item.captureId);
          const latestFiling = sourceFilings.at(-1);
          const origin = item.originalUrl ? sourceDomain(item.originalUrl, t) : null;
          const filename = item.sourceFilename ?? t("未命名文件", "Unnamed file");
          return <article className="source-row" key={id}>
            <div className="source-row-main" onClick={(event) => {
              if (event.target instanceof Element && event.target.closest("button, a, input, label, select, textarea")) return;
              toggleExpanded(item);
            }}><div className="source-name"><label className="source-select-hit"><input type="checkbox" aria-label={t(`选择 ${item.title}`, `Select ${item.title}`)} checked={!!selected[id]} onChange={() => toggle(item)} /></label>
              <div><button className="source-title" aria-expanded={open} onClick={() => toggleExpanded(item)}>{item.title}</button>
                {item.originalUrl ? <div className="source-origin"><a href={item.originalUrl} title={item.originalUrl} target="_blank" rel="noreferrer">{t("原文链接", "Original link")}</a>
                  <span title={origin ?? undefined}>{origin}</span></div> :
                  <span className="local-source">{t(`本地文件 · ${filename}`, `Local file · ${filename}`)}</span>}</div></div>
              <time>{date(item.createdAt)}</time><span className={`tag ${item.status === "incomplete" || item.status === "failed" || latestFiling?.status === "needs_attention" ? "warning" : "success"}`}>{itemStatus(item, latestFiling, t)}</span>
              <span className={`tag source-analysis-state ${hasAnalysis ? "success" : "neutral"}`}>{jobRunning ? t("生成中", "Generating") : hasAnalysis ? t("已生成", "Generated") : t("未生成", "No summary")}</span>
              <div className="source-row-actions"><button className="text-button" onClick={() => toggleExpanded(item)}>{open ? t("收起", "Close") : t("查看", "View")}</button>
                {item.disposition === "trashed" ? <><button className="text-button" disabled={busy} onClick={() => void action("restore", [item])}>{t("恢复", "Restore")}</button>
                  <button className="text-button" disabled={busy} onClick={() => void action("purge", [item])}>{t("永久删除", "Delete permanently")}</button></> : <>
                  <button className="text-button" title={t("添加到知识库", "Add to vault")} disabled={busy || item.status === "processing"} onClick={() => openVaultEditor(item)}>{item.vaults?.length ? t("添加到知识库", "Add to vault") : t("入库", "File")}</button>
                  <button className="text-button" aria-label={hasAnalysis ? t("重新生成智能摘要", "Regenerate smart summary") : t("生成智能摘要", "Generate smart summary")} disabled={busy || jobRunning}
                    onClick={() => void queueAnalysis([item])}>{jobRunning ? t("生成中", "Generating") : t("智能摘要", "Smart summary")}</button>
                  {item.status !== "imported" && item.status !== "processing" && <button className="text-button" disabled={busy} onClick={() => void action(item.disposition === "shelved" ? "restore" : "shelve", [item])}>{item.disposition === "shelved" ? t("重新整理", "Move back to “To organize”") : t("搁置", "Shelve")}</button>}</>}</div></div>
            {open && <div className="source-detail"><section className="source-detail-section" aria-label={t("来源信息", "Source details")}><div className="source-detail-meta">
                <div><dt>{item.originalUrl ? t("抓取时间", "Captured") : t("导入时间", "Imported")}</dt><dd>{date(item.capturedAt)}</dd></div>
                <div><dt>{t("知识库", "Vaults")}</dt><dd>{item.vaults?.length ? item.vaults.map((entry) => entry.vaultId).join(splitList) : t("未入库", "Not filed")}</dd></div>
                <div><dt>{t("批次", "Batch")}</dt><dd>{item.batchId.slice(0, 8)}</dd></div>
                <div><dt>{t("文章署名", "Byline")}</dt><dd>{item.author ?? t("未发现", "Unknown")}</dd></div>
                <div><dt>{t("原文归属", "Authorship")}</dt><dd>{authorshipLabels[item.authorship]}</dd></div>
                <div><dt>{t("署名依据", "Byline evidence")}</dt><dd>{item.authorEvidence ? evidenceLabels[item.authorEvidence.kind] : t("无", "None")}</dd></div>
              </div><button className="text-button" onClick={() => openMetadataEditor(item)}>{t("修正来源信息", "Edit source details")}</button></section>
              {sourceFilings.length > 0 && <section className="source-detail-section"><h3>{t("入库记录", "Filing history")}</h3>{sourceFilings.map((filing) => <div className="source-maintenance" key={filing.id}>
                <strong>{t(`${filing.vaultId} 入库 ${filingLabels[filing.status]}`, `${filing.vaultId} filing · ${filingLabels[filing.status]}`)}</strong>
                {filing.startedAt && filing.status === "running" && <span>{t(`开始：${date(filing.startedAt)}`, `Started ${date(filing.startedAt)}`)}</span>}
                {filing.nextRetryAt && <span>{t(`下次重试：${date(filing.nextRetryAt)}`, `Next retry ${date(filing.nextRetryAt)}`)}</span>}
                {filing.errorCode && <span className="inline-message error">{errorText(new ApiError(409, filing.errorCode), "入库失败", "Filing failed")}</span>}
                {filing.status === "needs_attention" && <button className="text-button" onClick={() => void filingAction(filing.id, "inspect")}>{t("检查并恢复", "Inspect and resume")}</button>}
                {["queued", "retry_wait"].includes(filing.status) && <button className="text-button" onClick={() => void filingAction(filing.id, "cancel")}>{t("取消排队", "Cancel queued job")}</button>}
              </div>)}</section>}
              {(item.vaults ?? []).map((membership) => {
                const maintenance = maintenanceJobs.find((entry) => entry.vaultId === membership.vaultId && entry.fingerprint === membership.fingerprint);
                const vault = vaults?.vaults.find((entry) => entry.id === membership.vaultId);
                const label = maintenance ? maintenanceLabels[maintenance.status] : t("未运行", "Idle");
                return <section className="source-detail-section source-maintenance-section" key={`${membership.vaultId}:${membership.fingerprint}`}>
                  <div className="source-maintenance"><strong>{t(`${membership.vaultId} · 知识维护：${label}`, `${membership.vaultId} · Knowledge maintenance · ${label}`)}</strong>
                    {maintenance?.errorCode && <span className="inline-message error">{errorText(new ApiError(409, maintenance.errorCode), "知识维护失败", "Knowledge maintenance failed")}</span>}
                    {maintenance?.nextRetryAt && <span>{t(`下次重试：${date(maintenance.nextRetryAt)}`, `Next retry ${date(maintenance.nextRetryAt)}`)}</span>}
                    {(!maintenance || maintenance.status === "cancelled") &&
                      <button className="text-button" onClick={() => void startMaintenance(membership.vaultId, membership.fingerprint)}>{t("分析并编译", "Analyze and compile")}</button>}
                    {maintenance && ["failed", "blocked"].includes(maintenance.status) &&
                      <button className="text-button" onClick={() => void retryMaintenance(maintenance.id)}>{t("重试", "Retry")}</button>}
                    {maintenance && ["queued", "retry_wait", "blocked", "running"].includes(maintenance.status) &&
                      maintenance.stage !== "writing" &&
                      <button className="text-button" onClick={() => void cancelMaintenance(maintenance.id)}>{t("取消维护", "Cancel maintenance")}</button>}
                  </div>
                  {!!maintenance?.result?.files.length && <ul className="source-generated-files" aria-label={t("生成的知识文件", "Generated knowledge files")}>{maintenance.result.files.map((path) => <li key={path}>
                    <a href={`obsidian://open?path=${encodeURIComponent(`${vault?.path ?? ""}/${path}`)}`} title={path}>{path.split("/").at(-1)}</a><small>{path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : membership.vaultId}</small>
                  </li>)}</ul>}
                </section>;
              })}
              {item.warnings.length > 0 && <p className="inline-message">{t("预检提示：", "Import warnings · ")}{item.warnings.map((warning) => {
                if (warning === "content_too_short") return t("正文过短", "Source text is too short");
                if (warning === "paywall_preview") return t("付费内容预览", "Paywalled preview");
                return warning;
              }).join(splitList)}</p>}
              {item.errorCode && <p className="inline-message error">{t("处理失败：", "Processing failed · ")}
                {errorText(new ApiError(409, item.errorCode), item.errorCode, item.errorCode)}</p>}
              {job?.status === "failed" && <p className="inline-message error">{t("分析任务失败：", "Analysis failed · ")}
                {errorText(new ApiError(409, job.errorCode ?? "UNEXPECTED_ERROR"), "分析任务异常中断", "The analysis stopped unexpectedly")}
                {t("。可以重试。", ". You can retry.")}</p>}
              <div className={`source-detail-layout${card ? " has-card" : ""}`} data-pane={detailPane}>
                {card && <div className="source-detail-tabs" role="tablist" aria-label={t("资料详情内容", "Source detail views")}>
                  <button type="button" role="tab" aria-selected={detailPane === "original"} onClick={() => setDetailPane("original")}>{t("资料正文", "Source text")}</button>
                  <button type="button" role="tab" aria-selected={detailPane === "analysis"} onClick={() => setDetailPane("analysis")}>{t("智能摘要", "Smart summary")}</button>
                </div>}
                <section className="source-original" aria-label={t(`${item.title} 资料正文`, `Source text for ${item.title}`)}><strong>{t("资料正文", "Source text")}</strong>
                  <div className="markdown-body source-original-markdown"><KnowledgeMarkdown item={{ kind: "source", title: item.title, path: item.sourceFilename ?? item.title,
                    markdown: item.markdown, outlinks: [], issues: [], format: "markdown" }} onNavigate={() => undefined} onAnchor={() => undefined} /></div>
                  <details className="source-original-raw"><summary>{t("查看原始文本", "View raw text")}</summary><pre>{item.markdown}</pre></details></section>
                {card && <section className="analysis-card" aria-label={t(`${item.title} 智能摘要`, `Smart summary for ${item.title}`)}><div className="candidate-top"><strong>{t("智能摘要", "Smart summary")}</strong>
                <span className="tag success">{t("已分析", "Analyzed")}</span></div>
                <p>{card.summary}</p><ul>{card.mainPoints.map((point, index) => <li key={index}><strong>{point.claim}</strong><small>{point.kind === "article_statement" ? t("作者陈述", "Author statement") : point.kind === "inference" ? t("原文推断", "Inference") : t("未确定", "Uncertain")}</small>
                  {point.evidence.map((evidence, index2) => <div className="evidence" key={index2}>L{evidence.startLine}–L{evidence.endLine} · {evidence.excerpt}</div>)}</li>)}</ul>
                {card.limitations.length > 0 && <p>{t("局限：", "Limitations · ")}{card.limitations.join(t("；", " / "))}</p>}
                <p>{t("建议：", "Recommendation · ")}{recommendationLabels[card.recommendation]} · {card.reason}</p>
                <button className="secondary-button" disabled={busy || jobRunning} onClick={() => void queueAnalysis([item])}>{t("重新分析", "Analyze again")}</button></section>}
              </div>
              <div className="source-detail-actions">
                {item.status !== "imported" && item.status !== "processing" && item.disposition !== "trashed" && <button className="text-button" disabled={busy} onClick={() => void action("trash", [item])}>{t("移入回收站", "Move to trash")}</button>}</div></div>}
          </article>;
        })}</div>}
      {list && hasRows && <div className="source-pagination"><span>{t(`第 ${page} / ${pageCount} 页，共 ${total} 篇`, `Page ${page} of ${pageCount} · ${sourceCount(total)}`)}</span>
        <div><button className="text-button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>{t("上一页", "Previous")}</button>
          <button className="text-button" disabled={page * list.pageSize >= list.total} onClick={() => setPage((value) => value + 1)}>{t("下一页", "Next")}</button></div></div>}
    </section>
    {chosen.length > 0 && <div className="bulk-toolbar" role="toolbar" aria-label={t("批量资料操作", "Bulk source actions")}><strong>{t(`已选择 ${chosen.length} 篇`, `Selected ${sourceCount(chosen.length)}`)}</strong>
      {view !== "trash" && chosen.every(writingMaterial) && <button className="primary-button" disabled={busy || chosen.length > 30}
        title={chosen.length > 30 ? t("每篇文章最多选用 30 篇资料", "Up to 30 sources per article") : undefined} onClick={() => void startArticle(chosen)}>{t("用所选资料写文章", "Write article from selected sources")}</button>}
      {chosen.length < total && <button className="text-button bulk-select-all" disabled={busy} onClick={() => void selectAllResults()}>{t(`选择全部筛选结果（${total}）`, `Select all results (${total})`)}</button>}
      <WorkbenchSelect className="workbench-select-bulk" label={t("批量入库目标", "Destination vault")} title={targetVaultId} value={targetVaultId}
        onChange={setTargetVaultId} options={vaults?.vaults.map((vault) => ({ value: vault.id, label: vault.id })) ?? []} />
      <button className="secondary-button" disabled={busy || !fileable.length} onClick={() => void action("file", fileable)}>{t("批量入库", "File selected")}</button>
      <button className="secondary-button" disabled={busy || !chosen.some((item) => item.disposition !== "trashed")} onClick={() => void queueAnalysis(chosen.filter((item) => item.disposition !== "trashed"))}>{t("批量生成智能摘要", "Generate summaries for selected sources")}</button>
      {view === "trash" ? <><button className="secondary-button" disabled={busy} onClick={() => void action("restore", chosen)}>{t("恢复", "Restore")}</button>
        <button className="text-button" disabled={busy} onClick={() => void action("purge", chosen)}>{t("永久删除", "Delete permanently")}</button></> : <>
        <button className="secondary-button" disabled={busy || !shelvable.length} onClick={() => void action("shelve", shelvable)}>{t("搁置", "Shelve")}</button>
        <button className="text-button" disabled={busy || !trashable.length} onClick={() => void action("trash", trashable)}>{t("移入回收站", "Move to trash")}</button></>}
      <button className="text-button" onClick={() => setSelected({})}>{t("清除选择", "Clear selection")}</button></div>}
  </div>;
}
