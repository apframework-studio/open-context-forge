import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { ArticleExport } from "./ArticleExport";
import { PublishAssets, PublishImageWorkspace } from "./PublishAssets";
import { PublishChannels } from "./PublishChannels";
import type { Article, PublishAsset } from "../api";

const article: Article = { id: "article-1", title: "本地知识整理体验检查", summary: "文章摘要", date: "2026-11-07",
  sourceRef: null, revision: 4, status: "final", markdown: "正文" };
const asset: PublishAsset = { id: "image-1", articleId: article.id, group: "vertical", name: "首页图.png",
  mime: "image/png", origin: "upload", createdAt: "2026-11-07T00:00:00Z", usedBy: ["weibo", "jike"] };

test("export removes the repeated article title after an introduction and keeps other content", () => {
  const markdown = `文章的引言。\n\n# **${article.title}**\n\n# 独立章节\n\n\`\`\`md\n# ${article.title}\n\`\`\``;
  const html = renderToStaticMarkup(createElement(ArticleExport, {
    article: { ...article, markdown }, assets: [], selectedIds: [], onSelectionChange: () => {}, onOpenAssets: () => {},
  }));
  expect(html.match(/<h1>/g)).toHaveLength(2);
  expect(html).toContain("<p>文章的引言。</p>");
  expect(html).toContain("<h1>独立章节</h1>");
  expect(html).toContain(`<code class="language-md"># ${article.title}`);
});

test("image library shows the existing illustration without exposing channel names", () => {
  const html = renderToStaticMarkup(createElement(PublishAssets, { article, assets: [asset], onChanged: async () => undefined }));
  expect(html).toContain("首页图.png");
  expect(html).not.toContain("微博");
  expect(html).not.toContain("即刻");
  const workspace = renderToStaticMarkup(createElement(PublishImageWorkspace, { article }));
  expect(workspace).toContain("连接图像服务后即可生成");
  expect(workspace).toContain("disabled");
});

test("weibo and jike keep different editing fields", () => {
  const weibo = renderToStaticMarkup(createElement(PublishChannels, { article, channel: "weibo", draft: null,
    assets: [], onSaved: async () => undefined }));
  const jike = renderToStaticMarkup(createElement(PublishChannels, { article, channel: "jike", draft: null,
    assets: [], onSaved: async () => undefined }));
  expect(weibo).toContain("微博正文");
  expect(weibo).toContain("话题");
  expect(weibo).toContain("标记待发布");
  expect(weibo).not.toContain("下载渠道发布包");
  expect(jike).toContain("即刻正文");
  expect(jike).toContain("讨论引导");
});
