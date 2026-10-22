import { useState } from "react";
import type { WorkspaceArea } from "@ocf/contracts";

const areas: { name: WorkspaceArea; number: string; description: string }[] = [
  { name: "资料与分析", number: "01", description: "导入资料、检查来源，形成可回查的分析。" },
  { name: "知识库", number: "02", description: "管理内置与外部 vault，整理长期知识。" },
  { name: "文章工作台", number: "03", description: "把证据写成文章，逐步审稿与定稿。" },
  { name: "预览与发布", number: "04", description: "本地检查渠道效果，再确认发布。" },
];

export function App() {
  const [area, setArea] = useState<WorkspaceArea>("资料与分析");
  const current = areas.find((item) => item.name === area)!;

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
          <section className="empty-state" aria-label={`${area}内容`}>
            <span className="empty-icon">{current.number}</span>
            <h2>从这里开始</h2>
            <p>此区域将在接入实际资料和项目后显示内容。</p>
          </section>
        </div>
      </main>
      <aside className="context-panel">
        <div className="panel-head"><span className="panel-dot" />协作上下文</div>
        <div className="context-empty"><div className="context-lines"><span /><span /><span /></div><strong>等待选择工作内容</strong><p>选择一份资料或文章后，这里会显示相关上下文与讨论。</p></div>
      </aside>
    </div>
  );
}
