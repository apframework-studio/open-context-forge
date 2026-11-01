import { expect, test } from "vitest";
import type { KnowledgeGraph, KnowledgeItem } from "../api";
import { layoutGraph } from "./graphLayout";

test("a uniformly connected network does not promote arbitrary nodes as hubs", () => {
  const nodes: KnowledgeItem[] = Array.from({ length: 20 }, (_, index) => ({
    vaultId: "v", path: `n${index}`, kind: "note", title: `Note ${index}`,
    modifiedAt: "2026-01-01T00:00:00Z", importedAt: null, fingerprint: null,
    originalUrl: null, analysisStatus: null, folder: "",
  }));
  const edges: KnowledgeGraph["edges"] = nodes.map((item, index) => ({
    from: item.path, to: nodes[(index + 1) % nodes.length].path, type: "wikilink", target: "next", line: 1,
  }));
  const scene = layoutGraph({ vaultId: "v", nodes, edges, totalNodes: 20, truncated: false, issues: [] }, 960, 560, true);
  expect(scene.hubs.size).toBe(0);
});
