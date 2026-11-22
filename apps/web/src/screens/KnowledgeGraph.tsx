import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { KnowledgeGraph as GraphData, KnowledgeItem } from "../api";
import { useLocale } from "../locale";
import { layoutGraph } from "./graphLayout";

interface Props {
  graph: GraphData;
  title: string;
  tools: ReactNode;
  onNode: (item: KnowledgeItem) => void;
  onFocus: (path: string) => void;
  onResetFocus: () => void;
}
interface Drag { x: number; y: number; startX: number; startY: number }

export function KnowledgeGraph({ graph, title, tools, onNode, onFocus, onResetFocus }: Props) {
  const { t } = useLocale();
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [size, setSize] = useState({ width: 960, height: 560 });
  const [showOrphans, setShowOrphans] = useState(true);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const canvas = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  const moved = useRef(false);
  const scene = useMemo(() => layoutGraph(graph, size.width, size.height, showOrphans),
    [graph, size.width, size.height, showOrphans]);
  const duplicateTitles = useMemo(() => {
    const seen = new Set<string>(), duplicates = new Set<string>();
    for (const { item } of scene.nodes) {
      if (seen.has(item.title)) duplicates.add(item.title);
      else seen.add(item.title);
    }
    return duplicates;
  }, [scene]);

  useEffect(() => {
    const element = canvas.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const bounds = element.getBoundingClientRect();
      const width = Math.round(bounds.width), height = Math.round(bounds.height);
      if (width > 0 && height > 0) setSize((current) =>
        current.width === width && current.height === height ? current : { width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  function reset() {
    setScale(1); setOffset({ x: 0, y: 0 }); setActivePath(null); onResetFocus();
  }

  const nodeCount = scene.nodes.length === graph.totalNodes ? graph.totalNodes : `${scene.nodes.length}/${graph.totalNodes}`;

  return <div className="knowledge-graph">
    <div className="knowledge-graph-main">
      <div className="knowledge-graph-controls">
        <strong>{title}</strong>
        <div className="knowledge-graph-zoom">
          <button className="secondary-button" onClick={() => setScale((value) => Math.min(3, value + .2))}>{t("放大", "Zoom in")}</button>
          <button className="secondary-button" onClick={() => setScale((value) => Math.max(.5, value - .2))}>{t("缩小", "Zoom out")}</button>
          <button className="secondary-button" onClick={reset}>{t("重置视野", "Reset view")}</button>
        </div>
        <button className="secondary-button knowledge-graph-tools-toggle" aria-expanded={toolsOpen}
          aria-controls="knowledge-graph-tools" onClick={() => setToolsOpen((open) => !open)}>{t("图谱工具", "Graph tools")}</button>
      </div>
    <svg ref={canvas} className="knowledge-graph-canvas" viewBox={`0 0 ${size.width} ${size.height}`}
      role="group" aria-label={t("知识库链接图谱", "Knowledge link graph")}
      onWheel={(event) => { event.preventDefault(); setScale((value) => Math.max(.5, Math.min(3, value + (event.deltaY < 0 ? .12 : -.12)))); }}
      onPointerDown={(event) => {
        moved.current = false;
        if (event.button !== 0 || (event.target instanceof Element && event.target.closest(".knowledge-graph-node"))) return;
        drag.current = { x: event.clientX, y: event.clientY, startX: offset.x, startY: offset.y };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        const dx = event.clientX - drag.current.x, dy = event.clientY - drag.current.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) moved.current = true;
        setOffset({ x: drag.current.startX + dx, y: drag.current.startY + dy });
      }}
      onPointerUp={() => { drag.current = null; }}
      onPointerCancel={() => { drag.current = null; }}>
      <g transform={`translate(${offset.x} ${offset.y}) translate(${size.width / 2} ${size.height / 2}) scale(${scale}) translate(${-size.width / 2} ${-size.height / 2})`}>
        {scene.edges.map((edge) => {
          const from = scene.points.get(edge.from), to = scene.points.get(edge.to);
          const highlighted = !!activePath && (edge.from === activePath || edge.to === activePath);
          return from && to ? <line key={`${edge.from}:${edge.to}`} className={activePath ? highlighted ? "is-highlighted" : "is-dimmed" : ""}
            x1={from.x} y1={from.y} x2={to.x} y2={to.y} /> : null;
        })}
        {scene.nodes.map((node) => {
          const item = node.item;
          const adjacent = !!activePath && (activePath === node.id || !!scene.neighbors.get(activePath)?.has(node.id));
          const dimmed = !!activePath && !adjacent;
          const label = !dimmed && (activePath === node.id || scene.nodes.length <= 12 || scene.hubs.has(node.id));
          return <g key={node.id} className={`knowledge-graph-node ${item.kind}${dimmed ? " is-dimmed" : ""}${adjacent ? " is-highlighted" : ""}`}
            transform={`translate(${node.x} ${node.y})`} role="button" tabIndex={0} aria-label={item.title}
            onPointerEnter={() => setActivePath(node.id)} onPointerLeave={() => setActivePath(null)}
            onFocus={() => setActivePath(node.id)} onBlur={() => setActivePath(null)}
            onClick={() => { if (!moved.current) onNode(item); }}
            onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onNode(item); } }}>
            <title>{item.title}</title>
            <circle className="knowledge-graph-hit" r={Math.max(14, node.radius + 7)} />
            <circle className="knowledge-graph-dot" r={node.radius} />
            {item.analysisStatus && <circle className="knowledge-graph-analysis-dot" cx={node.radius * .7} cy={-node.radius * .7} r="2.5" />}
            {label && <text className="knowledge-graph-label" textAnchor="middle" transform={`scale(${1 / scale})`}
              y={-(node.radius * scale + 8)}>{item.title.length > 24 ? `${item.title.slice(0, 24)}…` : item.title}</text>}
          </g>;
        })}
      </g>
      {scene.nodes.length === 0 && <text className="knowledge-graph-empty" x={size.width / 2} y={size.height / 2} textAnchor="middle">
        {graph.nodes.length ? t("当前只剩孤立节点；可重新显示。", "Show isolated nodes to see this graph.") :
          t("该知识库还没有可绘制的内容。", "There are no nodes in this vault yet.")}</text>}
    </svg>
      <div className="knowledge-graph-foot">
        <div className="knowledge-graph-legend"><span><i className="source" />{t("来源", "Sources")}</span><span><i className="note" />{t("笔记", "Notes")}</span></div>
        <span>{t(`${nodeCount} 个节点 · ${graph.edges.length} 条可验证关系`,
          `${nodeCount} ${nodeCount === 1 ? "node" : "nodes"} · ${graph.edges.length} verified ${graph.edges.length === 1 ? "link" : "links"}`)}</span>
      </div>
    </div>
    <aside id="knowledge-graph-tools" className={`knowledge-graph-sidebar${toolsOpen ? " is-open" : ""}`} aria-label={t("图谱工具", "Graph tools")}>
      <div className="knowledge-graph-sidebar-head"><h3>{t("图谱工具", "Graph tools")}</h3>
        <button className="text-button" aria-label={t("关闭图谱工具", "Close graph tools")} onClick={() => setToolsOpen(false)}>{t("收起", "Close")}</button></div>
      <div className="knowledge-graph-sidebar-controls">{tools}
        <button className="text-button knowledge-graph-orphans" disabled={!scene.orphanCount}
          onClick={() => { setShowOrphans((value) => !value); setActivePath(null); }}>
          {showOrphans ? t("隐藏孤立节点", "Hide isolated nodes") : t("显示孤立节点", "Show isolated nodes")}{scene.orphanCount ? ` · ${scene.orphanCount}` : ""}
        </button>
      </div>
      <section className="knowledge-graph-node-section"><h3>{t("节点", "Nodes")} <small>{scene.nodes.length}</small></h3>
        {graph.truncated && <p className="muted">{t(`当前显示 ${graph.nodes.length}/${graph.totalNodes} 个节点。可搜索或聚焦节点缩小范围。`,
          `Showing ${graph.nodes.length} of ${graph.totalNodes} nodes. Search or focus a node to narrow the graph.`)}</p>}
        <div className="knowledge-graph-node-list">{scene.nodes.map(({ item }) =>
          <div key={item.path}><button className="text-button" aria-label={duplicateTitles.has(item.title) ? t(`阅读 ${item.title} · ${item.path}`, `Read ${item.title} · ${item.path}`) : undefined}
              onClick={() => onNode(item)}>{item.title}{item.analysisStatus ? t(" · 有分析文件", " · Analysis available") : ""}</button>
            <button className="text-button" aria-label={t(`聚焦 ${item.title} · ${item.path} 的相邻节点`, `Focus neighbors of ${item.title} · ${item.path}`)}
              onClick={() => onFocus(item.path)}>{t("聚焦相邻", "Focus neighbors")}</button>
            {duplicateTitles.has(item.title) && <small title={item.path}>{item.path}</small>}</div>)}</div>
      </section>
      <details className="knowledge-graph-issues"><summary>{t("待检查链接", "Links to review")} {graph.issues.length}</summary><div>{graph.issues.length ? graph.issues.map((issue, index) =>
        <p className="knowledge-issue" key={`${issue.from}:${issue.line}:${index}`}>{issue.from}:L{issue.line} → {issue.target} · {issue.reason === "ambiguous" ?
          t("目标有歧义", "Ambiguous target") : t("目标不存在", "Missing target")}</p>) :
        <p className="muted">{t("当前范围没有失效或有歧义的链接。", "There are no broken or ambiguous links in this view.")}</p>}</div></details>
    </aside>
  </div>;
}
