import { expect, test } from "vitest";
import { buildImagePrompt } from "./image-prompt";

test("uses article headings, summary and outline without needing a full body", () => {
  const prompt = buildImagePrompt({ title: "知识整理", summary: "把零散资料变成可用笔记", markdown: "" }, "# 结构\n## 收集\n- 标注来源");
  expect(prompt).toContain("知识整理");
  expect(prompt).toContain("收集");
  expect(prompt).toContain("标注来源");
  expect(prompt).toContain("零散资料");
});

test("extracts document headings and keeps an editable prompt within the API limit", () => {
  const prompt = buildImagePrompt({ title: "文章", summary: "", markdown: "# 文章\n## 方法\n\n正文说明。\n```md\n# 代码块里的标题\n```" });
  expect(prompt).toContain("方法");
  expect(prompt).toContain("正文说明");
  expect(prompt).not.toContain("代码块里的标题");
  expect(prompt.length).toBeLessThanOrEqual(4000);
});
