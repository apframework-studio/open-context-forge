import { useEffect, useRef, useState } from "react";
import type { WorkspaceArea } from "@ocf/contracts";
import { api, type AttentionItem, type AttentionSummary, type BrandingStatus, type SourceRef, type VaultList } from "./api";
import { AttentionCenter } from "./AttentionCenter";
import "./attention.css";
import { ImportScreen } from "./screens/ImportScreen";
import { VaultScreen } from "./screens/VaultScreen";
import { VaultSettingsScreen } from "./screens/VaultSettingsScreen";
import { ArticleScreen } from "./screens/ArticleScreen";
import { PublishScreen } from "./screens/PublishScreen";
import { WorkspaceIcon } from "./WorkspaceIcon";

const areas: { name: WorkspaceArea; number: string; icon: "sources" | "vault" | "article" | "publish"; description: string }[] = [
  { name: "资料与分析", number: "01", icon: "sources", description: "导入资料、检查来源，形成可回查的分析。" },
  { name: "知识库", number: "02", icon: "vault", description: "浏览来源与原有笔记，搜索内容并探索真实链接。" },
  { name: "文章工作台", number: "03", icon: "article", description: "围绕证据与智能体讨论，起草、修订并定稿文章。" },
  { name: "预览与发布", number: "04", icon: "publish", description: "本地检查渠道效果，再确认发布。" },
];

function layoutPreference(key: string): boolean {
  try { return localStorage.getItem(key) === "1"; } catch { return false; }
}

function saveLayoutPreference(key: string, value: boolean): void {
  try { localStorage.setItem(key, value ? "1" : "0"); } catch { /* Layout still works without storage. */ }
}

function localDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function App() {
  const [area, setArea] = useState<WorkspaceArea | "设置">("资料与分析");
  const [settingsSection, setSettingsSection] = useState<"capture" | "vaults" | null>(null);
  const [vaults, setVaults] = useState<VaultList | null>(null);
  const [branding, setBranding] = useState<BrandingStatus>({ customized: false, revision: null });
  const [sourceRef, setSourceRef] = useState<SourceRef | null>(() => { try { return JSON.parse(localStorage.getItem("ocf-last-source") ?? "null"); } catch { return null; } });
  const [articleId, setArticleId] = useState<string | null>(() => localStorage.getItem("ocf-last-article"));
  const [publicationId, setPublicationId] = useState<string | null>(() => localStorage.getItem("ocf-last-publication"));
  const [loadError, setLoadError] = useState("");
  const [navCollapsed, setNavCollapsed] = useState(() => layoutPreference("ocf-nav-collapsed"));
  const [attention, setAttention] = useState<AttentionSummary | null>(null);
  const [attentionOpen, setAttentionOpen] = useState(false);
  const attentionTrigger = useRef<HTMLButtonElement>(null);
  const attentionPanel = useRef<HTMLDivElement>(null);
  const [reminderVisible, setReminderVisible] = useState(false);
  const [attentionMessage, setAttentionMessage] = useState("");
  const current = areas.find((item) => item.name === area) ?? { name: "设置", number: "", description: "管理知识库连接和本机工作区。" };

  async function refreshVaults() {
    try { setVaults(await api<VaultList>("/vaults")); setLoadError(""); }
    catch (error) { setLoadError(error instanceof Error ? error.message : "无法连接本机服务"); }
  }

  useEffect(() => {
    void refreshVaults();
    void api<BrandingStatus>("/branding").then(setBranding).catch(() => undefined);
  }, []);

  async function refreshAttention() {
    try {
      const summary = await api<AttentionSummary>(`/attention?localDate=${localDate()}`);
      setAttention(summary);
      if (summary.reminderDue) setReminderVisible(true);
    } catch { /* Other workflow pages remain available when task status cannot be read. */ }
  }
  useEffect(() => {
    void refreshAttention();
    const timer = window.setInterval(() => { void refreshAttention(); }, 30_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!attentionOpen) return;
    const outside = (target: EventTarget | null) => target instanceof Node &&
      !attentionTrigger.current?.contains(target) && !attentionPanel.current?.contains(target);
    const pointerDown = (event: PointerEvent) => { if (outside(event.target)) setAttentionOpen(false); };
    const focusIn = (event: FocusEvent) => { if (outside(event.target)) setAttentionOpen(false); };
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setAttentionOpen(false); attentionTrigger.current?.focus(); }
    };
    const blur = () => setAttentionOpen(false);
    document.addEventListener("pointerdown", pointerDown);
    document.addEventListener("focusin", focusIn);
    document.addEventListener("keydown", keyDown);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("pointerdown", pointerDown);
      document.removeEventListener("focusin", focusIn);
      document.removeEventListener("keydown", keyDown);
      window.removeEventListener("blur", blur);
    };
  }, [attentionOpen]);

  async function dismissReminder() {
    setReminderVisible(false);
    try { await api("/attention/reminder-seen", { method: "POST", body: { localDate: localDate() } }); }
    catch { /* The reminder may appear again on a later visit. */ }
    void refreshAttention();
  }

  function openAttentionSource(item: AttentionItem) {
    if (item.batchId && item.captureId) {
      try {
        sessionStorage.setItem("ocf-source-view", "all");
        sessionStorage.setItem("ocf-source-expanded", `${item.batchId}\u0000${item.captureId}`);
      } catch { /* Navigation still works without saved view state. */ }
    }
    setAttentionOpen(false);
    setArea("资料与分析");
  }

  async function actOnAttention(item: AttentionItem,
    action?: "retry" | "inspect" | "keep_raw" | "resolve_metadata") {
    setAttentionMessage("");
    const id = item.id.split(":").slice(1).join(":");
    const path = item.kind === "filing" ? `/imports/filing-jobs/${encodeURIComponent(id)}/inspect` :
      item.kind === "maintenance" ? `/maintenance/jobs/${encodeURIComponent(id)}/${action === "inspect" ? "inspect" :
        action === "keep_raw" ? "resolve" : action === "resolve_metadata" ? "metadata-sync/resolve" : "retry"}` :
        item.id === "lane:filing" ? "/imports/filing-lane/resume" : "/maintenance/lane/resume";
    const body = action === "keep_raw" ? { decision: "keep_raw_only" } :
      action === "resolve_metadata" ? { confirmed: true } : undefined;
    try { await api(path, { method: "POST", body }); await refreshAttention(); }
    catch (error) { setAttentionMessage(error instanceof Error ? error.message : "处理任务失败"); }
  }

  const iconUrl = branding.customized ? `/api/v1/branding/icon?v=${encodeURIComponent(branding.revision ?? "")}` : "/app-icon-192.png";
  useEffect(() => {
    document.title = "文脉引擎";
    const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (favicon) favicon.href = branding.customized ? iconUrl : "/favicon-32x32.png";
    const touchIcon = document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]');
    if (touchIcon) touchIcon.href = branding.customized ? iconUrl : "/apple-touch-icon.png";
  }, [branding.customized, iconUrl]);

  function imported(value: SourceRef) { setSourceRef(value); localStorage.setItem("ocf-last-source", JSON.stringify(value)); }
  function selectedArticle(id: string, existingPublicationId: string | null = null) {
    setArticleId(id);
    setPublicationId(existingPublicationId);
    localStorage.setItem("ocf-last-article", id);
    if (existingPublicationId) localStorage.setItem("ocf-last-publication", existingPublicationId);
    else localStorage.removeItem("ocf-last-publication");
  }
  function selectedPublication(id: string) { setPublicationId(id); localStorage.setItem("ocf-last-publication", id); }
  function articlesRemoved(ids: string[]) {
    if (!articleId || !ids.includes(articleId)) return;
    setArticleId(null); setPublicationId(null);
    localStorage.removeItem("ocf-last-article"); localStorage.removeItem("ocf-last-publication");
    sessionStorage.setItem("ocf-article-page", "list");
  }

  function toggleNavigation() {
    setNavCollapsed((current) => { saveLayoutPreference("ocf-nav-collapsed", !current); return !current; });
  }

  function openSettings(section: "capture" | "vaults" | null) {
    setSettingsSection(section);
    setArea("设置");
  }

  return (
    <div className={`shell${navCollapsed ? " nav-collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="sidebar-top">
          <div className="brand"><span className="brand-mark"><img className="brand-image" src={iconUrl} alt="" /></span><span className="brand-copy">文脉引擎<small>个人知识创作工作台</small></span></div>
          <button className="chrome-button sidebar-toggle" type="button" onClick={toggleNavigation}
            aria-label={navCollapsed ? "展开导航" : "收起导航"} aria-expanded={!navCollapsed} aria-controls="workflow-nav"
            title={navCollapsed ? "展开导航" : "收起导航"}>
            <WorkspaceIcon name={navCollapsed ? "chevronRight" : "chevronLeft"} size={17} />
          </button>
        </div>
        <p className="sidebar-label">工作流程</p>
        <nav id="workflow-nav" aria-label="工作流程">
          {areas.filter((item) => item.name !== "知识库").map((item) => (
            <button key={item.name} className={`nav-item ${area === item.name ? "active" : ""}`} type="button"
              onClick={() => setArea(item.name)} aria-label={item.name} title={item.name}
              aria-current={area === item.name ? "page" : undefined}>
              <span className="nav-icon"><WorkspaceIcon name={item.icon} /></span>
              <span className="nav-text">{item.name}</span><span className="nav-number">{item.number}</span>
              {item.name === "资料与分析" && !!attention?.count && <span className="attention-badge" aria-label={`${attention.count} 项待处理`}>{attention.count}</span>}
            </button>
          ))}
        </nav>
        <p className="sidebar-label knowledge-nav-label">工作区</p>
        <button className={`nav-item knowledge-settings-nav ${area === "知识库" ? "active" : ""}`} type="button"
          onClick={() => setArea("知识库")} aria-label="知识库" title="知识库" aria-current={area === "知识库" ? "page" : undefined}>
          <span className="nav-icon"><WorkspaceIcon name="vault" /></span><span className="nav-text">知识库</span>
        </button>
        <button className={`nav-item knowledge-settings-nav ${area === "设置" ? "active" : ""}`} type="button"
          onClick={() => openSettings(null)} aria-label="设置" title="设置" aria-current={area === "设置" ? "page" : undefined}>
          <span className="nav-icon">⚙</span><span className="nav-text">设置</span>
        </button>
        <div className="sidebar-foot">本机工作区 · 数据由你管理</div>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <div className="topbar-location"><span>工作台</span><span aria-hidden="true">/</span><strong>{current.name}</strong></div>
          <div className="topbar-actions">
            <button ref={attentionTrigger} className="text-button attention-trigger" aria-label="待处理事项" aria-expanded={attentionOpen}
              onClick={() => setAttentionOpen((value) => !value)}>待处理 {attention?.count ?? 0}</button>
            <span className="local-indicator"><i /> 本机运行</span>
          </div>
        </header>
        {reminderVisible && <div className="attention-reminder" role="status"><span>有超过 24 小时未处理的入库或知识维护任务。</span>
          <button className="text-button" onClick={() => { setAttentionOpen(true); void dismissReminder(); }}>查看</button>
          <button className="text-button" onClick={() => void dismissReminder()}>今天不再提醒</button></div>}
        {attentionOpen && attention && <div ref={attentionPanel}><AttentionCenter summary={attention} onAction={(item, action) => void actOnAttention(item, action)}
          onOpenSource={openAttentionSource} /></div>}
        {attentionMessage && <p className="inline-message error" role="alert">{attentionMessage}</p>}
        <div className={`page${area === "资料与分析" ? " page-sources" : ""}${area === "文章工作台" ? " page-article" : ""}${area === "知识库" ? " page-knowledge" : ""}`}>
          <div className="eyebrow">{area === "知识库" ? "WORKSPACE / KNOWLEDGE" : current.number ? `${current.number} / WORKFLOW` : "WORKSPACE / SETTINGS"}</div>
          {area !== "资料与分析" && area !== "文章工作台" && area !== "知识库" && <><h1>{current.name}</h1><p className="lead">{current.description}</p></>}
          {loadError && <p className="inline-message error" role="alert">{loadError}</p>}
          {area === "资料与分析" && <ImportScreen vaults={vaults} onImported={imported} onCaptureSettings={() => openSettings("capture")} />}
          {area === "知识库" && <VaultScreen vaults={vaults} onSettings={() => openSettings("vaults")} />}
          {area === "设置" && <VaultSettingsScreen vaults={vaults} refresh={refreshVaults} focusSection={settingsSection}
            branding={branding} iconUrl={iconUrl} onBrandingChange={setBranding} />}
          {area === "文章工作台" && <ArticleScreen sourceRef={sourceRef} articleId={articleId} vaults={vaults} onArticle={selectedArticle}
            onOpenSources={() => setArea("资料与分析")} onArticlesRemoved={articlesRemoved}
            onOpenPublish={(item) => { selectedArticle(item.id, item.publicationId); setArea("预览与发布"); }} />}
          {area === "预览与发布" && <PublishScreen articleId={articleId} publicationId={publicationId} onPublication={selectedPublication}
            onOpenArticles={() => setArea("文章工作台")} />}
        </div>
      </main>
    </div>
  );
}
