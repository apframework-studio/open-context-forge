import { useState } from "react";
import { ApiError, api, type AttentionDetail, type AttentionItem, type AttentionSummary } from "./api";

interface Props {
  summary: AttentionSummary;
  onAction: (item: AttentionItem, action?: "retry" | "inspect" | "keep_raw" | "resolve_metadata") => void;
  onOpenSource: (item: AttentionItem) => void;
}

export function AttentionCenter({ summary, onAction, onOpenSource }: Props) {
  const [details, setDetails] = useState<Record<string, AttentionDetail>>({});
  const [detailError, setDetailError] = useState<string | null>(null);
  async function openDetail(item: AttentionItem) {
    if (details[item.id]) { setDetails((current) => {
      const next = { ...current }; delete next[item.id]; return next;
    }); return; }
    try {
      const detail = await api<AttentionDetail>(`/attention/${encodeURIComponent(item.id)}`);
      setDetails((current) => ({ ...current, [item.id]: detail }));
      setDetailError(null);
    } catch (error) { setDetailError(error instanceof Error ? error.message : "无法读取处理详情"); }
  }
  return <section className="attention-center" aria-label="待处理事项">
    <div className="attention-center-head"><strong>待处理 · {summary.count}</strong><span>任务状态保存在本机</span></div>
    {summary.items.length === 0 ? <p>目前没有需要处理的任务。</p> :
      <div className="attention-items">{summary.items.map((item) => {
        const askUser = item.kind === "maintenance" &&
          (item.result as { recommendation?: string } | null)?.recommendation === "ask_user";
        const canInspect = item.kind === "filing" && item.stage === "reconcile" ||
          item.kind === "maintenance" && item.stage === "writing";
        const canRetry = item.kind === "maintenance" && !["writing", "metadata_sync"].includes(item.stage) && !askUser;
        const canResolveMetadata = item.kind === "maintenance" && item.stage === "metadata_sync";
        const detail = details[item.id];
        return <article className="attention-item" key={item.id}>
          <div><strong>{item.title}</strong><small>{item.vaultId ?? "全局"} · {item.kind === "filing" ? "资料入库" :
            item.kind === "metadata" ? "来源信息" : "知识维护"} · {item.stage}</small></div>
          <p>{askUser ? "需要人工判断" : canResolveMetadata ? "请核对并更新相关知识笔记中的署名和归属，然后校验完成。" :
            item.errorCode ? new ApiError(409, item.errorCode).message : "需要检查"}</p>
          <div className="action-row">
            {item.batchId && <button className="text-button" onClick={() => onOpenSource(item)}>查看来源</button>}
            {item.kind === "maintenance" && <button className="text-button" onClick={() => void openDetail(item)}>
              {detail ? "收起详情" : "查看处理详情"}</button>}
            {canInspect && <button className="secondary-button" onClick={() => onAction(item, "inspect")}>检查并恢复</button>}
            {canRetry && <button className="secondary-button" onClick={() => onAction(item, "retry")}>重试</button>}
            {askUser && <button className="secondary-button" onClick={() => onAction(item, "retry")}>重新分析</button>}
            {askUser && <button className="secondary-button" onClick={() => onAction(item, "keep_raw")}>保留原文并结束</button>}
            {canResolveMetadata && <button className="secondary-button" onClick={() => onAction(item, "resolve_metadata")}>已核对，校验并完成</button>}
            {item.kind === "lane" && <button className="secondary-button" onClick={() => onAction(item)}>继续队列</button>}
          </div>
          {detail && <div className="attention-detail">
            {detail.snapshot && <p>来源快照：{detail.snapshot}</p>}
            {detail.targets.length > 0 && <p>目标笔记：{detail.targets.join("、")}</p>}
            {detail.plan && <details><summary>编译计划 · {detail.plan.path}</summary>
              <pre>{detail.plan.markdown}</pre></details>}
            {detail.journal && <details><summary>写入日志 · {detail.journal.path}</summary>
              <pre>{JSON.stringify(detail.journal.data, null, 2)}</pre></details>}
          </div>}
        </article>;
      })}</div>}
    {detailError && <p role="alert">{detailError}</p>}
  </section>;
}
