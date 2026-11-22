import { useEffect, useRef, useState } from "react";
import { api, agentActive, type AgentHistory, type AgentRun, type WritingSelection } from "./api";
import { useLocale, type LocalizedError } from "./locale";

// The server owns execution. Unmounting only closes the UI subscription.
export function useArticleAgent(articleId: string, profileId: string) {
  const { errorText } = useLocale();
  const [history, setHistory] = useState<AgentHistory | null>(null);
  const [loadedKey, setLoadedKey] = useState("");
  const [error, setError] = useState<LocalizedError | null>(null);
  const [sending, setSending] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [now, setNow] = useState(Date.now());
  const key = `${articleId}:${profileId}`;
  const generation = useRef({ key, version: 0 });
  if (generation.current.key !== key) generation.current = { key, version: generation.current.version + 1 };
  const ownership = `${key}:${generation.current.version}`;
  const current = useRef(ownership); current.current = ownership;
  const submitting = useRef<string | null>(null);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const base = `/articles/${articleId}/agent`;
  const visibleHistory = loadedKey === key ? history : null;
  const run = visibleHistory?.run;
  const busy = sending || agentActive(run);

  useEffect(() => {
    let disposed = false;
    let readVersion = 0;
    setHistory(null); setError(null); setSending(false); setConnecting(false);
    if (!profileId) return;
    const refresh = async () => {
      const version = ++readVersion;
      try {
        const value = await api<AgentHistory>(`${base}?profileId=${encodeURIComponent(profileId)}`);
        if (disposed || version !== readVersion) return;
        setHistory((previous) => {
          const newer = previous?.run && previous.run.id === value.run?.id && previous.run.seq > value.run.seq ? previous.run : null;
          return newer ? { ...value, run: newer, runs: value.runs?.map((item) => item.id === newer.id ? newer : item),
            messages: value.messages.map((item) => item.id === newer.assistantMessageId ? { ...item, content: newer.text } : item) } : value;
        });
        setLoadedKey(key);
      } catch (cause) { if (!disposed && version === readVersion) setError([cause, "对话读取失败", "Could not load the conversation"]); }
    };
    const invalidate = (event: Event) => { if ((event as CustomEvent<string>).detail === key) void refresh(); };
    window.addEventListener("ocf-agent-run-started", invalidate);
    void refresh();
    return () => { disposed = true; window.removeEventListener("ocf-agent-run-started", invalidate); };
  }, [key]);

  const activeId = agentActive(run) ? run!.id : null;
  useEffect(() => {
    if (!activeId) { setConnecting(false); return; }
    let disposed = false;
    setConnecting(true);
    const stream = new EventSource(`/api/v1${base}/runs/${activeId}/events`);
    stream.onopen = () => { if (!disposed) setConnecting(false); };
    stream.onerror = () => { if (!disposed) setConnecting(true); };
    stream.addEventListener("removed", () => {
      if (disposed || current.current !== ownership) return;
      const message = "文章已被永久删除，请返回文章列表。";
      setError([undefined, message, "This article was permanently deleted. Return to the article list."]); setConnecting(false);
      setHistory((previous) => previous?.run?.id === activeId ? { ...previous,
        run: { ...previous.run, status: "interrupted", errorCode: "ARTICLE_NOT_FOUND", activity: message, permissions: [] } } : previous);
      stream.close();
    });
    stream.addEventListener("snapshot", (event) => {
      if (disposed || current.current !== ownership) return;
      try {
        const update = JSON.parse((event as MessageEvent).data) as AgentRun;
        if (update.id !== activeId || update.articleId !== articleId || update.profileId !== profileId) return;
        setHistory((previous) => {
          if (!previous || previous.run?.id !== activeId || (previous.run.seq ?? -1) > update.seq) return previous;
          return { ...previous, run: update, runs: previous.runs?.map((item) => item.id === update.id ? update : item),
            messages: previous.messages.map((message) => message.id === update.assistantMessageId ? { ...message, content: update.text } : message) };
        });
        setConnecting(false);
        if (!agentActive(update)) stream.close();
      } catch { setError([undefined, "执行事件格式异常，请刷新恢复对话。", "The agent sent an invalid update. Refresh to restore the conversation."]); stream.close(); }
    });
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { disposed = true; stream.close(); window.clearInterval(clock); };
  }, [key, activeId]);

  async function send(content: string, before: () => Promise<boolean>, selections?: WritingSelection[]): Promise<boolean> {
    if (busy || !visibleHistory || submitting.current === ownership) return false;
    const ownedKey = ownership;
    submitting.current = ownedKey;
    setSending(true); setError(null);
    try {
      if (!(await before())) {
        if (mounted.current && current.current === ownedKey) setError([undefined, "正文暂未保存成功，请稍后重试。", "The article could not be saved. Try again shortly."]);
        return false;
      }
      if (!mounted.current || current.current !== ownedKey) return false;
      const started = await api<AgentRun>(`${base}/runs`, { method: "POST", body: { profileId, content, ...(selections === undefined ? {} : { selections }) } });
      if (!mounted.current || current.current !== ownedKey) {
        // A replacement subscriber may have read history before this POST was accepted.
        window.dispatchEvent(new CustomEvent("ocf-agent-run-started", { detail: key }));
        return true;
      }
      setHistory((previous) => previous ? { ...previous, run: started, runs: [started, ...(previous.runs ?? [])], messages: [
        ...previous.messages, { id: `${started.id}-user`, role: "user", content, createdAt: started.createdAt, context: started.context },
        { id: started.assistantMessageId, role: "assistant", content: started.text, createdAt: started.createdAt, context: started.context },
      ] } : previous);
      setNow(Date.now());
      return true;
    } catch (cause) {
      if (mounted.current && current.current === ownedKey) setError([cause, "发送失败", "Could not send the message"]);
      return false;
    } finally {
      if (submitting.current === ownedKey) submitting.current = null;
      if (mounted.current && current.current === ownedKey) setSending(false);
    }
  }

  async function control(action: "cancel" | "permission", body?: unknown) {
    if (!run) return;
    const ownedKey = ownership;
    try {
      const value = await api<AgentRun>(`${base}/runs/${run.id}/${action}`, { method: "POST", body });
      if (current.current === ownedKey) setHistory((old) => old?.run?.id === value.id && old.run.seq <= value.seq ? {
        ...old, run: value, runs: old.runs?.map((item) => item.id === value.id ? value : item),
        messages: old.messages.map((item) => item.id === value.assistantMessageId ? { ...item, content: value.text } : item),
      } : old);
    } catch (cause) { if (current.current === ownedKey) setError([cause, "操作失败", "Could not complete the action"]); }
  }

  const seconds = run ? Math.max(0, Math.floor(((agentActive(run) ? Math.max(now, Date.now()) : new Date(run.updatedAt).getTime()) - new Date(run.createdAt).getTime()) / 1000)) : 0;
  return { history: visibleHistory, run, busy, sending, connecting, seconds, error: error ? errorText(...error) : "", setError, send,
    cancel: () => control("cancel"), answer: (requestId: string, optionId: string) => control("permission", { requestId, optionId }) };
}
