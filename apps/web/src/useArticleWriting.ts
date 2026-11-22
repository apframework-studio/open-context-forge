import { useEffect, useRef, useState } from "react";
import { api, type WritingContext, type WritingOutline, type WritingProposals, type WriterSkillStatus } from "./api";
import { useLocale, type LocalizedError } from "./locale";

export function useArticleWriting(articleId: string | null) {
  const { errorText } = useLocale();
  const [context, setContext] = useState<WritingContext | null>(null);
  const [outline, setOutline] = useState<WritingOutline | null>(null);
  const [skill, setSkill] = useState<WriterSkillStatus | null>(null);
  const [proposals, setProposals] = useState<WritingProposals>({ outline: null, draft: null });
  const [busy, setBusy] = useState(false); const [error, setError] = useState<LocalizedError | null>(null);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const current = useRef(articleId); current.current = articleId;
  const generation = useRef(0);
  useEffect(() => {
    const version = ++generation.current;
    setContext(null); setOutline(null); setProposals({ outline: null, draft: null }); setError(null); setBusy(false);
    if (!articleId) return;
    void Promise.all([api<WritingContext>(`/articles/${articleId}/context`), api<WritingOutline>(`/articles/${articleId}/outline`), api<WriterSkillStatus>("/writing/skill")])
      .then(([c, o, s]) => { if (generation.current === version && current.current === articleId) { setContext(c); setOutline(o); setSkill(s); setLoadedId(articleId); } })
      .catch((cause) => { if (generation.current === version && current.current === articleId) setError([cause, "创作资料加载失败", "Could not load writing materials"]); });
    const load = async () => {
      try { const value = await api<WritingProposals>(`/articles/${articleId}/writing-proposals`); if (generation.current === version && current.current === articleId) setProposals(value); }
      catch { /* An interrupted run or an older server can leave no proposals. */ }
    };
    void load(); const timer = window.setInterval(() => void load(), 5000);
    return () => { generation.current += 1; window.clearInterval(timer); };
  }, [articleId]);
  async function saveOutline(markdown: string, approve = false) {
    if (!articleId || !outline || busy) return null;
    const id = articleId, version = generation.current;
    setBusy(true); setError(null);
    try {
      let next = outline;
      if (markdown !== outline.markdown) next = await api<WritingOutline>(`/articles/${id}/outline`, { method: "PUT", body: { markdown, expectedRevision: outline.revision } });
      if (approve) next = await api<WritingOutline>(`/articles/${id}/outline/approve`, { method: "POST", body: { expectedRevision: next.revision } });
      if (current.current !== id || generation.current !== version) return null;
      setOutline(next);
      return next;
    } catch (cause) { if (current.current === id && generation.current === version) setError([cause, "大纲保存失败", "Could not save the outline"]); return null; }
    finally { if (current.current === id && generation.current === version) setBusy(false); }
  }
  async function toggleSkill() {
    if (!articleId || !context || busy) return;
    const id = articleId, version = generation.current;
    setBusy(true); setError(null);
    try {
      const next = await api<WritingContext>(`/articles/${id}/context`, { method: "PUT", body: {
        expectedRevision: context.revision, vaultIds: context.vaultIds, materials: context.materials.map(({ vaultId, path }) => ({ vaultId, path })), skillEnabled: !context.skillEnabled,
      } });
      const nextOutline = await api<WritingOutline>(`/articles/${id}/outline`);
      if (current.current === id && generation.current === version) { setContext(next); setOutline(nextOutline); }
    } catch (cause) { if (current.current === id && generation.current === version) setError([cause, "技能配置失败", "Could not update the writing skill"]); }
    finally { if (current.current === id && generation.current === version) setBusy(false); }
  }
  async function appliedContext(value: WritingContext) {
    if (!articleId) return;
    const id = articleId, version = generation.current;
    setContext(value); setBusy(true); setError(null);
    if (outline?.approved) setOutline({ ...outline, approved: false });
    try {
      const next = await api<WritingOutline>(`/articles/${id}/outline`);
      if (current.current === id && generation.current === version) setOutline(next);
    } catch (cause) { if (current.current === id && generation.current === version) setError([cause, "大纲状态刷新失败，请重新打开文章", "Could not refresh the outline. Reopen the article."]); }
    finally { if (current.current === id && generation.current === version) setBusy(false); }
  }
  const visible = loadedId === articleId && articleId !== null;
  return { context: visible ? context : null, outline: visible ? outline : null, skill: visible ? skill : null,
    proposals: visible ? proposals : { outline: null, draft: null }, busy, error: error ? errorText(...error) : "", saveOutline, toggleSkill, appliedContext };
}
