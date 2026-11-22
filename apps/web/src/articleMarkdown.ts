import type { Root, RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

const parser = unified().use(remarkParse);
const visibleMarkdownParser = unified().use(remarkParse).use(remarkGfm);

export function manuscriptFromUnmarkedReply(markdown: string): string {
  const blocks = parser.parse(markdown).children;
  const firstTitle = blocks.findIndex((block) => block.type === "heading" && block.depth === 1);
  if (firstTitle < 1 || blocks.slice(0, firstTitle).some((block) => block.type !== "paragraph")) return markdown;
  const offset = blocks[firstTitle].position?.start.offset;
  return offset === undefined ? markdown : markdown.slice(offset);
}

function visibleText(node: Root | RootContent): string {
  if (node.type === "text" || node.type === "inlineCode" || node.type === "code") return node.value;
  if (node.type === "image" || node.type === "imageReference") return node.alt ?? "";
  if (node.type === "break") return " ";
  return "children" in node ? node.children.map(visibleText).join("") : "";
}

const normalizeTitle = (title: string) => title.normalize("NFKC").replace(/\s+/g, " ").trim();

export function omitRepeatedArticleTitle(title: string) {
  const expected = normalizeTitle(title);
  return (tree: Root) => {
    tree.children = tree.children.filter((block) => block.type !== "heading" || block.depth !== 1 ||
      normalizeTitle(visibleText(block)) !== expected);
  };
}

export function articleBodyCharacterCount(markdown: string, title: string): number {
  const tree = visibleMarkdownParser.parse(markdown);
  omitRepeatedArticleTitle(title)(tree);
  return Array.from(visibleText(tree).replace(/\s/g, "")).length;
}
