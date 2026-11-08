import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { PublishCenterTable } from "./PublishCenterScreen";
import { PublishAssets, PublishImageWorkspace } from "./PublishAssets";
import { PublishChannels } from "./PublishChannels";
import type { Article, PublishAsset, PublishCenterSummary } from "../api";

const article: Article = { id: "article-1", title: "本地知识整理体验检查", summary: "文章摘要", date: "2026-11-07",
  sourceRef: null, revision: 4, status: "final", markdown: "正文" };
const asset: PublishAsset = { id: "image-1", articleId: article.id, group: "vertical", name: "首页图.png",
  mime: "image/png", origin: "upload", createdAt: "2026-11-07T00:00:00Z", usedBy: ["weibo", "jike"] };

test("publish center renders dynamic channel columns and per-article readiness", () => {
  const summary: PublishCenterSummary = { channels: [{ id: "weibo", label: "微博" }, { id: "jike", label: "即刻" }],
    items: [{ id: article.id, title: article.title, summary: article.summary, revision: 4, updatedAt: "2026-11-07T00:00:00Z",
      channels: { weibo: { status: "ready", stale: false }, jike: { status: "unplanned", stale: false } } }] };
  const html = renderToStaticMarkup(createElement(PublishCenterTable, { summary, onOpen: () => undefined }));
  expect(html).toContain("本地知识整理体验检查");
  expect(html).toContain("微博");
  expect(html).toContain("即刻");
  expect(html).toContain("待发布");
  expect(html).toContain("未计划");
});

test("an article without a selected channel does not imply every channel is required", () => {
  const summary: PublishCenterSummary = { channels: [{ id: "weibo", label: "微博" }, { id: "jike", label: "即刻" }],
    items: [{ id: article.id, title: article.title, summary: article.summary, revision: 4, updatedAt: "2026-11-07T00:00:00Z",
      channels: { weibo: { status: "unplanned", stale: false }, jike: { status: "unplanned", stale: false } } }] };
  const html = renderToStaticMarkup(createElement(PublishCenterTable, { summary, onOpen: () => undefined }));
  expect(html).toContain("未选择渠道");
  expect(html).not.toContain("0/2");
});

test("assets page explains the key gate and names channels affected by image deletion", () => {
  const html = renderToStaticMarkup(createElement(PublishAssets, { article, assets: [asset], onChanged: async () => undefined }));
  expect(html).toContain("首页图.png");
  expect(html).toContain("微博");
  expect(html).toContain("即刻");
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
