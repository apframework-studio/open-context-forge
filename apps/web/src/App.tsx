import { useEffect, useState } from "react";
import type { WorkspaceArea } from "@ocf/contracts";
import { api, type BrandingStatus, type SourceRef, type VaultList } from "./api";
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
  const current = areas.find((item) => item.name === area) ?? { name: "设置", number: "", description: "管理知识库连接和本机工作区。" };

  async function refreshVaults() {
    try { setVaults(await api<VaultList>("/vaults")); setLoadError(""); }
    catch (error) { setLoadError(error instanceof Error ? error.message : "无法连接本机服务"); }
  }

  useEffect(() => {
    void refreshVaults();
    void api<BrandingStatus>("/branding").then(setBranding).catch(() => undefined);
  }, []);

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
            <span className="local-indicator"><i /> 本机运行</span>
          </div>
        </header>
        <div className={`page${area === "资料与分析" ? " page-sources" : ""}${area === "文章工作台" ? " page-article" : ""}${area === "知识库" ? " page-knowledge" : ""}`}>
          <div className="eyebrow">{area === "知识库" ? "WORKSPACE / KNOWLEDGE" : current.number ? `${current.number} / WORKFLOW` : "WORKSPACE / SETTINGS"}</div>
          {area !== "资料与分析" && <><h1>{current.name}</h1><p className="lead">{current.description}</p></>}
          {loadError && <p className="inline-message error" role="alert">{loadError}</p>}
          {area === "资料与分析" && <ImportScreen vaults={vaults} onImported={imported} onCaptureSettings={() => openSettings("capture")} />}
          {area === "知识库" && <VaultScreen vaults={vaults} onSettings={() => openSettings("vaults")} />}
          {area === "设置" && <VaultSettingsScreen vaults={vaults} refresh={refreshVaults} focusSection={settingsSection}
            branding={branding} iconUrl={iconUrl} onBrandingChange={setBranding} />}
          {area === "文章工作台" && <ArticleScreen sourceRef={sourceRef} articleId={articleId} onArticle={selectedArticle}
            onOpenSources={() => setArea("资料与分析")} />}
          {area === "预览与发布" && <PublishScreen articleId={articleId} publicationId={publicationId} onPublication={selectedPublication}
            onOpenArticles={() => setArea("文章工作台")} />}
        </div>
      </main>
    </div>
  );
}
