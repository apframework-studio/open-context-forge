import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Markdown from "react-markdown";
import { manuscriptFromUnmarkedReply } from "./articleMarkdown";
import remarkGfm from "remark-gfm";
import { api, agentActive, type AgentProfile, type WritingMaterial, type WritingSelection } from "./api";
import { writingCitations } from "./writingCitations";
import { WorkspaceIcon } from "./WorkspaceIcon";
import { WorkbenchSelect } from "./WorkbenchSelect";
import { useArticleAgent } from "./useArticleAgent";
import { AgentProcess } from "./AgentProcess";
import { useLocale, type LocalizedError } from "./locale";

interface Props { articleId: string; saving: boolean; hidden: boolean; focused: boolean;
  onBeforeSend: () => Promise<boolean>; onFocus: () => void; onUseText: (text: string) => void; onUseOutline: (text: string) => void;
  onOpenProposal?: (kind: "outline" | "draft", turnId: string) => void;
  materials?: WritingMaterial[]; selections?: WritingSelection[]; contextReady?: boolean;
  onSelectionsChange?: (value: WritingSelection[]) => void; onOpenMaterials?: () => void;
  onOpenSource?: (id: string, turnId?: string, startLine?: number) => void;
  preset?: { text: string; token: number } | null }

const profilePreferenceKey = "ocf-agent-profile";
const questionLimit = 10000;
const draftChange = "ocf-article-chat-draft-changed";
const emptyDraft = { text: "" };
const composerDrafts = new Map<string, typeof emptyDraft>();
const profileTranslations = new Map([
  ["Claude CLI · 当前登录", "Claude CLI · Current sign-in"],
  ["Codex · 本机登录", "Codex · Local sign-in"],
  ["未发现 Claude CLI；可设置 OCF_CLAUDE_PATH", "Claude CLI was not found. Set OCF_CLAUDE_PATH to its location."],
  ["尚未设置 OCF_DEEPSEEK_API_KEY", "Set OCF_DEEPSEEK_API_KEY to use this profile."],
  ["未发现 Claude CLI", "Claude CLI was not found."],
  ["尚未设置 OCF_ANTHROPIC_API_KEY", "Set OCF_ANTHROPIC_API_KEY to use this profile."],
  ["未发现 Codex；可设置 OCF_CODEX_PATH", "Codex was not found. Set OCF_CODEX_PATH to its location."],
]);

function readDraft(key: string) {
  const current = composerDrafts.get(key);
  if (current) return current;
  let text = "";
  try { text = sessionStorage.getItem(key) ?? ""; } catch { /* Drafting still works in memory. */ }
  if (!text) return emptyDraft;
  const draft = { text };
  composerDrafts.set(key, draft);
  return draft;
}

function writeDraft(key: string, text: string) {
  if (text) composerDrafts.set(key, { text });
  else composerDrafts.delete(key);
  try {
    if (text) sessionStorage.setItem(key, text);
    else sessionStorage.removeItem(key);
  } catch { /* Drafting still works in memory. */ }
  window.dispatchEvent(new Event(draftChange));
}

function subscribeToDrafts(onChange: () => void) {
  window.addEventListener(draftChange, onChange);
  return () => window.removeEventListener(draftChange, onChange);
}

function initialProfile(profiles: AgentProfile[], saved: string | null) {
  const available = profiles.filter((profile) => profile.available);
  return (available.find((profile) => profile.id === saved) ??
    available.find((profile) => profile.id === "claude-current") ??
    available.find((profile) => profile.id === "codex-current") ??
    available[0] ?? profiles.find((profile) => profile.id === saved) ?? profiles[0])?.id ?? "";
}

