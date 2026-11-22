import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { LocaleProvider } from "../locale";
import { KnowledgeMarkdown } from "./KnowledgeMarkdown";
import { VaultScreen } from "./VaultScreen";

test("English knowledge navigation and reading labels retain the authored note", () => {
  vi.stubGlobal("localStorage", { getItem: (key: string) => key === "ocf-locale" ? "en" : null });
  try {
    const html = renderToStaticMarkup(<LocaleProvider>
      <VaultScreen vaults={null} onSettings={() => undefined} />
      <KnowledgeMarkdown item={{ kind: "note", title: "原始笔记", path: "原始笔记.md", outlinks: [], issues: [],
        markdown: "---\ntopic: 阅读\n---\n作者写的正文。" }} onNavigate={() => undefined} onAnchor={() => undefined} />
    </LocaleProvider>);
    expect(html).toContain('aria-label="Knowledge views"');
    expect(html).toContain('aria-label="Search knowledge"');
    expect(html).toContain("Note properties");
    expect(html).toContain("作者写的正文。");
  } finally { vi.unstubAllGlobals(); }
});
