import { useMemo, useRef, useState } from "react";
import type { KnowledgeGraph as GraphData, KnowledgeItem } from "../api";

interface Props { graph: GraphData; onNode: (item: KnowledgeItem) => void; onFocus: (path: string) => void; onResetFocus: () => void }

export function KnowledgeGraph({ graph, onNode, onFocus, onResetFocus }: Props) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null);
  const points = useMemo(() => {
    const center = { x: 360, y: 260 };
    const count = Math.max(graph.nodes.length, 1);
    const radius = Math.min(205, Math.max(75, count * 10));
    return new Map(graph.nodes.map((item, index) => [item.path, {
      x: center.x + Math.cos((index * 2 * Math.PI) / count - Math.PI / 2) * radius,
      y: center.y + Math.sin((index * 2 * Math.PI) / count - Math.PI / 2) * radius,
    }]));
  }, [graph.nodes]);
  function reset() { setScale(1); setOffset({ x: 0, y: 0 }); onResetFocus(); }
  return <div className="knowledge-graph">
    <div className="knowledge-graph-controls"><button className="secondary-button" onClick={() => setScale((value) => Math.min(3, value + .2))}>放大</button>
      <button className="secondary-button" onClick={() => setScale((value) => Math.max(.45, value - .2))}>缩小</button>
      <button className="secondary-button" onClick={reset}>重置视野</button>
      <span>{graph.totalNodes} 个节点 · {graph.edges.length} 条可验证关系</span></div>
    {graph.nodes.length ? <svg className="knowledge-graph-canvas" viewBox="0 0 720 520" role="img" aria-label="知识库链接图谱"
      onWheel={(event) => { event.preventDefault(); setScale((value) => Math.max(.45, Math.min(3, value + (event.deltaY < 0 ? .12 : -.12)))); }}
      onPointerDown={(event) => { drag.current = { x: event.clientX, y: event.clientY, startX: offset.x, startY: offset.y }; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={(event) => { if (drag.current) setOffset({ x: drag.current.startX + event.clientX - drag.current.x,
        y: drag.current.startY + event.clientY - drag.current.y }); }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
      <g transform={`translate(${offset.x} ${offset.y}) translate(360 260) scale(${scale}) translate(-360 -260)`}>
        {graph.edges.map((edge, index) => {
          const from = points.get(edge.from); const to = points.get(edge.to);
          return from && to ? <line key={`${edge.from}:${edge.to}:${index}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y}
            stroke="#9dbddd" strokeWidth="1.7" /> : null;
        })}
        {graph.nodes.map((item) => { const point = points.get(item.path)!; return <g key={item.path} className="knowledge-graph-node"
          transform={`translate(${point.x} ${point.y})`} onClick={() => onNode(item)}>
          <circle r="17" fill={item.kind === "source" ? "#e0efff" : "#dff5ed"} stroke={item.kind === "source" ? "#2774bb" : "#29866a"} strokeWidth="2" />
          {item.analysisStatus && <circle cx="12" cy="-12" r="5" fill="#35a477" stroke="#fff" strokeWidth="1.5" />}
          <text textAnchor="middle" y="4" fontSize="12" fill="#255177">{item.kind === "source" ? "S" : "N"}</text>
          <text textAnchor="middle" y="34" fontSize="10" fill="#315374">{item.title.slice(0, 15)}</text>
        </g>; })}
      </g>
    </svg> : <p className="source-empty">该知识库还没有可绘制的内容。</p>}
    {graph.truncated && <p className="muted">图谱仅绘制前 120 个节点。可搜索或聚焦节点缩小范围。</p>}
    <div className="knowledge-graph-lists"><div><h3>节点</h3><div className="knowledge-graph-node-list">{graph.nodes.map((item) =>
      <div key={item.path}><button className="text-button" onClick={() => onNode(item)}>{item.title}{item.analysisStatus ? " · 有分析文件" : ""}</button>
        <button className="text-button" onClick={() => onFocus(item.path)}>聚焦相邻</button><small>{item.path}</small></div>)}</div></div>
      <div><h3>待检查链接 {graph.issues.length}</h3>{graph.issues.length ? graph.issues.map((issue, index) =>
        <p className="knowledge-issue" key={`${issue.from}:${issue.line}:${index}`}>{issue.from}:L{issue.line} → {issue.target} · {issue.reason === "ambiguous" ? "目标有歧义" : "目标不存在"}</p>) :
        <p className="muted">当前范围没有失效或有歧义的链接。</p>}</div></div>
  </div>;
}
