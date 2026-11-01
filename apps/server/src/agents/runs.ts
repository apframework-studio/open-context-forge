import type { WritingTurnContext } from "@ocf/contracts";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { AgentEvent, AgentPermission, AgentRunInput, AgentRunner, AgentTool } from "./runner.js";

export interface AgentRun {
  context?: WritingTurnContext;
  id: string; articleId: string; profileId: string; assistantMessageId: string;
  status: "running" | "waiting_permission" | "completed" | "failed" | "cancelled" | "interrupted";
  text: string; activity: string; tools: AgentTool[]; permissions: AgentPermission[];
  errorCode: string | null; createdAt: string; updatedAt: string; seq: number;
}
export const isActive = (run: AgentRun) => run.status === "running" || run.status === "waiting_permission";
function logRun(run: AgentRun, event: string) {
  console.info("[agent-run]", JSON.stringify({ event, runId: run.id, articleId: run.articleId, profileId: run.profileId,
    status: run.status, outputChars: run.text.length, tools: run.tools.length, errorCode: run.errorCode,
    elapsedMs: Date.now() - new Date(run.createdAt).getTime() }));
}
export class RunError extends Error {
  constructor(readonly code: string, readonly statusCode: number) { super(code); }
}
type Row = { state_json: string; conversation_id: string };

