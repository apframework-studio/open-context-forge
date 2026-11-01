import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { knowledgeLayout, type KnowledgePanePreferences } from "./knowledgeLayout";

const storageKey = "ocf-knowledge-pane-layout-v1";
function storedPreferences(): KnowledgePanePreferences {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return { folders: typeof value.folders === "number" ? value.folders : undefined,
      list: typeof value.list === "number" ? value.list : undefined,
      foldersHidden: value.foldersHidden === true, listHidden: value.listHidden === true };
  } catch { return {}; }
}

export function useKnowledgeLayout(active: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1200);
  const [preference, setPreference] = useState(storedPreferences);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!active || !element) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [active]);
  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(preference)); } catch { /* Layout preferences are optional. */ }
  }, [preference]);
  const layout = knowledgeLayout(width, preference);
  return { ref, layout, preference,
    style: { "--knowledge-columns": layout.columns } as CSSProperties,
    update: (patch: Partial<KnowledgePanePreferences>) => setPreference((value) => ({ ...value, ...patch })) };
}
