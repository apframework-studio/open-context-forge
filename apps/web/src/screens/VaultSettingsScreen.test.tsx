import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { VaultSettingsScreen } from "./VaultSettingsScreen";

test("each vault displays its own automatic maintenance toggle and direct-write behavior", () => {
  const html = renderToStaticMarkup(createElement(VaultSettingsScreen, {
    vaults: { defaultVaultId: "default", vaults: [
      { id: "default", path: "/tmp/default", kind: "built-in", isDefault: true, autoMaintain: false },
      { id: "research", path: "/tmp/research", kind: "external", isDefault: false, autoMaintain: true },
    ] },
    refresh: async () => undefined, branding: { customized: false, revision: null },
    iconUrl: "/icon.png", onBrandingChange: () => undefined,
  }));
  expect(html).toContain('aria-label="default 入库后自动维护"');
  expect(html).toContain('aria-label="research 入库后自动维护" checked=""');
  expect(html).toContain("compile_now 且校验通过时直接写入知识笔记");
});