export class AgentRuns {
  private readonly tasks = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private readonly permissions = new Map<string, Map<string, (choice: string) => void>>();
  private stopped = false;
  private readonly live = new Map<string, AgentRun>();

  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY, article_id TEXT NOT NULL REFERENCES articles(id),
      conversation_id TEXT NOT NULL REFERENCES agent_conversations(id), status TEXT NOT NULL, state_json TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS agent_one_active_article ON agent_runs(article_id)
      WHERE status IN ('running', 'waiting_permission');
    CREATE TABLE IF NOT EXISTS agent_run_events (
      run_id TEXT NOT NULL REFERENCES agent_runs(id), seq INTEGER NOT NULL, payload_json TEXT NOT NULL,
      PRIMARY KEY(run_id, seq)
    );`);
    const unfinished = db.prepare("SELECT state_json FROM agent_runs WHERE status IN ('running', 'waiting_permission')").all() as Row[];
    for (const row of unfinished) {
      const run = JSON.parse(row.state_json) as AgentRun;
      run.status = "interrupted"; run.errorCode = "AGENT_SERVICE_RESTARTED"; run.permissions = [];
      run.activity = "本机服务已重启，保留已有输出，可重新发送";
      this.save(run, { type: "interrupted" });
      logRun(run, "recovered");
    }
  }

  latest(conversationId: string): AgentRun | null {
    const row = this.db.prepare("SELECT state_json FROM agent_runs WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 1").get(conversationId) as Row | undefined;
    return row ? JSON.parse(row.state_json) : null;
  }
  list(conversationId: string): AgentRun[] {
    return (this.db.prepare("SELECT state_json FROM agent_runs WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 100").all(conversationId) as Row[])
      .map((row) => JSON.parse(row.state_json));
  }

  hasLiveTask(articleId: string): boolean {
    return [...this.live.values()].some((run) => run.articleId === articleId);
  }

  get(articleId: string, runId: string): AgentRun {
    const row = this.db.prepare("SELECT state_json FROM agent_runs WHERE id = ? AND article_id = ?").get(runId, articleId) as Row | undefined;
    if (!row) throw new RunError("AGENT_RUN_NOT_FOUND", 404);
    return JSON.parse(row.state_json);
  }

  start(articleId: string, conversationId: string, input: AgentRunInput, content: string, runner: AgentRunner): AgentRun {
    if (this.stopped) throw new RunError("AGENT_SERVICE_STOPPING", 503);
    if ([...this.live.values()].some((item) => item.articleId === articleId)) throw new RunError("AGENT_BUSY", 409);
    const now = new Date().toISOString();
    const run: AgentRun = { id: randomUUID(), articleId, profileId: input.profileId, assistantMessageId: randomUUID(),
      ...(input.context ? {context: input.context} : {}), status: "running", text: "", activity: "正在连接本机智能体…", tools: [], permissions: [], errorCode: null,
      createdAt: now, updatedAt: now, seq: 0 };
    this.db.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM agent_runs WHERE article_id = ? AND status IN ('running', 'waiting_permission')").get(articleId)) throw new RunError("AGENT_BUSY", 409);
      this.db.prepare("INSERT INTO agent_runs VALUES (?, ?, ?, ?, ?)").run(run.id, articleId, conversationId, run.status, JSON.stringify(run));
      const insert = this.db.prepare("INSERT INTO agent_messages (id, conversation_id, role, content, created_at, context_json) VALUES (?, ?, ?, ?, ?, ?)");
      const context = input.context ? JSON.stringify(input.context) : null;
      insert.run(randomUUID(), conversationId, "user", content, now, context);
      insert.run(run.assistantMessageId, conversationId, "assistant", "", now, context);
    })();
    const controller = new AbortController();
    this.live.set(run.id, run);
    // Start after registration, so an immediate cancellation never races task ownership.
    const promise = Promise.resolve().then(() => this.execute(run, conversationId, input, runner, controller));
    this.tasks.set(run.id, { controller, promise });
    const cleanup = () => { this.tasks.delete(run.id); this.live.delete(run.id); };
    void promise.then(cleanup, cleanup);
    logRun(run, "accepted");
    return run;
  }

  private save(run: AgentRun, event: unknown): void {
    run.seq += 1; run.updatedAt = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare("UPDATE agent_runs SET status = ?, state_json = ? WHERE id = ?").run(run.status, JSON.stringify(run), run.id);
      this.db.prepare("INSERT INTO agent_run_events VALUES (?, ?, ?)").run(run.id, run.seq, JSON.stringify(event));
      this.db.prepare("UPDATE agent_messages SET content = ? WHERE id = ?").run(run.text, run.assistantMessageId);
    })();
  }

  private emit(run: AgentRun, conversationId: string, event: AgentEvent): void {
    if (!isActive(run)) return;
    if (event.type === "text") {
      if (run.text.length + event.text.length > 2_000_000) throw new Error("AGENT_OUTPUT_TOO_LARGE");
      run.text += event.text;
    } else if (event.type === "activity") run.activity = event.text;
    else if (event.type === "tool") {
      const old = run.tools.find((tool) => tool.id === event.tool.id);
      if (old) Object.assign(old, Object.fromEntries(Object.entries(event.tool).filter(([, value]) => value !== "" && value !== undefined)));
      else if (run.tools.length < 200) run.tools.push({ ...event.tool, title: event.tool.title || "工具操作", status: event.tool.status || "pending" });
    } else if (event.type === "session") {
      this.db.prepare("UPDATE agent_conversations SET acp_session_id = ? WHERE id = ?").run(event.sessionId, conversationId);
    }
    this.save(run, event);
  }

  private async execute(run: AgentRun, conversationId: string, input: AgentRunInput, runner: AgentRunner, controller: AbortController): Promise<void> {
    try {
      if (controller.signal.aborted) return;
      const result = await runner({ ...input, signal: controller.signal,
        onEvent: (event) => this.emit(run, conversationId, event),
        onPermission: async (request) => {
          if (controller.signal.aborted || !isActive(run)) return "";
          const choice = new Promise<string>((resolve) => {
            let pending = this.permissions.get(run.id);
            if (!pending) { pending = new Map(); this.permissions.set(run.id, pending); }
            pending.set(request.id, resolve);
          });
          run.permissions.push(request); run.status = "waiting_permission";
          this.save(run, { type: "permission", request });
          logRun(run, "permission_requested");
          return choice;
        } });
      if (controller.signal.aborted || !isActive(run)) return;
      if (!result.text.trim()) throw new Error("AGENT_RESPONSE_INVALID");
      this.clearPermissions(run);
      run.text = result.text; run.status = "completed"; run.activity = "已完成";
      this.db.prepare("UPDATE agent_conversations SET acp_session_id = ? WHERE id = ?").run(result.sessionId, conversationId);
      this.save(run, { type: "completed" });
      logRun(run, "completed");
    } catch (error) {
      if (!isActive(run)) return;
      run.status = controller.signal.aborted ? "cancelled" : "failed";
      run.errorCode = error instanceof Error && /^AGENT_[A-Z_]+$/.test(error.message) ? error.message : "AGENT_RUN_FAILED";
      run.activity = run.status === "cancelled" ? "已停止" : "执行失败，已有输出已保留";
      this.clearPermissions(run); this.save(run, { type: run.status });
      logRun(run, run.status);
    }
  }

  private clearPermissions(run: AgentRun): void {
    for (const resolve of this.permissions.get(run.id)?.values() ?? []) resolve("");
    this.permissions.delete(run.id); run.permissions = [];
  }

  cancel(articleId: string, runId: string): AgentRun {
    const stored = this.live.get(runId) ?? this.get(articleId, runId);
    if (stored.articleId !== articleId) throw new RunError("AGENT_RUN_NOT_FOUND", 404);
    const task = this.tasks.get(runId);
    if (!isActive(stored)) return stored;
    // The execution callback owns its live object; abort it before persisting the terminal snapshot.
    task?.controller.abort(); this.clearPermissions(stored);
    stored.status = "cancelled"; stored.activity = "已停止，保留已有输出"; stored.errorCode = null;
    this.save(stored, { type: "cancelled" });
    logRun(stored, "cancelled");
    return stored;
  }

  answer(articleId: string, runId: string, requestId: unknown, optionId: unknown): AgentRun {
    const run = this.get(articleId, runId);
    const request = run.permissions.find((item) => item.id === requestId);
    const pending = this.permissions.get(run.id);
    const resolve = typeof requestId === "string" ? pending?.get(requestId) : undefined;
    if (!request || !resolve || !isActive(run)) throw new RunError("AGENT_PERMISSION_EXPIRED", 409);
    if (typeof optionId !== "string" || !request.options.some((option) => option.optionId === optionId)) throw new RunError("INVALID_AGENT_PERMISSION", 422);
    pending!.delete(request.id);
    // Update the shared object used by execute as well as the persisted projection.
    this.permissionAnswered(run.id, request.id);
    resolve(optionId);
    return this.get(articleId, runId);
  }

  private permissionAnswered = (runId: string, requestId: string) => {
    const run = this.live.get(runId)!;
    run.permissions = run.permissions.filter((item) => item.id !== requestId);
    run.status = run.permissions.length ? "waiting_permission" : "running";
    this.save(run, { type: "permission_answered", requestId });
  };

  async stop(): Promise<void> {
    this.stopped = true;
    for (const [id] of this.tasks) { const run = this.live.get(id); if (run) this.cancel(run.articleId, id); }
    await Promise.allSettled([...this.tasks.values()].map((task) => task.promise));
  }
}
