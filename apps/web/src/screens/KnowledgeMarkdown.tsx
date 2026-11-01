import { useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Root } from "mdast";
import type { KnowledgeDetail } from "../api";
import { readingDocument } from "./readingMarkdown";

type ReadingDetail = Pick<KnowledgeDetail, "kind" | "title" | "path" | "markdown" | "outlinks" | "issues"> &
  Partial<Pick<KnowledgeDetail, "vaultId" | "format" | "previewLimited">>;
interface Props {
  item: ReadingDetail;
  onNavigate: (path: string, fragment?: string) => void;
  onAnchor: (fragment: string) => void;
}
const wikiPrefix = "#ocf-note=";
const propertyLabels: Record<string, string> = { type: "类型", topic: "主题", status: "状态", confidence: "可信度",
  sources: "来源", related: "相关笔记", last_reviewed: "最近复核", tags: "标签", aliases: "别名" };
type ReadingNode = { type: string; value?: string; children?: ReadingNode[]; depth?: number; url?: string };
function text(node: ReadingNode): string { return node.value ?? node.children?.map(text).join("") ?? ""; }
function KnowledgeImage({ src, alt }: { src?: string; alt?: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || !/^https?:\/\//i.test(src) || failed) return <span className="knowledge-image-placeholder">图片未加载{alt ? `：${alt}` : ""}</span>;
  return <img src={src} alt={alt ?? ""} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

// Transform parsed text nodes only: code blocks, inline code and existing links stay intact.
function remarkKnowledgeLinks({ title }: { title: string }) {
  return (tree: Root) => {
    const root: ReadingNode = tree;
    if (root.children?.[0]?.type === "heading" && root.children[0].depth === 1 && text(root.children[0]).trim() === title.trim()) root.children.shift();
    function visit(parent: ReadingNode) {
      if (!parent.children || parent.type === "link" || parent.type === "linkReference") return;
      parent.children = parent.children.flatMap((node): ReadingNode[] => {
        if (node.type !== "text" || !node.value) { visit(node); return [node]; }
        const nodes: ReadingNode[] = [];
        let cursor = 0;
        for (const match of node.value.matchAll(/(!?)\[\[([^\]\n]+)\]\]/g)) {
          if (match.index > cursor) nodes.push({ type: "text", value: node.value.slice(cursor, match.index) });
          const separator = match[2].indexOf("|");
          const target = (separator < 0 ? match[2] : match[2].slice(0, separator)).trim();
          const label = separator < 0 ? target.replace(/\.md(?=#|$)/i, "") : match[2].slice(separator + 1).trim();
          nodes.push({ type: "link", url: `${wikiPrefix}${encodeURIComponent(target)}`, children: [{ type: "text", value: `${match[1] ? "嵌入笔记：" : ""}${label || target}` }] });
          cursor = match.index + match[0].length;
        }
        if (!nodes.length) return [node];
        if (cursor < node.value.length) nodes.push({ type: "text", value: node.value.slice(cursor) });
        return nodes;
      });
    }
    visit(root);
  };
}

export function KnowledgeMarkdown({ item, onNavigate, onAnchor }: Props) {
  const document = useMemo(() => readingDocument(item), [item.kind, item.title, item.markdown]);
  const fileUrl = item.vaultId ? `/api/v1/knowledge/files/${encodeURIComponent(item.vaultId)}?path=${encodeURIComponent(item.path)}` : undefined;
  if (item.format === "pdf") return <div className="knowledge-pdf-viewer">
    <div className="knowledge-pdf-actions"><span>PDF 文档 · 浏览器预览</span><a className="text-button" href={fileUrl} target="_blank" rel="noopener noreferrer">新窗口打开 PDF</a></div>
    <iframe title={`PDF 预览：${item.title}`} src={fileUrl} />
    <small>若当前浏览器无法内嵌预览，可在新窗口中打开。PDF 目前按文件名搜索，尚未提取正文。</small>
  </div>;
  if (item.previewLimited) return <div className="knowledge-preview-notice"><p>文件超过 2 MiB 文本预览上限，已保留在列表与数量统计中。</p>
    <a className="text-button" href={fileUrl} download>下载原文件查看</a></div>;
  if (item.format === "text") return <pre className="knowledge-plain-text">{item.markdown}</pre>;
  return <>
    {document.rawProperties !== null && <details className="knowledge-properties">
      <summary>笔记属性 <span>{document.error ? "格式待检查" : `${document.properties.length} 项`}</span></summary>
      {document.error ? <><p role="status">{document.error}</p><pre>{document.rawProperties}</pre></> :
        <dl>{document.properties.map((property) => <div key={property.name}><dt title={property.name}>{propertyLabels[property.name] ?? property.name}</dt>
          <dd>{property.values.length ? property.values.map((value, index) => <span key={index}>{value}</span>) : <span>—</span>}</dd></div>)}</dl>}
    </details>}
    <div className="markdown-body knowledge-markdown"><Markdown remarkPlugins={[remarkGfm, [remarkKnowledgeLinks, { title: item.title }]]} skipHtml
      components={{
        img: ({ src, alt }) => <KnowledgeImage src={src} alt={alt} />,
        a: ({ href, children }) => {
          if (/^https?:\/\//i.test(href ?? "")) return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
          if (!href) return <span>{children}</span>;
          const wiki = href.startsWith(wikiPrefix);
          let target: string;
          try { target = decodeURIComponent(wiki ? href.slice(wikiPrefix.length) : href); } catch { return <span>{children}</span>; }
          if (/^(?:[a-z][a-z\d+.-]*:|\/)/i.test(target)) return <span>{children}</span>;
          const hash = target.indexOf("#");
          const fragment = hash < 0 ? "" : target.slice(hash + 1);
          const path = (hash < 0 ? target : target.slice(0, hash)).trim();
          if (!path && fragment) return <a className="knowledge-note-link" href={href} onClick={(event) => { event.preventDefault(); onAnchor(fragment); }}>{children}</a>;
          const type = wiki ? "wikilink" : "markdown";
          const link = item.outlinks.find((link) => link.type === type && link.target === path);
          if (link) return <a className="knowledge-note-link" href={href} title={link.to} onClick={(event) => {
            event.preventDefault(); onNavigate(link.to, fragment || undefined);
          }}>{children}</a>;
          const issue = item.issues.find((issue) => issue.target === path);
          return <span className="knowledge-note-unresolved" title={`${path} · ${issue?.reason === "ambiguous" ? "目标有歧义，存在多篇同名笔记" : "目标不存在或尚未纳入索引"}`}>{children}</span>;
        },
        table: ({ children }) => <div className="knowledge-table-scroll"><table>{children}</table></div>,
      }}>{document.body}</Markdown></div>
  </>;
}
