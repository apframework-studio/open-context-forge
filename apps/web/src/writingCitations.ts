import type { Root } from "mdast";
interface Node { type: string; value?: string; url?: string; children?: Node[] }
export function writingCitations() {
  return (tree: Root) => {
    function visit(parent: Node) {
      if (!parent.children || parent.type === "link" || parent.type === "linkReference") return;
      parent.children = parent.children.flatMap((node): Node[] => {
        if (node.type !== "text" || !node.value) { visit(node); return [node]; }
        const result: Node[] = []; let cursor = 0;
        for (const match of node.value.matchAll(/\[(S\d+)\]/g)) {
          if (match.index > cursor) result.push({ type: "text", value: node.value.slice(cursor, match.index) });
          result.push({ type: "link", url: `#writing-source=${match[1]}`, children: [{ type: "text", value: `[${match[1]}]` }] });
          cursor = match.index + match[0].length;
        }
        if (!result.length) return [node];
        if (cursor < node.value.length) result.push({ type: "text", value: node.value.slice(cursor) });
        return result;
      });
    }
    visit(tree);
  };
}
