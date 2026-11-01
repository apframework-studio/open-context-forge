import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { ImportScreen } from "./ImportScreen";

test("source workbench leads with one compact toolbar and processing views", () => {
  const html = renderToStaticMarkup(createElement(ImportScreen, {
    vaults: { defaultVaultId: "default", vaults: [{ id: "default", path: "/tmp/vault", kind: "built-in", isDefault: true, autoMaintain: false }] },
    onImported: () => undefined,
    onCaptureSettings: () => undefined,
  }));
  expect(html).not.toContain("资料处理台");
  expect(html).toContain("导入资料、检查来源，形成可回查的分析。");
  expect(html).toContain('aria-label="资料列表"');
  expect(html).not.toContain('class="source-summary"');
  expect(html).toContain("导入资料");
  expect(html).toContain("待整理");
  expect(html).toContain("全部资料");
  expect(html).not.toContain("批次预检");
});
