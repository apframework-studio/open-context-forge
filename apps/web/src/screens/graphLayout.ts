import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation,
  type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
import type { KnowledgeGraph, KnowledgeItem } from "../api";

export interface GraphPoint extends SimulationNodeDatum {
  id: string;
  item: KnowledgeItem;
  degree: number;
  radius: number;
  x: number;
  y: number;
}

export interface GraphEdge { from: string; to: string }
export interface GraphScene {
  nodes: GraphPoint[];
  points: Map<string, GraphPoint>;
  edges: GraphEdge[];
  neighbors: Map<string, Set<string>>;
  hubs: Set<string>;
  orphanCount: number;
}

export function layoutGraph(graph: KnowledgeGraph, width: number, height: number, showOrphans: boolean): GraphScene {
  const items = new Map(graph.nodes.map((item) => [item.path, item]));
  const neighbors = new Map(graph.nodes.map((item) => [item.path, new Set<string>()]));
  const unique = new Map<string, GraphEdge>();
  for (const edge of graph.edges) {
    if (edge.from === edge.to || !items.has(edge.from) || !items.has(edge.to)) continue;
    const [from, to] = [edge.from, edge.to].sort();
    const key = `${from}\u0000${to}`;
    if (!unique.has(key)) unique.set(key, { from, to });
    neighbors.get(from)!.add(to);
    neighbors.get(to)!.add(from);
  }
  const orphanCount = graph.nodes.filter((item) => neighbors.get(item.path)?.size === 0).length;
  const visible = graph.nodes.filter((item) => showOrphans || (neighbors.get(item.path)?.size ?? 0) > 0);
  const centerX = width / 2, centerY = height / 2;
  const nodes: GraphPoint[] = visible.map((item, index) => {
    const degree = neighbors.get(item.path)?.size ?? 0;
    const angle = index * 2.399963229728653;
    const spread = Math.sqrt(index) * 22;
    return { id: item.path, item, degree, radius: Math.min(12, 4 + Math.sqrt(degree) * 1.8),
      x: centerX + Math.cos(angle) * spread, y: centerY + Math.sin(angle) * spread };
  });
  const edges = [...unique.values()];
  if (nodes.length > 1) {
    const links: SimulationLinkDatum<GraphPoint>[] = edges.map((edge) => ({ source: edge.from, target: edge.to }));
    forceSimulation(nodes)
      .force("links", forceLink<GraphPoint, SimulationLinkDatum<GraphPoint>>(links).id((node) => node.id).distance(78))
      .force("repel", forceManyBody<GraphPoint>().strength((node) => -78 - Math.min(18, node.degree) * 2))
      .force("collide", forceCollide<GraphPoint>().radius((node) => node.radius + 5).strength(.9))
      .force("center", forceCenter(centerX, centerY))
      .stop().tick(160);
    const xs = nodes.map((node) => node.x), ys = nodes.map((node) => node.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const fit = Math.min(1, (width - 72) / Math.max(1, maxX - minX), (height - 72) / Math.max(1, maxY - minY));
    for (const node of nodes) {
      node.x = centerX + (node.x - (minX + maxX) / 2) * fit;
      node.y = centerY + (node.y - (minY + maxY) / 2) * fit;
      node.radius = Math.max(3, node.radius * fit);
    }
  }
  const points = new Map(nodes.map((node) => [node.id, node]));
  const averageDegree = nodes.reduce((sum, node) => sum + node.degree, 0) / Math.max(1, nodes.length);
  const variance = nodes.reduce((sum, node) => sum + (node.degree - averageDegree) ** 2, 0) / Math.max(1, nodes.length);
  const hubThreshold = Math.max(3, Math.ceil(averageDegree + Math.max(2, Math.sqrt(variance))));
  const hubs = new Set(nodes.filter((node) => node.degree >= hubThreshold)
    .sort((a, b) => b.degree - a.degree || a.item.title.localeCompare(b.item.title))
    .slice(0, 6).map((node) => node.id));
  return { nodes, points, edges, neighbors, hubs, orphanCount };
}
