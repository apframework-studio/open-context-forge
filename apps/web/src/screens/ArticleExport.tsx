import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Article, PublishAsset } from "../api";
import { omitRepeatedArticleTitle } from "../articleMarkdown";
import { formatCalendarDate, useLocale, type Locale, type LocalizedNotice } from "../locale";
import { publishAssetUrl } from "./PublishAssets";
import paperCss from "./article-export-paper.css?inline";
import "./article-export-paper.css";

const imageType = /^image\/(?:png|jpeg|gif|webp|svg\+xml|avif)$/i;

async function embedImage(url: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error("Image could not be read");
  const blob = await response.blob();
  if (!imageType.test(blob.type)) throw new Error("Unsupported image format");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

class ExportImageError extends Error {
  constructor(readonly imageLabel: string) { super("Image could not be embedded"); }
}

async function exportDocument(paper: HTMLElement, title: string, locale: Locale, signal: AbortSignal): Promise<string> {
  const copy = paper.cloneNode(true) as HTMLElement;
  const images = new Map<string, string>();
  for (const image of copy.querySelectorAll("img")) {
    const url = image.getAttribute("src")!;
    try {
      if (!images.has(url)) images.set(url, await embedImage(url, signal));
      image.src = images.get(url)!;
    } catch {
      throw new ExportImageError(image.alt);
    }
  }
  const documentTitle = document.createElement("title");
  documentTitle.textContent = title;
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
${documentTitle.outerHTML}<style>${paperCss}\nbody { max-width: 740px; padding: 28px; margin: 0 auto; } @media print { body { max-width: none; padding: 0; } }</style></head>
<body>${copy.outerHTML}</body></html>`;
}

function downloadHtml(html: string, title: string, fallbackTitle: string) {
  const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim().slice(0, 100) || fallbackTitle}.html`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

interface Props {
  article: Article;
  assets: PublishAsset[];
  selectedIds: string[];
  onSelectionChange: (ids: string[]) => void;
  onOpenAssets: () => void;
}

export function ArticleExport({ article, assets, selectedIds, onSelectionChange, onOpenAssets }: Props) {
  const { locale, t, noticeText } = useLocale();
  const paper = useRef<HTMLElement>(null);
  const active = useRef<AbortController>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<LocalizedNotice | null>(null);
  const [error, setError] = useState<LocalizedNotice | null>(null);
  const [printDocument, setPrintDocument] = useState<{ html: string; key: number } | null>(null);
  const selected = selectedIds.flatMap((id) => assets.find((asset) => asset.id === id) ?? []);
  useEffect(() => () => active.current?.abort(), []);

  async function exportFile(format: "html" | "pdf") {
    if (!paper.current || active.current) return;
    const job = new AbortController();
    active.current = job;
    setBusy(true); setError(null); setMessage(null);
    try {
      const html = await exportDocument(paper.current, article.title, locale, job.signal);
      if (job.signal.aborted) return;
      if (format === "html") {
        downloadHtml(html, article.title, t("文章", "Article"));
        setMessage(["HTML 已交给浏览器下载。", "The HTML download has started."]);
      } else {
        setPrintDocument({ html, key: performance.now() });
        setMessage(["请在打印窗口选择「另存为 PDF」。", "Choose Save as PDF in the print dialog."]);
      }
    } catch (cause) {
      if (!job.signal.aborted) setError(cause instanceof ExportImageError ?
        [`无法嵌入图片「${cause.imageLabel || "正文图片"}」，请检查素材后重试。`,
          `Could not embed “${cause.imageLabel || "article image"}”. Check the image and try again.`] :
        [cause, "导出失败，请重试。", "Export failed. Try again."]);
    } finally {
      active.current = null;
      if (!job.signal.aborted) setBusy(false);
    }
  }

  return <>
    <div className="pc-export-toolbar">
      <span>{t("已定稿", "Finalized")}</span>
      <div className="pc-actions">
        <button className="pc-button" disabled={busy} onClick={() => void exportFile("pdf")}>{t("另存为 PDF", "Save as PDF")}</button>
        <button className="pc-button pc-primary" disabled={busy} onClick={() => void exportFile("html")}>{t("下载 HTML", "Download HTML")}</button>
      </div>
    </div>
    {error && <p role="alert" className="inline-message error">{noticeText(error)}</p>}
    {(busy || message) && <p role="status" className="pc-feedback">{busy ? t("正在准备导出文件…", "Preparing export…") : message && noticeText(message)}</p>}
    <div className="pc-export-layout">
      <section className="pc-export-preview" aria-label={t("导出预览", "Export preview")}>
        <article ref={paper} className="article-export-paper">
          <header><h1>{article.title}</h1><time dateTime={article.date}>{formatCalendarDate(article.date, locale)}</time>
            {article.summary && <p>{article.summary}</p>}</header>
          <Markdown skipHtml remarkPlugins={[remarkGfm, [omitRepeatedArticleTitle, article.title]]} components={{
            img: ({ src, alt }) => src?.startsWith("assets/") ?
              <img alt={alt || t("正文图片", "Article image")} src={`/api/v1/articles/${encodeURIComponent(article.id)}/asset?path=${encodeURIComponent(src)}`} /> :
              src && /^https?:\/\//i.test(src) ? <a href={src}>{alt || t("查看原图", "View original image")}</a> : alt || null,
            a: ({ href, children }) => href && /^(https?:\/\/|mailto:|#)/i.test(href) ? <a href={href}>{children}</a> : <>{children}</>,
          }}>{article.markdown}</Markdown>
          {selected.length > 0 && <section aria-label={t("插图", "Illustrations")}><h2>{t("插图", "Illustrations")}</h2>{selected.map((asset) => <figure key={asset.id}>
            <img src={publishAssetUrl(asset)} alt={asset.name} />
          </figure>)}</section>}
        </article>
      </section>
      <aside className="pc-export-images" aria-label={t("导出插图", "Export illustrations")}>
        <h2>{t("插图", "Illustrations")}<span>{t(`${selected.length} 张已选`, `${selected.length} selected`)}</span></h2>
        {assets.length ? <><p>{t("按勾选顺序附在正文之后。", "Images appear after the article in the order you select them.")}</p><div className="pc-export-picker">
          {assets.map((asset) => <label key={asset.id} className="pc-export-pick">
            <input type="checkbox" disabled={busy} checked={selectedIds.includes(asset.id)} onChange={(event) => onSelectionChange(event.target.checked ?
              [...selectedIds, asset.id] : selectedIds.filter((id) => id !== asset.id))} />
            <img src={publishAssetUrl(asset)} alt="" /><span>{asset.name}</span>
          </label>)}
        </div></> : <p>{t("可上传图片，也可直接导出正文。", "Upload images or export the article on its own.")}</p>}
        <button className="pc-button" onClick={onOpenAssets}>{t("管理图片", "Manage images")}</button>
      </aside>
    </div>
    {printDocument && <iframe key={printDocument.key} className="pc-print-frame" title={t("PDF 打印文档", "PDF print document")} tabIndex={-1}
      sandbox="allow-same-origin allow-modals" srcDoc={printDocument.html} onLoad={(event) => {
        try {
          const frame = event.currentTarget.contentWindow;
          if (!frame) throw new Error();
          frame.focus();
          frame.print();
        } catch {
          setMessage(null);
          setError(["无法打开打印窗口。请下载 HTML 后用浏览器打开并另存为 PDF。",
            "Could not open the print dialog. Download the HTML file, open it in a browser, and save it as PDF."]);
        }
      }} />}
  </>;
}
