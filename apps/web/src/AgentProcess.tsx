import { agentActive, agentErrorMessage, type AgentRun } from "./api";
const toolStatus: Record<string, string> = { pending: "待执行", in_progress: "进行中", completed: "完成", failed: "失败" };
const runStatus: Record<string, string> = { running: "运行中", waiting_permission: "等待确认", completed: "已完成", failed: "执行失败", cancelled: "已停止", interrupted: "已中断" };

export function AgentProcess({ run, seconds, connecting, onAnswer }: { run: AgentRun; seconds?: number; connecting?: boolean;
  onAnswer: (requestId: string, optionId: string) => void }) {
  return <div className={`agent-process ${run.status}`}>
    <details open={agentActive(run)}><summary><span className="agent-process-indicator" />
      <span>{run.tools.length ? `${run.tools.length} 项操作` : "执行过程"}</span><span className="agent-process-summary">{runStatus[run.status]}{seconds !== undefined ? ` · ${seconds} 秒` : ""}</span>
    </summary><div className="agent-process-content">
      {run.activity && <p className="agent-process-activity">{connecting ? "连接中，任务在本机继续运行…" : run.activity}</p>}
      {run.tools.map((tool) => <details key={tool.id} className="agent-tool"><summary><span>{tool.title}</span><small data-state={tool.status}>{toolStatus[tool.status] ?? tool.status}</small></summary>
        {tool.detail ? <pre>{tool.detail}</pre> : <p>此工具未返回可展示的详细内容。</p>}</details>)}
    </div></details>
    {run.permissions.map((request) => <div className="agent-permission" key={request.id} role="group" aria-label="智能体操作确认"><strong>{request.title}</strong>
      <p>智能体请求执行此操作，请选择处理方式。</p><div>{request.options.map((option) =>
        <button type="button" key={option.optionId} onClick={() => onAnswer(request.id, option.optionId)}>{option.name}</button>)}</div></div>)}
    {run.errorCode && <p className="agent-run-error">{agentErrorMessage(run.errorCode)}</p>}
    {(run.status === "cancelled" || run.status === "interrupted") && run.text && <small className="agent-partial-note">以下为未完成的部分输出。</small>}
  </div>;
}
