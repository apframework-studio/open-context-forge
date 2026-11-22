import { ApiError, agentErrorMessage, type AgentRun } from "./api";
import { useLocale } from "./locale";

const activityTranslations = new Map([
  ["本机服务已重启，保留已有输出，可重新发送", "The local service restarted. Partial output is saved. You can resend the request."],
  ["正在连接本机智能体…", "Connecting to the local assistant…"],
  ["智能体正在处理当前文章", "The assistant is working on this article"],
  ["已完成", "Completed"],
  ["已停止", "Stopped"],
  ["执行失败，已有输出已保留", "The run failed. Partial output is saved."],
  ["已停止，保留已有输出", "Stopped. Partial output is saved."],
  ["文章已被永久删除，请返回文章列表。", "This article was permanently deleted. Return to the article list."],
]);

export function AgentProcess({ run, seconds, connecting, onAnswer }: { run: AgentRun; seconds?: number; connecting?: boolean;
  onAnswer: (requestId: string, optionId: string) => void }) {
  const { t, errorText } = useLocale();
  const toolStatus: Record<string, string> = { pending: t("待执行", "Pending"), in_progress: t("进行中", "In progress"), completed: t("完成", "Completed"), failed: t("失败", "Failed") };
  const runStatus = { running: t("运行中", "Running"), waiting_permission: t("等待确认", "Awaiting approval"), completed: t("已完成", "Completed"),
    failed: t("执行失败", "Failed"), cancelled: t("已停止", "Stopped"), interrupted: t("已中断", "Interrupted") };
  const operationTitle = (title: string) => title === "工具操作" ? t("工具操作", "Tool operation") : title;
  return <div className={`agent-process ${run.status}`}>
    <details><summary><span className="agent-process-indicator" />
      <span>{run.tools.length ? t(`${run.tools.length} 项操作`, `${run.tools.length} ${run.tools.length === 1 ? "operation" : "operations"}`) : t("执行过程", "Run details")}</span>
      <span className="agent-process-summary">{runStatus[run.status]}{seconds !== undefined ? t(` · ${seconds} 秒`, ` · ${seconds} s`) : ""}</span>
    </summary><div className="agent-process-content">
      {run.activity && <p className="agent-process-activity">{connecting ? t("连接中，任务在本机继续运行…", "Reconnecting. The task is still running locally…") : t(run.activity, activityTranslations.get(run.activity) ?? run.activity)}</p>}
      {run.tools.map((tool) => <details key={tool.id} className="agent-tool"><summary><span>{operationTitle(tool.title)}</span><small data-state={tool.status}>{toolStatus[tool.status] ?? tool.status}</small></summary>
        {tool.detail ? <pre>{tool.detail}</pre> : <p>{t("此工具未返回可展示的详细内容。", "This tool returned no details.")}</p>}</details>)}
    </div></details>
    {run.permissions.map((request) => <div className="agent-permission" key={request.id} role="group" aria-label={t("智能体操作确认", "Assistant permission request")}><strong>{operationTitle(request.title)}</strong>
      <p>{t("智能体请求执行此操作，请选择处理方式。", "The assistant needs permission to perform this operation.")}</p><div>{request.options.map((option) =>
        <button type="button" key={option.optionId} onClick={() => onAnswer(request.id, option.optionId)}>{option.name}</button>)}</div></div>)}
    {run.errorCode && <p className="agent-run-error">{errorText(new ApiError(0, run.errorCode), agentErrorMessage(run.errorCode), "The assistant encountered an error.")}</p>}
    {(run.status === "cancelled" || run.status === "interrupted") && run.text && <small className="agent-partial-note">{t("以下为未完成的部分输出。", "The output below is incomplete.")}</small>}
  </div>;
}
