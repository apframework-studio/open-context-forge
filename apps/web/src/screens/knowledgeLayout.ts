export interface KnowledgePanePreferences {
  folders?: number; list?: number; foldersHidden?: boolean; listHidden?: boolean;
}
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
function requested(value: number | undefined, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function knowledgeLayout(width: number, preference: KnowledgePanePreferences) {
  width = Math.max(0, Math.floor(width));
  const wide = width >= 1000;
  const foldersVisible = wide && !preference.foldersHidden;
  const listVisible = !preference.listHidden;
  const gutter = (foldersVisible ? 6 : 0) + (listVisible ? 6 : 0);
  const minReader = Math.min(420, width * .62);
  const minFolder = 180;
  const minList = Math.min(220, width * .34);
  const maxFolder = Math.max(minFolder, Math.min(360, width - gutter - minReader - (listVisible ? minList : 0)));
  const folderWidth = clamp(requested(preference.folders, clamp(Math.round(width * .19), 200, 280)), minFolder, maxFolder);
  const remaining = width - gutter - (foldersVisible ? folderWidth : 0);
  const maxList = Math.max(minList, Math.min(480, Math.floor(remaining * .48), remaining - minReader));
  const listWidth = clamp(requested(preference.list, clamp(Math.round(width * .25), 220, 360)), minList, maxList);
  const readerWidth = remaining - (listVisible ? listWidth : 0);
  const columns = [...(foldersVisible ? [`${folderWidth}px`, "6px"] : []), ...(listVisible ? [`${listWidth}px`, "6px"] : []), "minmax(0, 1fr)"].join(" ");
  return { wide, foldersVisible, listVisible, folderWidth, listWidth, readerWidth, minFolder, maxFolder, minList, maxList, columns };
}
