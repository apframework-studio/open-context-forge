import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { AttentionCenter } from "./AttentionCenter";

test("attention center shows unresolved work and stage-specific recovery actions", () => {
  const html = renderToStaticMarkup(createElement(AttentionCenter, {
    summary: { count: 4, reminderDue: true, items: [
      { id: "filing:f1", kind: "filing", batchId: "b", captureId: "c", vaultId: "default",
        title: "Source A", stage: "reconcile", errorCode: "RAW_WRITE_UNCERTAIN", createdAt: "2026-10-27T00:00:00Z", result: null },
      { id: "maintenance:m1", kind: "maintenance", batchId: "b", captureId: "d", vaultId: "default",
        title: "Source B", stage: "complete", errorCode: null, createdAt: "2026-10-27T00:00:00Z",
        result: { recommendation: "ask_user" } },
      { id: "maintenance:m2", kind: "maintenance", batchId: "b", captureId: "e", vaultId: "default",
        title: "Source C", stage: "metadata_sync", errorCode: "SOURCE_METADATA_CHANGED",
        createdAt: "2026-10-27T00:00:00Z", result: null },
      { id: "maintenance:m3", kind: "maintenance", batchId: "b", captureId: "f", vaultId: "default",
        title: "Source D", stage: "writing", errorCode: "INTERRUPTED_WRITE",
        createdAt: "2026-10-27T00:00:00Z", result: null },
    ] }, onAction: () => undefined, onOpenSource: () => undefined,
  }));
  expect(html).toContain("Source A");
  expect(html).toContain("Source B");
  expect(html).toContain("检查并恢复");
  expect(html).toContain("需要人工判断");
  expect(html).toContain("保留原文并结束");
  expect(html).toContain("已核对，校验并完成");
  expect(html).not.toContain("盲目重试");
});
