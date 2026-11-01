export interface WritingMaterialRef { vaultId: string; path: string }
export interface WritingMaterial extends WritingMaterialRef {
  id: string; title: string; kind: "source" | "note"; sha256: string;
  originalUrl: string | null; addedAt: string;
}
export interface WritingSelection { materialId: string; startLine?: number; endLine?: number }
export interface WritingContext { revision: number; vaultIds: string[]; materials: WritingMaterial[]; skillEnabled: boolean }
export interface WritingMaterialDetail extends WritingMaterial {
  markdown: string;
  outlinks: { from: string; to: string; type: "wikilink" | "markdown" | "source_metadata"; target: string; line: number }[];
  issues: { from: string; target: string; reason: "missing" | "ambiguous"; line: number }[];
}
export interface WritingTurnSource extends WritingMaterial { startLine?: number; endLine?: number }
export interface WritingTurnContext { id: string; createdAt: string; sources: WritingTurnSource[]; vaultIds: string[]; skillRequested: boolean; outlineRevision: number | null }
export interface WritingOutline { revision: number; markdown: string; approved: boolean; updatedAt: string | null }
export interface WriterSkillStatus { available: boolean; name: string; path: string | null; reason?: string }
export interface WritingProposal { markdown: string; sha256: string; turnId: string; updatedAt: string }
export interface WritingProposals { outline: WritingProposal | null; draft: WritingProposal | null }
