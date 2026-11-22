import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { WorkspaceArea } from "@ocf/contracts";
import { api, type AttentionItem, type AttentionSummary, type BrandingStatus, type VaultList } from "./api";
import { AttentionCenter } from "./AttentionCenter";
import "./attention.css";
import { ImportScreen } from "./screens/ImportScreen";
import { VaultScreen } from "./screens/VaultScreen";
import { VaultSettingsScreen } from "./screens/VaultSettingsScreen";
import { ArticleScreen } from "./screens/ArticleScreen";
import { PublishCenterScreen } from "./screens/PublishCenterScreen";
import { WorkspaceIcon } from "./WorkspaceIcon";
import { useLocale, type LocalizedError } from "./locale";
import "./locale.css";

const areas: { name: WorkspaceArea; english: string; icon: "sources" | "vault" | "article" | "publish" }[] = [
  { name: "资料与分析", english: "Sources", icon: "sources" },
  { name: "知识库", english: "Knowledge Base", icon: "vault" },
  { name: "文章工作台", english: "Articles", icon: "article" },
  { name: "导出文章", english: "Export", icon: "publish" }
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

function readRoute() {
  const [route, id] = window.location.hash.slice(1).split("/");
  const routeAreas: Record<string, WorkspaceArea | "设置"> = {
    sources: "资料与分析", articles: "文章工作台", publish: "导出文章", knowledge: "知识库", settings: "设置",
  };
  return { area: routeAreas[route] ?? "资料与分析", articleId: route === "articles" && id ? decodeURIComponent(id) : null,
    publishArticleId: route === "publish" && id ? decodeURIComponent(id) : null };
}

export function App() {
  const { locale, setLocale, t, errorText } = useLocale();
  const [initialRoute] = useState(readRoute);
  const [area, setArea] = useState<WorkspaceArea | "设置">(initialRoute.area);
  const [settingsSection, setSettingsSection] = useState<"capture" | "vaults" | null>(null);
  const [vaults, setVaults] = useState<VaultList | null>(null);
  const [branding, setBranding] = useState<BrandingStatus>({ customized: false, revision: null });
  const [articleId, setArticleId] = useState<string | null>(() => initialRoute.articleId ?? localStorage.getItem("ocf-last-article"));
  const [publishFocusId, setPublishFocusId] = useState<string | null>(initialRoute.publishArticleId);
  const [loadError, setLoadError] = useState<LocalizedError | null>(null);
  const [navCollapsed, setNavCollapsed] = useState(() => layoutPreference("ocf-nav-collapsed"));
  const [darkTheme, setDarkTheme] = useState(() => layoutPreference("ocf-dark-theme"));
  const [attention, setAttention] = useState<AttentionSummary | null>(null);
  const [attentionOpen, setAttentionOpen] = useState(false);
  const attentionTrigger = useRef<HTMLButtonElement>(null);
  const attentionPanel = useRef<HTMLDivElement>(null);
  const [reminderVisible, setReminderVisible] = useState(false);
  const [attentionMessage, setAttentionMessage] = useState<LocalizedError | null>(null);
  const areaLabel = t(area, areas.find((item) => item.name === area)?.english ?? "Settings");
  const brandTitle = t("文脉引擎", "Wenmai");
  const navigationToggle = navCollapsed ? t("展开导航", "Expand navigation") : t("收起导航", "Collapse navigation");
  const languageToggle = t("切换到英语", "Switch to Chinese");

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = darkTheme ? "dark" : "light";
  }, [darkTheme]);

  function selectTheme(dark: boolean) {
    setDarkTheme(dark);
    saveLayoutPreference("ocf-dark-theme", dark);
  }

  function navigate(area: WorkspaceArea | "设置") {
    setArea(area);
    if (area === "导出文章") setPublishFocusId(null);
    const routes: Partial<Record<WorkspaceArea, string>> = { "资料与分析": "sources", "文章工作台": "articles", "导出文章": "publish", "知识库": "knowledge" };
    const route = area === "设置" ? "settings" : routes[area] ?? "settings";
    const hash = area === "文章工作台" && articleId ? `#articles/${encodeURIComponent(articleId)}` : `#${route}`;
    if (window.location.hash !== hash) window.history.pushState(null, "", hash);
  }

  useEffect(() => {
    const syncRoute = () => {
      const route = readRoute();
      setArea(route.area);
      setPublishFocusId(route.publishArticleId);
      if (route.articleId) {
        setArticleId(route.articleId);
        localStorage.setItem("ocf-last-article", route.articleId);
      }
    };
    window.addEventListener("popstate", syncRoute);
    window.addEventListener("hashchange", syncRoute);
    return () => {
      window.removeEventListener("popstate", syncRoute);
      window.removeEventListener("hashchange", syncRoute);
    };
  }, []);

  useEffect(() => {
    const route = area === "文章工作台" ? "articles" : area === "导出文章" ? "publish" : area === "知识库" ? "knowledge" : area === "资料与分析" ? "sources" : "settings";
    const hash = area === "文章工作台" && articleId ? `#articles/${encodeURIComponent(articleId)}` :
      area === "导出文章" && publishFocusId ? `#publish/${encodeURIComponent(publishFocusId)}` : `#${route}`;
    if (window.location.hash !== hash) window.history.replaceState(null, "", hash);
  }, [area, articleId, publishFocusId]);

  async function refreshVaults() {
    try { setVaults(await api<VaultList>("/vaults")); setLoadError(null); }
    catch (error) { setLoadError([error, "无法连接本机服务", "Could not reach the local service."]); }
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
    navigate("资料与分析");
  }

  async function actOnAttention(item: AttentionItem,
    action?: "retry" | "inspect" | "keep_raw" | "resolve_metadata") {
    setAttentionMessage(null);
    const id = item.id.split(":").slice(1).join(":");
    const path = item.kind === "filing" ? `/imports/filing-jobs/${encodeURIComponent(id)}/inspect` :
      item.kind === "maintenance" ? `/maintenance/jobs/${encodeURIComponent(id)}/${action === "inspect" ? "inspect" :
        action === "keep_raw" ? "resolve" : action === "resolve_metadata" ? "metadata-sync/resolve" : "retry"}` :
        item.id === "lane:filing" ? "/imports/filing-lane/resume" : "/maintenance/lane/resume";
    const body = action === "keep_raw" ? { decision: "keep_raw_only" } :
      action === "resolve_metadata" ? { confirmed: true } : undefined;
    try { await api(path, { method: "POST", body }); await refreshAttention(); }
    catch (error) { setAttentionMessage([error, "处理任务失败", "Could not complete the action."]); }
  }

  const iconUrl = branding.customized ? `/api/v1/branding/icon?v=${encodeURIComponent(branding.revision ?? "")}` : "/app-icon-192.png?v=2";
  useEffect(() => {
    document.title = brandTitle;
    const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (favicon) favicon.href = branding.customized ? iconUrl : "/favicon-32x32.png?v=2";
    const touchIcon = document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]');
    if (touchIcon) touchIcon.href = branding.customized ? iconUrl : "/apple-touch-icon.png?v=2";
  }, [branding.customized, iconUrl, brandTitle]);

  function selectedArticle(id: string) {
    setArticleId(id);
    localStorage.setItem("ocf-last-article", id);
  }
  function openNewArticle(id: string) {
    selectedArticle(id);
    window.history.pushState(null, "", `#articles/${encodeURIComponent(id)}`);
    setArea("文章工作台");
  }
  function articlesRemoved(ids: string[]) {
    if (!articleId || !ids.includes(articleId)) return;
    setArticleId(null);
    localStorage.removeItem("ocf-last-article");
    sessionStorage.setItem("ocf-article-page", "list");
  }

  function toggleNavigation() {
    setNavCollapsed((current) => { saveLayoutPreference("ocf-nav-collapsed", !current); return !current; });
  }

  function openSettings(section: "capture" | "vaults" | null) {
    setSettingsSection(section);
    navigate("设置");
  }

  return (
    <div className={`shell${navCollapsed ? " nav-collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="sidebar-top">
          <div className="brand"><span className="brand-mark" data-customized={branding.customized}><img className="brand-image" src={iconUrl} alt="" /></span><span className="brand-copy">{brandTitle}<small>{t("个人知识创作工作台", "Research and writing")}</small></span></div>
          <button className="chrome-button sidebar-toggle" type="button" onClick={toggleNavigation}
            aria-label={navigationToggle} aria-expanded={!navCollapsed} aria-controls="workflow-nav"
            title={navigationToggle}>
            <WorkspaceIcon name={navCollapsed ? "chevronRight" : "chevronLeft"} size={17} />
          </button>
        </div>
        <p className="sidebar-label">{t("工作流程", "Workflow")}</p>
        <nav id="workflow-nav" aria-label={t("工作流程", "Workflow")}>
          {areas.filter((item) => item.name !== "知识库").map((item) => (
            <button key={item.name} className={`nav-item ${area === item.name ? "active" : ""}`} type="button"
              onClick={() => navigate(item.name)} aria-label={t(item.name, item.english)} title={t(item.name, item.english)}
              aria-current={area === item.name ? "page" : undefined}>
              <span className="nav-icon"><WorkspaceIcon name={item.icon} /></span>
              <span className="nav-text">{t(item.name, item.english)}</span>
            </button>
          ))}
        </nav>
        <p className="sidebar-label knowledge-nav-label">{t("工作区", "Workspace")}</p>
        <button className={`nav-item knowledge-settings-nav ${area === "知识库" ? "active" : ""}`} type="button"
          onClick={() => navigate("知识库")} aria-label={t("知识库", "Knowledge Base")} title={t("知识库", "Knowledge Base")} aria-current={area === "知识库" ? "page" : undefined}>
          <span className="nav-icon"><WorkspaceIcon name="vault" /></span><span className="nav-text">{t("知识库", "Knowledge Base")}</span>
        </button>
        <button className={`nav-item knowledge-settings-nav ${area === "设置" ? "active" : ""}`} type="button"
          onClick={() => openSettings(null)} aria-label={t("设置", "Settings")} title={t("设置", "Settings")} aria-current={area === "设置" ? "page" : undefined}>
          <span className="nav-icon"><WorkspaceIcon name="settings" /></span><span className="nav-text">{t("设置", "Settings")}</span>
        </button>
        <div className="sidebar-foot">{t("本机工作区", "Local workspace")}</div>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <div className="topbar-location"><strong>{areaLabel}</strong></div>
          <div className="topbar-actions">
            <button ref={attentionTrigger} className="text-button attention-trigger" aria-label={t("需处理事项", "Tasks that need attention")} aria-expanded={attentionOpen}
              onClick={() => setAttentionOpen((value) => !value)}>{t("需处理", "Tasks")} {attention?.count ?? 0}</button>
            <span className="local-indicator"><i /> {t("本机运行", "Running locally")}</span>
            <div className="workspace-theme-switch" role="group" aria-label={t("界面配色", "Theme")}>
              <button type="button" aria-pressed={!darkTheme} onClick={() => selectTheme(false)}>{t("浅色", "Light")}</button>
              <button type="button" aria-pressed={darkTheme} onClick={() => selectTheme(true)}>{t("深色", "Dark")}</button>
            </div>
            <button type="button" className="chrome-button workspace-language-toggle" aria-label={languageToggle} title={languageToggle}
              onClick={() => setLocale(locale === "en" ? "zh-CN" : "en")}><span aria-hidden="true">{t("EN", "中")}</span></button>
          </div>
        </header>
        {reminderVisible && <div className="attention-reminder" role="status"><span>{t("有超过 24 小时未处理的入库或知识维护任务。", "A filing or maintenance task has been waiting more than 24 hours.")}</span>
          <button className="text-button" onClick={() => { setAttentionOpen(true); void dismissReminder(); }}>{t("查看", "View")}</button>
          <button className="text-button" onClick={() => void dismissReminder()}>{t("今天不再提醒", "Dismiss for today")}</button></div>}
        {attentionOpen && attention && <div ref={attentionPanel}><AttentionCenter summary={attention} onAction={(item, action) => void actOnAttention(item, action)}
          onOpenSource={openAttentionSource} /></div>}
        {attentionMessage && <p className="inline-message error" role="alert">{errorText(...attentionMessage)}</p>}
        <div className={`page${area === "资料与分析" ? " page-sources" : ""}${area === "文章工作台" ? " page-article" : ""}${area === "知识库" ? " page-knowledge" : ""}`}>
          {(area === "设置" || area === "导出文章") && <h1>{areaLabel}</h1>}
          {loadError && <p className="inline-message error" role="alert">{errorText(...loadError)}</p>}
          {area === "资料与分析" && <ImportScreen vaults={vaults} onOpenArticle={openNewArticle} onCaptureSettings={() => openSettings("capture")} />}
          {area === "知识库" && <VaultScreen vaults={vaults} onSettings={() => openSettings("vaults")} />}
          {area === "设置" && <VaultSettingsScreen vaults={vaults} refresh={refreshVaults} focusSection={settingsSection}
            branding={branding} iconUrl={iconUrl} onBrandingChange={setBranding} />}
          {area === "文章工作台" && <ArticleScreen articleId={articleId} vaults={vaults} onArticle={selectedArticle}
            onOpenSources={() => navigate("资料与分析")} onArticlesRemoved={articlesRemoved}
            onOpenExport={(id) => { selectedArticle(id); setPublishFocusId(id); setArea("导出文章"); }} />}
          {area === "导出文章" && <PublishCenterScreen focusArticleId={publishFocusId}
            onFocusChange={setPublishFocusId} onOpenArticles={(id) => {
              if (id) { selectedArticle(id); setArea("文章工作台"); }
              else navigate("文章工作台");
            }} />}
        </div>
      </main>
    </div>
  );
}
