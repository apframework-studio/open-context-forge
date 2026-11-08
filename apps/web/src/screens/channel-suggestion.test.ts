import { expect, test } from "vitest";
import { buildChannelSuggestion } from "./channel-suggestion";

const article = { title: "整理资料", summary: "把零散笔记串成主题", markdown: "# 整理资料\n\n先记录来源，再按主题归档。\n\n## 回顾\n\n定期检查遗漏。" };

test("Weibo suggestion uses article facts and preserves an existing topic", () => {
  const suggestion = buildChannelSuggestion(article, "weibo", "#旧话题");
  expect(suggestion.text).toContain("整理资料");
  expect(suggestion.text).toContain("把零散笔记串成主题");
  expect(suggestion.text).toContain("先记录来源，再按主题归档");
  expect(suggestion.extra).toBe("#旧话题");
  expect(suggestion.text).not.toContain("定期检查遗漏");
});

test("Jike suggestion adds a discussion question from the article heading", () => {
  const suggestion = buildChannelSuggestion(article, "jike", "");
  expect(suggestion.text).toContain("先记录来源，再按主题归档");
  expect(suggestion.extra).toContain("回顾");
  expect(suggestion.extra).toContain("？");
});

test("Jike discussion question ignores a differently worded document H1", () => {
  const suggestion = buildChannelSuggestion({ title: "整理资料-修订版", summary: "整理记录", markdown: "# 整理资料\n\n正文。\n## 回顾方法" }, "jike", "");
  expect(suggestion.extra).toContain("回顾方法");
  expect(suggestion.extra).not.toContain("「整理资料」");
});

test("Jike suggestion keeps an existing discussion prompt", () => {
  expect(buildChannelSuggestion(article, "jike", "你曾怎样整理资料？").extra).toBe("你曾怎样整理资料？");
});
