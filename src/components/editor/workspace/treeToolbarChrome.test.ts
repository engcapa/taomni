import { describe, expect, it } from "vitest";
import {
  formatTreeBytes,
  nextTreeViewMode,
  treeFileDetails,
  treeToolbarDensity,
  treeToolbarVisibility,
  treeViewTitle,
  TREE_TOOLBAR_MEDIUM_MIN_PX,
  TREE_TOOLBAR_WIDE_MIN_PX,
} from "./treeToolbarChrome";

describe("treeToolbarChrome", () => {
  it("classifies density from pane width", () => {
    expect(treeToolbarDensity(TREE_TOOLBAR_WIDE_MIN_PX)).toBe("wide");
    expect(treeToolbarDensity(400)).toBe("wide");
    expect(treeToolbarDensity(TREE_TOOLBAR_MEDIUM_MIN_PX)).toBe("medium");
    expect(treeToolbarDensity(240)).toBe("medium");
    expect(treeToolbarDensity(TREE_TOOLBAR_MEDIUM_MIN_PX - 1)).toBe("narrow");
    expect(treeToolbarDensity(120)).toBe("narrow");
  });

  it("keeps IDEA's title actions inline and folds only Expand All when narrow", () => {
    expect(treeToolbarVisibility("wide").showExpandAll).toBe(true);
    expect(treeToolbarVisibility("medium").showExpandAll).toBe(true);
    expect(treeToolbarVisibility("narrow").showExpandAll).toBe(false);
  });

  it("titles the view selector like IDEA's Project / Project Files views", () => {
    expect(treeViewTitle("tree")).toBe("Project");
    expect(treeViewTitle("compact")).toBe("Project");
    expect(treeViewTitle("flat")).toBe("Project Files");
  });

  it("formats IDEA Details as modification time and size", () => {
    const ms = new Date(2026, 8, 28, 17, 31).getTime();
    expect(treeFileDetails(327, ms, "zh-CN")).toBe("2026/9/28 17:31, 327 B");
    // Seconds are accepted as well as milliseconds.
    expect(treeFileDetails(67, Math.floor(ms / 1000), "zh-CN")).toBe("2026/9/28 17:31, 67 B");
    expect(treeFileDetails(2048, 0)).toBe("2 KB");
    expect(formatTreeBytes(1536)).toBe("1.5 KB");
    expect(formatTreeBytes(5 * 1024 * 1024)).toBe("5 MB");
  });

  it("cycles view modes in a stable order", () => {
    expect(nextTreeViewMode("tree")).toBe("compact");
    expect(nextTreeViewMode("compact")).toBe("flat");
    expect(nextTreeViewMode("flat")).toBe("tree");
  });
});
