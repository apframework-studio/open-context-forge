import { describe, expect, it } from "vitest";
import { knowledgeLayout } from "./knowledgeLayout";

describe("knowledge browser pane sizing", () => {
  it("gives folders more space on a wide screen while keeping the reader largest", () => {
    const layout = knowledgeLayout(1200, {});
    expect(layout.wide).toBe(true);
    expect(layout.folderWidth).toBeGreaterThanOrEqual(200);
    expect(layout.folderWidth).toBeLessThanOrEqual(280);
    expect(layout.readerWidth).toBeGreaterThan(layout.listWidth);
    expect(layout.folderWidth + layout.listWidth + layout.readerWidth + 12).toBe(1200);
  });

  it("constrains remembered widths to protect the document after a window shrinks", () => {
    const preference = { folders: 350, list: 470 };
    const wide = knowledgeLayout(1500, preference);
    const narrow = knowledgeLayout(1020, preference);
    expect(wide.folderWidth).toBe(350);
    expect(narrow.readerWidth).toBeGreaterThanOrEqual(420);
    expect(narrow.readerWidth).toBeGreaterThan(narrow.listWidth);
    expect(narrow.folderWidth + narrow.listWidth + narrow.readerWidth + 12).toBe(1020);
    expect(knowledgeLayout(1500, preference).folderWidth).toBe(350);
  });

  it("uses a directory drawer in compact mode without reserving an empty column", () => {
    const layout = knowledgeLayout(680, { folders: 350, list: 470 });
    expect(layout.wide).toBe(false);
    expect(layout.readerWidth).toBeGreaterThanOrEqual(420);
    expect(layout.listWidth + layout.readerWidth + 6).toBe(680);
  });

  it("releases space when panes collapse and ignores invalid saved sizes", () => {
    const layout = knowledgeLayout(1200, { foldersHidden: true, listHidden: true });
    expect(layout.readerWidth).toBe(1200);
    expect(layout.columns).toBe("minmax(0, 1fr)");
    expect(knowledgeLayout(1200, { folders: Number.NaN, list: -10 })).toEqual(knowledgeLayout(1200, {}));
  });
});
