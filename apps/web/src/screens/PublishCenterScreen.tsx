import { useEffect, useState } from "react";
import { api, type Article, type ArticleList, type PublishAsset } from "../api";
import { formatCalendarDate, useLocale } from "../locale";
import { ArticleExport } from "./ArticleExport";
import { PublishAssets } from "./PublishAssets";
import "./publish-center.css";

interface Props {
  focusArticleId: string | null;
  onFocusChange: (articleId: string | null) => void;
  onOpenArticles: (articleId?: string) => void;
}

function ExportList({ onFocusChange, onOpenArticles }: Omit<Props, "focusArticleId">) {
  const { locale, t } = useLocale();
  const [articles, setArticles] = useState<ArticleList["items"] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    void api<ArticleList>("/articles").then(({ items }) => {
      if (active) setArticles(items.filter((item) => item.status === "final" && !item.trashedAt));
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, []);

  return <section className="panel-card" aria-label={t("定稿文章", "Finalized articles")}>
    <div className="pc-heading"><div><h2>{t("定稿文章", "Finalized articles")}</h2>
      <p>{t("选择一篇文章，预览排版和插图。", "Choose an article to preview its layout and illustrations.")}</p></div></div>
    {error ? <p role="alert" className="pc-empty">{t("定稿文章加载失败，请刷新后重试。", "Could not load finalized articles. Refresh and try again.")}</p> :
      !articles ? <p role="status" className="pc-empty">{t("正在读取文章…", "Loading articles…")}</p> :
      articles.length ? <ul className="pc-export-list">{articles.map((item) => <li key={item.id}>
        <button className="pc-article-link" onClick={() => onFocusChange(item.id)}>
          <strong>{item.title}</strong>{item.summary && <small>{item.summary}</small>}
        </button><time dateTime={item.date}>{formatCalendarDate(item.date, locale)}</time>
      </li>)}</ul> : <div className="pc-empty">{t("暂无已定稿文章。", "No finalized articles yet.")}
        <button className="pc-button" onClick={() => onOpenArticles()}>{t("前往文章工作台", "Go to Articles")}</button></div>}
  </section>;
}

function ExportDetail({ id, onBack, onOpenArticle }: { id: string; onBack: () => void; onOpenArticle: () => void }) {
  const { t } = useLocale();
  const [article, setArticle] = useState<Article | null>(null);
  const [assets, setAssets] = useState<PublishAsset[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [showAssets, setShowAssets] = useState(false);
  const [error, setError] = useState(false);
  const assetPath = `/articles/${encodeURIComponent(id)}/publish-assets`;

  async function refreshAssets() {
    const { items } = await api<{ items: PublishAsset[] }>(assetPath);
    setAssets(items);
    setSelectedIds((previous) => previous.filter((assetId) => items.some((item) => item.id === assetId)));
  }

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const next = await api<Article>(`/articles/${encodeURIComponent(id)}`);
        if (!active) return;
        const items = next.status === "final" ? (await api<{ items: PublishAsset[] }>(assetPath)).items : [];
        if (active) { setArticle(next); setAssets(items); }
      } catch { if (active) setError(true); }
    })();
    return () => { active = false; };
  }, [id, assetPath]);

  return <section className="panel-card">
    <button className="pc-back" onClick={onBack}>{t("← 返回定稿列表", "← Back to finalized articles")}</button>
    {error ? <p role="alert" className="pc-empty">{t("文章或图片读取失败，请刷新后重试。", "Could not load the article or images. Refresh and try again.")}</p> :
      !article ? <p role="status" className="pc-empty">{t("正在读取文章…", "Loading article…")}</p> :
      article.status !== "final" ? <div className="pc-empty"><strong>{article.title || t("未命名文章", "Untitled article")}</strong>
        <span>{t("请先在文章工作台定稿。", "Finalize the article before exporting it.")}</span>
        <button className="pc-button" onClick={onOpenArticle}>{t("返回此文章并定稿", "Return to article")}</button></div> : <>
        <div className="pc-tabs" role="group" aria-label={t("文章导出与素材", "Export and images")}>
          <button aria-pressed={!showAssets} className={!showAssets ? "active" : ""} onClick={() => setShowAssets(false)}>{t("导出预览", "Export preview")}</button>
          <button aria-pressed={showAssets} className={showAssets ? "active" : ""} onClick={() => setShowAssets(true)}>{t("图片素材", "Image library")}</button>
        </div>
        {showAssets ? <PublishAssets article={article} assets={assets} onChanged={refreshAssets} /> :
          <ArticleExport article={article} assets={assets} selectedIds={selectedIds} onSelectionChange={setSelectedIds} onOpenAssets={() => setShowAssets(true)} />}
      </>}
  </section>;
}

export function PublishCenterScreen({ focusArticleId, onFocusChange, onOpenArticles }: Props) {
  return <div className="screen-stack pc-screen">{focusArticleId ?
    <ExportDetail key={focusArticleId} id={focusArticleId} onBack={() => onFocusChange(null)} onOpenArticle={() => onOpenArticles(focusArticleId)} /> :
    <ExportList onFocusChange={onFocusChange} onOpenArticles={onOpenArticles} />}</div>;
}
