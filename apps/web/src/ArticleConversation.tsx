import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, agentActive, type AgentProfile, type WritingMaterial, type WritingSelection } from "./api";
import { writingCitations } from "./writingCitations";
import { WorkspaceIcon } from "./WorkspaceIcon";
import { WorkbenchSelect } from "./WorkbenchSelect";
import { useArticleAgent } from "./useArticleAgent";
import { AgentProcess } from "./AgentProcess";

interface Props { articleId: string; saving: boolean; hidden: boolean; focused: boolean;
  onBeforeSend: () => Promise<boolean>; onFocus: () => void; onUseText: (text: string) => void; onUseOutline: (text: string) => void;
  onOpenProposal?: (kind: "outline" | "draft", turnId: string) => void;
  materials?: WritingMaterial[]; selections?: WritingSelection[]; contextReady?: boolean;
  onSelectionsChange?: (value: WritingSelection[]) => void; onOpenMaterials?: () => void;
  onOpenSource?: (id: string, turnId?: string, startLine?: number) => void;
  preset?: { text: string; token: number } | null }

function localOutputLink(href: string | undefined, articleId: string) {
  if (!href) return null;
  try {
    const url = new URL(href, window.location.href);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      !["http:", "https:"].includes(url.protocol) || url.search || url.hash) return null;
    const path = decodeURIComponent(url.pathname);
    const match = path.match(/\/agent-workspaces\/([^/]+)\/outputs\/([a-zA-Z0-9-]+)\/(outline|article)\.md$/);
    if (!match || match[1] !== articleId) return null;
    return { kind: match[3] === "outline" ? "outline" as const : "draft" as const, turnId: match[2] };
  } catch { return null; }
}

