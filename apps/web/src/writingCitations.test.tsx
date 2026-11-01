import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import { expect, it } from "vitest";
import { writingCitations } from "./writingCitations";

it("links source markers while preserving code and existing Markdown links", () => {
  const html = renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [writingCitations],
    children: '依据 [S1] 与 [S22]。`[S2]`\n\n```text\n[S3]\n```\n\n[已有 [S4]](https://example.com)' }));
  expect(html).toContain('href="#writing-source=S1"');
  expect(html).toContain('href="#writing-source=S22"');
  expect(html).toContain('<code>[S2]</code>');
  expect(html).not.toContain('#writing-source=S3');
  expect(html).not.toContain('#writing-source=S4');
});
