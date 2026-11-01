import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { KnowledgeGraph as GraphData, KnowledgeItem } from "../api";
import { KnowledgeGraph } from "./KnowledgeGraph";

function note(path: string): KnowledgeItem {
  return { vaultId: "v", path, kind: "note", title: path, modifiedAt: "2026-01-01T00:00:00Z",
    importedAt: null, fingerprint: null, originalUrl: null, analysisStatus: null, folder: "" };
}

test("graph draws one visible line for repeated links while retaining the verified link count", () => {
  const graph: GraphData = { vaultId: "v", nodes: [note("A"), note("B")], totalNodes: 2, truncated: false, issues: [],
    edges: [
      { from: "A", to: "B", type: "wikilink", target: "B", line: 1 },
      { from: "A", to: "B", type: "wikilink", target: "B", line: 2 },
    ] };
  const html = renderToStaticMarkup(createElement(KnowledgeGraph, {
    graph, title: "知识图谱", tools: null, onNode: () => undefined, onFocus: () => undefined, onResetFocus: () => undefined,
  }));
  const canvas = html.match(/<svg\b[\s\S]*?<\/svg>/)?.[0] ?? "";
  expect(canvas.match(/<line\b/g)).toHaveLength(1);
  expect(html).toContain("2 条可验证关系");
});

test("global graph does not print every node title at the starting zoom", () => {
  const graph: GraphData = { vaultId: "v", nodes: Array.from({ length: 30 }, (_, index) => note(`Note ${index}`)),
    totalNodes: 30, truncated: false, issues: [], edges: [] };
  const html = renderToStaticMarkup(createElement(KnowledgeGraph, {
    graph, title: "知识图谱", tools: null, onNode: () => undefined, onFocus: () => undefined, onResetFocus: () => undefined,
  }));
  const canvas = html.match(/<svg\b[\s\S]*?<\/svg>/)?.[0] ?? "";
  expect((canvas.match(/<text\b/g) ?? []).length).toBeLessThan(10);
});

test("sidebar distinguishes notes that have the same title", () => {
  const graph: GraphData = { vaultId: "v", nodes: [
    { ...note("Folder/One.md"), title: "Shared" },
    { ...note("Folder/Two.md"), title: "Shared" },
  ], totalNodes: 2, truncated: false, issues: [], edges: [] };
  const html = renderToStaticMarkup(createElement(KnowledgeGraph, {
    graph, title: "知识图谱", tools: null, onNode: () => undefined, onFocus: () => undefined, onResetFocus: () => undefined,
  }));
  const sidebar = html.match(/<aside\b[\s\S]*?<\/aside>/)?.[0] ?? "";
  expect(sidebar).toContain("Folder/One.md");
  expect(sidebar).toContain("Folder/Two.md");
});
