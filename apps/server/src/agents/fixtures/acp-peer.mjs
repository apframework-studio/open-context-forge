import { createInterface } from "node:readline";
let promptId, permissionId = "permission-remote";
const mode = process.argv[2];
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const update = (value) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "native-session", update: value } });
const finish = () => {
  update({ sessionUpdate: "tool_call_update", toolCallId: "read-1", status: "completed" });
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "第二段。" } });
  send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
};
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (mode === "phases" && message.params.clientCapabilities?._meta?.jetbrains?.air?.version !== 1) process.exit(3);
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
  }
  else if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "native-session" } });
  else if (message.method === "session/load") {
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "不应重复的历史" } });
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  } else if (message.method === "session/prompt") {
    promptId = message.id;
    if (mode === "exit") { process.exit(1); return; }
    if (mode === "phases") {
      const phaseChunk = (phase, text) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text },
        _meta: { jetbrains: { air: { version: 1, phase } } } });
      phaseChunk("commentary", "我会先读取资料。\n");
      phaseChunk("final_answer", "# 正文\n\n");
      phaseChunk("final_answer", "这是可以采用的文稿。");
      send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
      return;
    }
    const chunk = JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "native-session", update: {
      sessionUpdate: "agent_message_chunk", content: { type: "text", text: "第一段，" } } } }) + "\n";
    // A pipe can split a JSON line anywhere, including multibyte text.
    const bytes = Buffer.from(chunk); process.stdout.write(bytes.subarray(0, bytes.length - 12));
    setTimeout(() => {
      process.stdout.write(bytes.subarray(bytes.length - 12));
      update({ sessionUpdate: "tool_call", toolCallId: "read-1", title: "读取资料", kind: "read", status: "in_progress" });
      if (mode === "permission") send({ jsonrpc: "2.0", id: permissionId, method: "session/request_permission", params: {
        sessionId: "native-session", toolCall: { toolCallId: "read-1", title: "读取资料" }, options: [{ kind: "allow_once", optionId: "yes", name: "允许一次" }] } });
      else if (mode !== "cancel") finish();
    }, 10);
  } else if (message.id === permissionId) {
    if (message.result?.outcome?.optionId !== "yes") process.exit(2); else finish();
  } else if (message.method === "session/cancel") send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled" } });
});
