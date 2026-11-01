import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { VaultScreen } from "./VaultScreen";

test("knowledge workspace separates overview, browse, graph and connection settings", () => {
  const html = renderToStaticMarkup(createElement(VaultScreen, {
    vaults: { defaultVaultId: "default", vaults: [{ id: "default", path: "/tmp/vault", kind: "built-in", isDefault: true, autoMaintain: false }] },
    onSettings: () => undefined,
  }));
  expect(html).toContain("刚入库来源");
  expect(html).toContain("最近修改笔记");
  expect(html).toContain("搜索知识库");
  expect(html).toContain("知识库连接设置");
  expect(html).toContain("图谱");
});
