import { useState } from "react";
import { ApiError, api, type AttentionDetail, type AttentionItem, type AttentionSummary } from "./api";
import { useLocale, type LocalizedError } from "./locale";

interface Props {
  summary: AttentionSummary;
  onAction: (item: AttentionItem, action?: "retry" | "inspect" | "keep_raw" | "resolve_metadata") => void;
  onOpenSource: (item: AttentionItem) => void;
}

export function AttentionCenter({ summary, onAction, onOpenSource }: Props) {
  const { t, errorText } = useLocale();
  const [details, setDetails] = useState<Record<string, AttentionDetail>>({});
  const [detailError, setDetailError] = useState<LocalizedError | null>(null);
  async function openDetail(item: AttentionItem) {
    if (details[item.id]) { setDetails((current) => {
      const next = { ...current }; delete next[item.id]; return next;
    }); return; }
    try {
      const detail = await api<AttentionDetail>(`/attention/${encodeURIComponent(item.id)}`);
      setDetails((current) => ({ ...current, [item.id]: detail }));
      setDetailError(null);
    } catch (error) { setDetailError([error, "无法读取处理详情", "Could not load task details."]); }
  }
  return <section className="attention-center" aria-label={t("需处理事项", "Tasks that need attention")}>
    <div className="attention-center-head"><strong>{t(`需处理 ${summary.count} 项`, `${summary.count} to review`)}</strong></div>
    {summary.items.length === 0 ? <p>{t("目前没有需要处理的任务。", "No tasks need your attention.")}</p> :
      <div className="attention-items">{summary.items.map((item) => {
        const askUser = item.kind === "maintenance" &&
          (item.result as { recommendation?: string } | null)?.recommendation === "ask_user";
        const canInspect = item.kind === "filing" && item.stage === "reconcile" ||
          item.kind === "maintenance" && item.stage === "writing";
        const canRetry = item.kind === "maintenance" && !["writing", "metadata_sync"].includes(item.stage) && !askUser;
        const canResolveMetadata = item.kind === "maintenance" && item.stage === "metadata_sync";
        const detail = details[item.id];
        return <article className="attention-item" key={item.id}>
          <div><strong>{item.title}</strong><small>{item.kind === "filing" ? t("资料入库", "Source filing") :
            item.kind === "metadata" ? t("来源信息", "Source details") : item.kind === "analysis" ? t("智能摘要", "Smart summary") :
            t("知识库维护", "Knowledge base maintenance")}
            {item.vaultId && t(`（${item.vaultId}）`, ` (${item.vaultId})`)}</small></div>
          <p>{askUser ? t("需要人工判断", "Review needed") : canResolveMetadata ?
            t("请核对并更新相关知识笔记中的署名和归属，然后校验完成。", "Review and update the author and attribution in the related notes, then validate them.") :
            errorText(item.errorCode ? new ApiError(409, item.errorCode) : null, "需要检查", "Needs review")}</p>
          <div className="action-row">
            {item.batchId && <button className="text-button" onClick={() => onOpenSource(item)}>{t("查看来源", "View source")}</button>}
            {item.kind === "maintenance" && <button className="text-button" onClick={() => void openDetail(item)}>
              {detail ? t("收起详情", "Hide details") : t("查看处理详情", "View task details")}</button>}
            {canInspect && <button className="secondary-button" onClick={() => onAction(item, "inspect")}>{t("检查并恢复", "Review and resume")}</button>}
            {canRetry && <button className="secondary-button" onClick={() => onAction(item, "retry")}>{t("重试", "Retry")}</button>}
            {askUser && <button className="secondary-button" onClick={() => onAction(item, "retry")}>{t("重新分析", "Analyze again")}</button>}
            {askUser && <button className="secondary-button" onClick={() => onAction(item, "keep_raw")}>{t("保留原文并结束", "Keep the source and finish")}</button>}
            {canResolveMetadata && <button className="secondary-button" onClick={() => onAction(item, "resolve_metadata")}>{t("已核对，校验并完成", "Validate and finish")}</button>}
            {item.kind === "lane" && <button className="secondary-button" onClick={() => onAction(item)}>{t("继续队列", "Resume queue")}</button>}
          </div>
          {detail && <div className="attention-detail">
            {detail.snapshot && <p>{t("来源快照：", "Source snapshot: ")}{detail.snapshot}</p>}
            {detail.targets.length > 0 && <p>{t("目标笔记：", "Target notes: ")}{detail.targets.join(t("、", ", "))}</p>}
            {detail.plan && <details><summary>{t("编译计划 ·", "Compilation plan")} {detail.plan.path}</summary>
              <pre>{detail.plan.markdown}</pre></details>}
            {detail.journal && <details><summary>{t("写入日志 ·", "Write log")} {detail.journal.path}</summary>
              <pre>{JSON.stringify(detail.journal.data, null, 2)}</pre></details>}
          </div>}
        </article>;
      })}</div>}
    {detailError && <p role="alert">{errorText(...detailError)}</p>}
  </section>;
}
