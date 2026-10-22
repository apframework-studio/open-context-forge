import { useEffect, useState } from "react";
import type { WorkspaceArea } from "@ocf/contracts";
import { api, type SourceRef, type VaultList } from "./api";
import { ImportScreen } from "./screens/ImportScreen";
import { VaultScreen } from "./screens/VaultScreen";
import { ArticleScreen } from "./screens/ArticleScreen";
import { PublishScreen } from "./screens/PublishScreen";

const areas: { name: WorkspaceArea; number: string; description: string }[] = [
  { name: "资料与分析", number: "01", description: "导入资料、检查来源，形成可回查的分析。" },
  { name: "知识库", number: "02", description: "管理内置与外部 vault，整理长期知识。" },
  { name: "文章工作台", number: "03", description: "把证据写成文章，逐步审稿与定稿。" },
  { name: "预览与发布", number: "04", description: "本地检查渠道效果，再确认发布。" },
];

export function App() {
  const [area, setArea] = useState<WorkspaceArea>("资料与分析");
  const [vaults, setVaults] = useState<VaultList | null>(null);
  const [sourceRef, setSourceRef] = useState<SourceRef | null>(() => { try { return JSON.parse(localStorage.getItem("ocf-last-source") ?? "null"); } catch { return null; } });
  const [articleId, setArticleId] = useState<string | null>(() => localStorage.getItem("ocf-last-article"));
  const [publicationId, setPublicationId] = useState<string | null>(() => localStorage.getItem("ocf-last-publication"));
  const [loadError, setLoadError] = useState("");
  const current = areas.find((item) => item.name === area)!;

  async function refreshVaults() {
    try { setVaults(await api<VaultList>("/vaults")); setLoadError(""); }
    catch (error) { setLoadError(error instanceof Error ? error.message : "无法连接本机服务"); }
  }

  useEffect(() => { void refreshVaults(); }, []);

  function imported(value: SourceRef) { setSourceRef(value); localStorage.setItem("ocf-last-source", JSON.stringify(value)); }
  function selectedArticle(id: string) { setArticleId(id); setPublicationId(null); localStorage.setItem("ocf-last-article", id); localStorage.removeItem("ocf-last-publication"); }
  function selectedPublication(id: string) { setPublicationId(id); localStorage.setItem("ocf-last-publication", id); }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">OCF</span><span>Open Context Forge<small>个人知识创作工作台</small></span></div>
        <p className="sidebar-label">工作流程</p>
        <nav aria-label="工作流程">
          {areas.map((item) => (
            <button key={item.name} className={`nav-item ${area === item.name ? "active" : ""}`} onClick={() => setArea(item.name)} aria-current={area === item.name ? "page" : undefined}>
              <span>{item.number}</span>{item.name}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">本机工作区 · 数据由你管理</div>
      </aside>
      <main className="workspace">
        <header className="topbar"><span>WORKSPACE / {current.number}</span><span className="local-indicator"><i /> 本机运行</span></header>
        <div className="page">
          <div className="eyebrow">{current.number} / WORKFLOW</div>
          <h1>{current.name}</h1>
          <p className="lead">{current.description}</p>
          {loadError && <p className="inline-message error" role="alert">{loadError}</p>}
          {area === "资料与分析" && <ImportScreen vaults={vaults} onImported={imported} />}
          {area === "知识库" && <VaultScreen vaults={vaults} refresh={refreshVaults} />}
          {area === "文章工作台" && <ArticleScreen sourceRef={sourceRef} articleId={articleId} onArticle={selectedArticle} />}
          {area === "预览与发布" && <PublishScreen articleId={articleId} publicationId={publicationId} onPublication={selectedPublication} />}
        </div>
      </main>
      <aside className="context-panel">
        <div className="panel-head"><span className="panel-dot" />协作上下文</div>
        <div className="context-empty"><div className="context-lines"><span /><span /><span /></div><strong>等待选择工作内容</strong><p>选择一份资料或文章后，这里会显示相关上下文与讨论。</p></div>
      </aside>
    </div>
  );
}