function localOutputLink(href: string | undefined, articleId: string) {
  if (!href) return null;
  const relative = href.match(/^(?:\.\/)?outputs\/([a-zA-Z0-9-]+)\/(outline|article)\.md$/);
  if (relative) return { kind: relative[2] === "outline" ? "outline" as const : "draft" as const, turnId: relative[1] };
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
  const { t, errorText } = useLocale();
  const [profiles, setProfiles] = useState<AgentProfile[] | null>(null);
  const [profileId, setProfileId] = useState("");
  const [profileError, setProfileError] = useState<LocalizedError | null>(null);
  const [suggestion, setSuggestion] = useState("");
  const draftKey = `ocf-article-chat-draft:${articleId}`;
  const draft = useSyncExternalStore(subscribeToDrafts, () => readDraft(draftKey));
  const question = draft.text;
  const [copied, setCopied] = useState("");
  const agent = useArticleAgent(articleId, profileId);
  const { history, run, busy, error, setError } = agent;
  const messagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const suggestionRef = useRef<HTMLDivElement>(null);
  const seenPreset = useRef<Props["preset"]>(null);
  const followLatest = useRef(true);
  const conversation = `${articleId}:${profileId}`;

  useEffect(() => {
    let cancelled = false;
    void api<{ profiles: AgentProfile[] }>("/agents/profiles").then(({ profiles }) => {
      if (cancelled) return;
      let saved = null;
      try { saved = localStorage.getItem(profilePreferenceKey); } catch { /* The default still works. */ }
      setProfileId(initialProfile(profiles, saved));
      setProfiles(profiles);
    }).catch((cause) => {
      if (!cancelled) setProfileError([cause, "智能体状态读取失败，请刷新后重试。", "Could not check assistant availability. Refresh and try again."]);
    });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => { setCopied(""); followLatest.current = true; }, [conversation]);
  useEffect(() => {
    if (preset && seenPreset.current !== preset) {
      seenPreset.current = preset;
      offerPrompt(preset.text);
    }
  }, [preset]);
  useEffect(() => { if (suggestion) suggestionRef.current?.focus(); }, [suggestion]);
  useEffect(() => {
    if (followLatest.current && messagesRef.current) messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
  }, [history, busy, hidden]);
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(180, Math.max(68, input.scrollHeight))}px`;
  }, [question, hidden]);

  const selected = profiles?.find((item) => item.id === profileId);
  const hasAvailableProfile = profiles?.some((item) => item.available);
  const canSend = history && !busy && !saving && contextReady && selected?.available;
  const insertion = question ? `${question}\n\n${suggestion}` : suggestion;

  function offerPrompt(text: string) {
    if (readDraft(draftKey).text) {
      setSuggestion(text);
    } else {
      setSuggestion("");
      writeDraft(draftKey, text);
      inputRef.current?.focus();
    }
  }

  async function send(content: string, submittedDraft?: typeof emptyDraft) {
    if (!content.trim() || !canSend) return;
    followLatest.current = true;
    if (await agent.send(content.trim(), onBeforeSend, selections) && submittedDraft && readDraft(draftKey) === submittedDraft) {
      // Clear only the edit that was submitted, even if the article panel has since remounted.
      writeDraft(draftKey, "");
    }
  }
  async function copy(id: string, content: string) {
    try { await navigator.clipboard.writeText(content); setCopied(id); } catch { setError([undefined, "复制失败，请手动选择文字。", "Could not copy the text. Select it manually to copy."]); }
  }
  const lastQuestion = history?.messages.slice().reverse().find((message) => message.role === "user")?.content;
  const retryable = run && !agentActive(run) && run.status !== "completed";
  const profileText = (text: string) => t(text, profileTranslations.get(text) ?? text);
  const focusAction = focused ? t("恢复双栏", "Return to split view") : t("专注对话", "Focus on conversation");

  return <aside id="article-conversation" className="article-conversation article-chat" aria-label={t("当前文章对话", "Article conversation")} hidden={hidden}>
    <div className="article-chat-header"><span className="article-chat-title"><WorkspaceIcon name="assistant" size={18} /><strong>{t("AI 写作", "AI Writing")}</strong></span>
      <WorkbenchSelect className="article-agent-select" disabled={busy || !profiles?.length} label={t("选择智能体方案", "Choose an assistant profile")} value={profileId} onChange={(value) => {
        if (busy || !value) return;
        setProfileId(value);
        try { localStorage.setItem(profilePreferenceKey, value); } catch { /* The current choice still works. */ }
      }} options={profiles?.length ? profiles.map((item) => ({ value: item.id, label: `${profileText(item.label)}${item.available ? "" : t(" · 未配置", " · Unconfigured")}` })) :
        [{ value: "", label: profiles ? t("暂无智能体方案", "No assistant profiles") : profileError ? t("智能体检测失败", "Could not detect assistants") : t("正在检测本机智能体…", "Checking local assistants…") }]} />
      <button className="article-chat-focus" type="button" onClick={onFocus} aria-label={focusAction} title={focusAction}>
        <WorkspaceIcon name="sidebar" size={16} /><span>{focusAction}</span></button></div>
    <div className="article-chat-messages" role="log" aria-label={t("文章讨论记录", "Article discussion history")} ref={messagesRef} onScroll={() => {
      const node = messagesRef.current; if (node) followLatest.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100;
    }}>
      {profileId && !history && !error && <p className="article-chat-thinking" role="status">{t("正在恢复文章对话…", "Restoring the article conversation…")}</p>}
      {history && !history.messages.length && <div className="article-chat-welcome"><span><WorkspaceIcon name="assistant" size={26} /></span>
        <h2>{t("把想法聊成文章", "Turn an idea into an article")}</h2><p>{t("使用本机已有智能体讨论、起草和改写。对话与执行过程保存在当前文章中。", "Discuss, draft, and revise with a local assistant. This article keeps the conversation and run history.")}</p>
        <div className="article-chat-starters">{[
          ["一起梳理这篇文章的提纲", "Outline this article together"],
          ["检查正文的论点和证据", "Review the claims and evidence"],
          ["帮我改写开头，让表达更清楚", "Rewrite the opening for clarity"],
        ].map(([text, label]) => <button key={text} type="button" onClick={() => offerPrompt(t(text, label))}>{t(text, label)}</button>)}</div></div>}
      <div className="article-chat-thread">{history?.messages.map((item) => {
        const execution = item.role === "assistant" ? (item.id === run?.assistantMessageId ? run : history.runs?.find((value) => value.assistantMessageId === item.id)) : undefined;
        return <div key={item.id} className={`article-chat-message ${item.role}`}>
          <span className="article-message-author">{item.role === "user" ? t("你", "You") : selected?.label ? profileText(selected.label) : t("智能体", "Assistant")}</span>
          {execution && <AgentProcess run={execution} seconds={execution.id === run?.id ? agent.seconds : undefined}
            connecting={agent.connecting} onAnswer={(requestId, optionId) => void agent.answer(requestId, optionId)} />}
          {item.role === "user" && !!item.context?.sources.length && <div className="article-message-sources" aria-label={t("此条消息引用资料", "Sources cited in this message")}>{item.context.sources.map((source) =>
            <button key={source.id} type="button" onClick={() => onOpenSource?.(source.id, item.context!.id, source.startLine)} title={`${source.vaultId}/${source.path}`}>
              <b>{source.id}</b> {source.title}{source.startLine && <small> · L{source.startLine}–{source.endLine ?? t("末尾", "end")}</small>}</button>)}</div>}
          <div className="article-message-content">{item.role === "assistant" ? <div className="markdown-body"><Markdown remarkPlugins={[remarkGfm, writingCitations]} skipHtml
            components={{ a: ({ href, children, ...rest }) => {
              const id = href?.match(/^#writing-source=(S\d+)$/)?.[1];
              const source = id && item.context?.sources.find((s) => s.id === id);
              if (id) return source ? <button type="button" className="writing-citation" onClick={() => onOpenSource?.(id, item.context!.id, source.startLine)}>{children}</button> : <span title={t("这条消息没有该来源快照", "This message has no snapshot for this source")}>{children}</span>;
              const output = localOutputLink(href, articleId);
              if (output) return <button type="button" className="writing-citation" onClick={() => onOpenProposal?.(output.kind, output.turnId)}>{children}</button>;
              return <a {...rest} href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
            } }}>{item.content}</Markdown></div> : <p>{item.content}</p>}</div>
          {item.role === "assistant" && item.content && <div className="article-message-actions"><button type="button" onClick={() => void copy(item.id, item.content)}>{copied === item.id ? t("已复制", "Copied") : t("复制", "Copy")}</button>
            {(!execution || execution.status === "completed") && <><button type="button" onClick={() => onUseOutline(item.content)}>{t("用作大纲", "Use as outline")}</button>
              {(execution?.finalAnswer === undefined || execution.finalAnswer.trim()) && <button type="button"
                onClick={() => onUseText(execution?.finalAnswer ?? manuscriptFromUnmarkedReply(item.content))}>{t("用作正文", "Use as article text")}</button>}</>}</div>}
        </div>;
      })}
        {agent.sending && <div className="article-chat-thinking" role="status"><i />{t("正在保存文章并提交任务…", "Saving the article and submitting the task…")}</div>}
        {retryable && lastQuestion && <>
          {run.errorCode === "AGENT_AUTH_REQUIRED" && <p className="article-chat-unavailable">{t("请在本机重新登录后重试，或切换智能体方案。", "Sign in again locally and retry, or choose another assistant profile.")}</p>}
          <button className="agent-retry" type="button" disabled={!canSend} onClick={() => void send(lastQuestion)}>{t("重新发送上一条", "Resend last message")}</button>
        </>}
      </div>
    </div>
    <div className="article-chat-bottom">{(error || profileError) && <p className="inline-message error" role="alert">{error || (profileError && errorText(...profileError))}</p>}
      {profiles && !hasAvailableProfile && <p className="article-chat-unavailable">{t("未检测到可用智能体", "No available assistants found")}</p>}
      {selected && !selected.available && <p className="article-chat-unavailable">{selected.reason ? profileText(selected.reason) : t("当前方案尚未配置，请选择可用智能体。", "This profile needs configuration. Choose an available assistant.")}</p>}
      {selections && <><div className="article-pending-sources" aria-label={t("本轮引用资料", "Sources for this message")}>
        <span>{selections.length ? t(`本轮 ${selections.length} 篇`, `${selections.length} ${selections.length === 1 ? "source" : "sources"} attached`) : t("本轮未附资料", "No sources attached")}</span>{selections.map((ref) => {
          const item = materials.find((m) => m.id === ref.materialId); if (!item) return null;
          return <span className="article-source-chip" key={item.id}><button type="button" onClick={() => onOpenSource?.(item.id, undefined, ref.startLine)} title={`${item.vaultId}/${item.path}`}>
            <b>{item.id}</b> {item.title}{ref.startLine && ` · L${ref.startLine}–${ref.endLine ?? t("末尾", "end")}`}</button>
            <button type="button" aria-label={t(`本轮移除 ${item.id}`, `Remove ${item.id} from this message`)} title={t("仅移出本轮，历史对话仍保留", "Remove from this message")} onClick={() => onSelectionsChange?.(selections.filter((s) => s.materialId !== item.id))}>×</button></span>;
        })}<button type="button" className="text-button" onClick={onOpenMaterials}>{t("＋ 选材", "＋ Choose materials")}</button>
        {materials.length > selections.length && <button type="button" className="text-button" onClick={() => onSelectionsChange?.(materials.map((m) => ({ materialId: m.id })))}>{t("引用全部", "Attach all")}</button>}</div>
        <div className="article-discussion-modes" aria-label={t("阅读讨论方式", "Discussion modes")}>{[
          ["主题阅读", "Read by theme",
            "请围绕共同主题阅读本轮资料，整理核心观点、证据与分歧，使用 [S编号] 标注来源。",
            "Read the attached sources around their shared theme. Summarize the main claims, evidence, and disagreements. Cite sources as [S1], [S2], and so on."],
          ["对照理解", "Compare sources",
            "请对照本轮资料的观点、方法和适用边界，说明共识与分歧，使用 [S编号] 标注来源。",
            "Compare the attached sources' perspectives, methods, and limits. Explain where they agree and disagree. Cite sources as [S1], [S2], and so on."],
          ["整理大纲", "Build an outline",
            "请基于本轮资料和我们的讨论，整理可审阅的文章大纲。先给出主线、章节与对应证据，暂不写正文。",
            "Create a reviewable outline from the attached sources and our discussion. Give the main argument, sections, and supporting evidence. Keep this turn to the outline."],
        ].map(([label, english, prompt, englishPrompt]) => <button type="button" key={label}
          onClick={() => offerPrompt(t(prompt, englishPrompt))}>{t(label, english)}</button>)}
          <small>{t("历史对话继续保留", "Conversation history is saved")}</small></div></>}
      {suggestion && <div className="article-chat-suggestion" role="group" aria-label={t("建议提示词", "Suggested prompt")} tabIndex={-1} ref={suggestionRef}>
        <p>{suggestion}</p>
        <div>{insertion.length > questionLimit && <small>{t("插入后超过 10000 字，请缩短当前草稿。", "Shorten the draft to fit the 10,000-character limit before inserting.")}</small>}
          <button className="text-button" type="button" onClick={() => { setSuggestion(""); inputRef.current?.focus(); }}>{t("忽略", "Dismiss")}</button>
          <button className="secondary-button" type="button" disabled={insertion.length > questionLimit} onClick={() => {
            writeDraft(draftKey, insertion); setSuggestion(""); inputRef.current?.focus();
          }}>{t("插入建议", "Insert suggestion")}</button>
        </div>
      </div>}
      <form className="article-chat-composer" onSubmit={(event) => { event.preventDefault(); void send(question, draft); }}>
        <label className="sr-only" htmlFor="agent-question">{t("向智能体提问", "Ask the assistant")}</label>
        <textarea ref={inputRef} id="agent-question" value={question} onChange={(event) => writeDraft(draftKey, event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(question, draft); } }}
          placeholder={busy ? t("可以先输入下一条想法，或停止当前生成…", "Type your next thought or stop the current response…") : t("描述你想写什么，或继续讨论这篇文章…", "Describe what you want to write or continue the discussion…")} rows={2} maxLength={questionLimit} />
        <div className="article-chat-composer-footer"><span>{run && agentActive(run) ? `${agent.connecting ? t("连接恢复中", "Reconnecting") : t("本机运行中", "Running locally")}${t(` · ${agent.seconds} 秒`, ` · ${agent.seconds} s`)}` : t("Enter 发送 · Shift + Enter 换行", "Enter to send · Shift + Enter for a new line")}</span>
          {agentActive(run) ? <button className="agent-stop" type="button" onClick={() => void agent.cancel()}>{t("■ 停止生成", "■ Stop generating")}</button> :
            <button className="primary-button" type="submit" aria-label={t("发送消息", "Send message")} disabled={!canSend || !question.trim()}>{agent.sending ? t("提交中…", "Sending…") : t("发送 ↑", "Send ↑")}</button>}
        </div>
      </form><small className="article-chat-footnote">{agentActive(run) ? t("切换文章后任务继续，回来可恢复过程与输出。", "The task keeps running when you switch articles. Return to see its progress and output.") : t("智能体产出经审阅后采用，正文与发布由工作台管理。", "Review assistant output before using it. Manage article text and publishing in the workspace.")}</small>
    </div>
  </aside>;
}