export function ArticleConversation({ articleId, saving, hidden, focused, onBeforeSend, onFocus, onUseText, onUseOutline,
  onOpenProposal, materials = [], selections, onSelectionsChange, onOpenMaterials, onOpenSource, contextReady = true, preset }: Props) {
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [profileId, setProfileId] = useState(() => localStorage.getItem("ocf-agent-profile") ?? "claude-current");
  const [question, setQuestion] = useState("");
  const [copied, setCopied] = useState("");
  const agent = useArticleAgent(articleId, profileId);
  const { history, run, busy, error, setError } = agent;
  const messagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const followLatest = useRef(true);
  const conversation = `${articleId}:${profileId}`;
  const currentConversation = useRef(conversation); currentConversation.current = conversation;

  useEffect(() => {
    let cancelled = false;
    void api<{ profiles: AgentProfile[] }>("/agents/profiles").then((value) => { if (!cancelled) setProfiles(value.profiles); })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "智能体状态读取失败"); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => { setQuestion(""); setCopied(""); followLatest.current = true; }, [conversation]);
  useEffect(() => { if (preset) { setQuestion(preset.text); inputRef.current?.focus(); } }, [preset]);
  useEffect(() => {
    if (followLatest.current && messagesRef.current) messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
  }, [history, busy, hidden]);
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(180, Math.max(68, input.scrollHeight))}px`;
  }, [question, hidden]);

  const selected = profiles.find((item) => item.id === profileId);
  async function send(content = question) {
    if (!content.trim() || busy || saving || !contextReady || !selected?.available) return;
    const owned = conversation;
    followLatest.current = true;
    if (await agent.send(content.trim(), onBeforeSend, selections)) {
      if (currentConversation.current === owned) setQuestion((value) => value.trim() === content.trim() ? "" : value);
    }
  }
  async function copy(id: string, content: string) {
    try { await navigator.clipboard.writeText(content); setCopied(id); } catch { setError("复制失败，请手动选择文字。"); }
  }
  const lastQuestion = history?.messages.slice().reverse().find((message) => message.role === "user")?.content;
  const retryable = run && !agentActive(run) && run.status !== "completed";

  return <aside id="article-conversation" className="article-conversation article-chat" aria-label="当前文章对话" hidden={hidden}>
    <div className="article-chat-header"><span className="article-chat-title"><WorkspaceIcon name="assistant" size={18} /><strong>AI 写作</strong></span>
      <WorkbenchSelect className="article-agent-select" disabled={busy} label="选择智能体方案" value={profileId} onChange={(value) => {
        if (busy) return;
        setProfileId(value); localStorage.setItem("ocf-agent-profile", value);
      }} options={profiles.length ? [...(!selected ? [{ value: profileId, label: "已保存方案 · 未检测到" }] : []),
        ...profiles.map((item) => ({ value: item.id, label: `${item.label}${item.available ? "" : " · 未配置"}` })),
      ] : [{ value: profileId, label: "正在检测本机智能体…" }]} />
      <button className="article-chat-focus" type="button" onClick={onFocus} aria-label={focused ? "恢复双栏" : "专注对话"} title={focused ? "恢复双栏" : "专注对话"}>
        <WorkspaceIcon name="sidebar" size={16} /><span>{focused ? "恢复双栏" : "专注对话"}</span></button></div>
    <div className="article-chat-messages" role="log" aria-label="文章讨论记录" ref={messagesRef} onScroll={() => {
      const node = messagesRef.current; if (node) followLatest.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100;
    }}>
      {!history && !error && <p className="article-chat-thinking" role="status">正在恢复文章对话…</p>}
      {history && !history.messages.length && <div className="article-chat-welcome"><span><WorkspaceIcon name="assistant" size={26} /></span>
        <h2>把想法聊成文章</h2><p>使用本机已有智能体讨论、起草和改写。对话与执行过程保存在当前文章中。</p>
        <div className="article-chat-starters">{["一起梳理这篇文章的提纲", "检查正文的论点和证据", "帮我改写开头，让表达更清楚"].map((text) =>
          <button key={text} type="button" onClick={() => { setQuestion(text); inputRef.current?.focus(); }}>{text}</button>)}</div></div>}
      <div className="article-chat-thread">{history?.messages.map((item) => {
        const execution = item.role === "assistant" ? (item.id === run?.assistantMessageId ? run : history.runs?.find((value) => value.assistantMessageId === item.id)) : undefined;
        return <div key={item.id} className={`article-chat-message ${item.role}`}>
          <span className="article-message-author">{item.role === "user" ? "你" : selected?.label || "智能体"}</span>
          {execution && <AgentProcess run={execution} seconds={execution.id === run?.id ? agent.seconds : undefined}
            connecting={agent.connecting} onAnswer={(requestId, optionId) => void agent.answer(requestId, optionId)} />}
          {item.role === "user" && !!item.context?.sources.length && <div className="article-message-sources" aria-label="此条消息引用资料">{item.context.sources.map((source) =>
            <button key={source.id} type="button" onClick={() => onOpenSource?.(source.id, item.context!.id, source.startLine)} title={`${source.vaultId}/${source.path}`}>
              <b>{source.id}</b> {source.title}{source.startLine && <small> · L{source.startLine}–{source.endLine ?? "末尾"}</small>}</button>)}</div>}
          <div className="article-message-content">{item.role === "assistant" ? <div className="markdown-body"><Markdown remarkPlugins={[remarkGfm, writingCitations]} skipHtml
            components={{ a: ({ href, children, ...rest }) => {
              const id = href?.match(/^#writing-source=(S\d+)$/)?.[1];
              const source = id && item.context?.sources.find((s) => s.id === id);
              if (id) return source ? <button type="button" className="writing-citation" onClick={() => onOpenSource?.(id, item.context!.id, source.startLine)}>{children}</button> : <span title="这条消息没有该来源快照">{children}</span>;
              const output = localOutputLink(href, articleId);
              if (output) return <button type="button" className="writing-citation" onClick={() => onOpenProposal?.(output.kind, output.turnId)}>{children}</button>;
              return <a {...rest} href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
            } }}>{item.content}</Markdown></div> : <p>{item.content}</p>}</div>
          {item.role === "assistant" && item.content && <div className="article-message-actions"><button type="button" onClick={() => void copy(item.id, item.content)}>{copied === item.id ? "已复制" : "复制"}</button>
            {(!execution || execution.status === "completed") && <><button type="button" onClick={() => onUseOutline(item.content)}>用作大纲</button>
              <button type="button" onClick={() => onUseText(item.content)}>用作正文</button></>}</div>}
        </div>;
      })}
        {agent.sending && <div className="article-chat-thinking" role="status"><i />正在保存文章并提交任务…</div>}
        {retryable && lastQuestion && <button className="agent-retry" type="button" disabled={busy || saving} onClick={() => void send(lastQuestion)}>重新发送上一条</button>}
      </div>
    </div>
    <div className="article-chat-bottom">{error && <p className="inline-message error" role="alert">{error}</p>}
      {selected && !selected.available && <p className="article-chat-unavailable">{selected.reason || "当前方案尚未配置，请选择可用智能体。"}</p>}
      {selections && <><div className="article-pending-sources" aria-label="本轮引用资料">
        <span>{selections.length ? `本轮 ${selections.length} 篇` : "本轮未附资料"}</span>{selections.map((ref) => {
          const item = materials.find((m) => m.id === ref.materialId); if (!item) return null;
          return <span className="article-source-chip" key={item.id}><button type="button" onClick={() => onOpenSource?.(item.id, undefined, ref.startLine)} title={`${item.vaultId}/${item.path}`}>
            <b>{item.id}</b> {item.title}{ref.startLine && ` · L${ref.startLine}–${ref.endLine ?? "末尾"}`}</button>
            <button type="button" aria-label={`本轮移除 ${item.id}`} title="仅移出本轮，历史对话仍保留" onClick={() => onSelectionsChange?.(selections.filter((s) => s.materialId !== item.id))}>×</button></span>;
        })}<button type="button" className="text-button" onClick={onOpenMaterials}>＋ 选材</button>
        {materials.length > selections.length && <button type="button" className="text-button" onClick={() => onSelectionsChange?.(materials.map((m) => ({ materialId: m.id })))}>引用全部</button>}</div>
        <div className="article-discussion-modes" aria-label="阅读讨论方式">{["主题阅读", "对照理解", "整理大纲"].map((label, index) => <button type="button" key={label} onClick={() => {
          const text = ["请围绕共同主题阅读本轮资料，整理核心观点、证据与分歧，使用 [S编号] 标注来源。", "请对照本轮资料的观点、方法和适用边界，说明共识与分歧，使用 [S编号] 标注来源。", "请基于本轮资料和我们的讨论，整理可审阅的文章大纲。先给出主线、章节与对应证据，暂不写正文。"];
          setQuestion(text[index]); inputRef.current?.focus();
        }}>{label}</button>)}<small>历史对话继续保留</small></div></>}
      <form className="article-chat-composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <label className="sr-only" htmlFor="agent-question">向智能体提问</label>
        <textarea ref={inputRef} id="agent-question" value={question} onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }}
          placeholder={busy ? "可以先输入下一条想法，或停止当前生成…" : "描述你想写什么，或继续讨论这篇文章…"} rows={2} maxLength={10000} disabled={!selected?.available} />
        <div className="article-chat-composer-footer"><span>{run && agentActive(run) ? `${agent.connecting ? "连接恢复中" : "本机运行中"} · ${agent.seconds} 秒` : "Enter 发送 · Shift + Enter 换行"}</span>
          {agentActive(run) ? <button className="agent-stop" type="button" onClick={() => void agent.cancel()}>■ 停止生成</button> :
            <button className="primary-button" type="submit" aria-label="发送消息" disabled={busy || saving || !contextReady || !history || !question.trim() || !selected?.available}>{agent.sending ? "提交中…" : "发送 ↑"}</button>}
        </div>
      </form><small className="article-chat-footnote">{agentActive(run) ? "切换文章后任务继续，回来可恢复过程与输出。" : "智能体产出经审阅后采用，正文与发布由工作台管理。"}</small>
    </div>
  </aside>;
}
