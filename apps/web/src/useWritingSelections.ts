import { useEffect, useState } from "react";
import type { WritingContext, WritingSelection } from "./api";

// Composer choices are independent from the article's saved material collection.
export function useWritingSelections(articleId: string | null, context: WritingContext | null) {
  const [state, setState] = useState<{ articleId: string; selections: WritingSelection[] } | null>(null);
  useEffect(() => {
    if (!articleId || !context) { setState(null); return; }
    const ids = context.materials.map((m) => m.id);
    let selections: WritingSelection[] = ids.map((materialId) => ({ materialId }));
    try {
      const saved = JSON.parse(sessionStorage.getItem(`ocf-writing-selections:${articleId}`) ?? "null");
      if (saved && Array.isArray(saved.knownIds) && Array.isArray(saved.selections)) {
        selections = saved.selections.filter((s: WritingSelection) => s && ids.includes(s.materialId));
        selections.push(...ids.filter((id) => !saved.knownIds.includes(id)).map((materialId) => ({ materialId })));
      }
    } catch { /* Session preferences are optional. */ }
    setState({ articleId, selections });
  }, [articleId, context]);
  function update(selections: WritingSelection[], nextContext = context) {
    if (!articleId || !nextContext) return;
    setState({ articleId, selections });
    try { sessionStorage.setItem(`ocf-writing-selections:${articleId}`, JSON.stringify({ selections, knownIds: nextContext.materials.map((m) => m.id) })); } catch { /* Optional. */ }
  }
  return { selections: state?.articleId === articleId ? state.selections : [], ready: !!articleId && state?.articleId === articleId, update };
}
