import { useEffect, useRef, useState } from "react";
import { api, type AgentHistory, type AgentProfile } from "./api";
import { WorkspaceIcon } from "./WorkspaceIcon";

interface Props { articleId: string; articleReady: boolean; collapsed: boolean; onCollapse: () => void }

export function ArticleConversation({ articleId, articleReady, collapsed, onCollapse }: Props) {
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [profileId, setProfileId] = useState(() => localStorage.getItem("ocf-agent-profile") ?? "claude-current");
  const [history, setHistory] = useState<AgentHistory | null>(null);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const currentConversation = useRef("");
  currentConversation.current = `${articleId}:${profileId}`;

  useEffect(() => {
    let cancelled = false;
    void api<{ profiles: AgentProfile[] }>("/agents/profiles")
      .then((value) => { if (!cancelled) setProfiles(value.profiles); })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "智能体状态读取失败"); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setHistory(null);
    setError("");
    void api<AgentHistory>(`/articles/${articleId}/agent?profileId=${encodeURIComponent(profileId)}`)
      .then((value) => { if (!cancelled) setHistory(value); })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "对话读取失败"); });
    return () => { cancelled = true; };
  }, [articleId, profileId]);

  const selected = profiles.find((item) => item.id === profileId);

  async function send() {
    if (!articleReady || !question.trim() || busy || !selected?.available) return;
    const conversation = `${articleId}:${profileId}`;
    setBusy(true); setError("");
    try {
      const value = await api<AgentHistory>(`/articles/${articleId}/agent/messages`, {
        method: "POST", body: { profileId, content: question.trim() },
      });
      if (currentConversation.current === conversation) { setHistory(value); setQuestion(""); }
    } catch (cause) { if (currentConversation.current === conversation) setError(cause instanceof Error ? cause.message : "发送失败"); }
    finally { setBusy(false); }
  }

  return <aside id="article-conversation" className="context-panel article-conversation" aria-label="当前文章对话" hidden={collapsed}>
    <div className="panel-head"><span className="panel-title"><span className="panel-dot" />AI 写作对话</span>
      <button className="chrome-button panel-collapse" type="button" onClick={onCollapse}
        aria-label="收起文章对话" title="收起文章对话"><WorkspaceIcon name="chevronRight" size={17} /></button>
    </div>
    <div className="agent-panel-body">
      <div className="agent-kicker">当前方案</div>
      <select className="agent-select" aria-label="选择智能体方案" value={profileId} onChange={(event) => {
        setProfileId(event.target.value); localStorage.setItem("ocf-agent-profile", event.target.value);
      }}>
        {profiles.length ? profiles.map((item) => <option key={item.id} value={item.id}>{item.label}{item.available ? "" : " · 未配置"}</option>) : <option value="claude-current">正在检测本机智能体…</option>}
      </select>
      {selected && <p className={`agent-profile-note ${selected.available ? "ready" : ""}`}>
        <span className="status-dot" />{selected.available ? "已发现，可尝试连接" : selected.reason}<br />{selected.description}
      </p>}
      <div className="agent-divider" />
      <div className="agent-kicker">文章讨论</div>
        {!articleReady && <p className="agent-hint">请先保存当前正文；保存完成后即可提问。</p>}
        <div className="agent-messages" role="log" aria-label="文章讨论记录">
          {history?.messages.length ? history.messages.map((item) => <div key={item.id} className={`agent-message ${item.role}`}>
            <span>{item.role === "user" ? "你" : "智能体建议"}</span><p>{item.content}</p>
          </div>) : <div className="agent-empty">试着问：“这篇文章的结论有哪些证据支持？”</div>}
          {busy && <div className="agent-thinking">Claude 正在整理建议…</div>}
        </div>
        <form className="agent-composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
          <label htmlFor="agent-question">向智能体提问</label>
          <textarea id="agent-question" value={question} onChange={(event) => setQuestion(event.target.value)}
            placeholder="分析证据、检查论点或讨论改写…" rows={4} maxLength={10000} disabled={busy || !articleReady || !selected?.available} />
          <button className="primary-button" type="submit" disabled={busy || !articleReady || !question.trim() || !selected?.available}>{busy ? "处理中…" : "发送问题"}</button>
          <small>讨论基于已保存正文；回答仅作为建议，不会自动修改文章。</small>
        </form>
      {error && <p className="inline-message error" role="alert">{error}</p>}
    </div>
  </aside>;
}
