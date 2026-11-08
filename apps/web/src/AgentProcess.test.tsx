import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentRun } from "./api";
import { AgentProcess } from "./AgentProcess";

const run: AgentRun = {
  id: "run-1", articleId: "article-1", profileId: "claude-current", assistantMessageId: "message-1",
  status: "running", text: "", activity: "正在读取资料", tools: [{ id: "tool-1", title: "读取本地文件", status: "completed" }],
  permissions: [], errorCode: null, createdAt: "2026-11-07T00:00:00Z", updatedAt: "2026-11-07T00:00:00Z", seq: 1,
};

describe("agent process", () => {
  it("keeps tool details closed during an ordinary run while showing its summary", () => {
    const html = renderToStaticMarkup(createElement(AgentProcess, { run, onAnswer: () => undefined }));
    expect(html).toContain("1 项操作");
    expect(html).toContain("运行中");
    expect(html).not.toMatch(/<details open=/);
  });

  it("shows a permission request outside the collapsed tool details", () => {
    const waiting: AgentRun = { ...run, status: "waiting_permission", permissions: [{ id: "permission-1", title: "允许读取", options: [{ optionId: "once", name: "允许一次", kind: "allow_once" }] }] };
    const html = renderToStaticMarkup(createElement(AgentProcess, { run: waiting, onAnswer: () => undefined }));
    expect(html).toContain('aria-label="智能体操作确认"');
    expect(html).toContain("允许一次");
    expect(html).not.toMatch(/<details open=/);
  });
});
