import { describe, expect, it } from "vitest";
import {
  nextTreeViewMode,
  treeToolbarDensity,
  treeToolbarVisibility,
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

  it("never collapses Open/Add; progressively hides New/view/zoom", () => {
    const wide = treeToolbarVisibility("wide");
    expect(wide.showOpenAndAdd).toBe(true);
    expect(wide.showNewFile).toBe(true);
    expect(wide.showNewDirectory).toBe(true);
    expect(wide.showViewModes).toBe(true);
    expect(wide.showZoom).toBe(true);
    expect(wide.showViewCycle).toBe(false);

    const medium = treeToolbarVisibility("medium");
    expect(medium.showOpenAndAdd).toBe(true);
    expect(medium.showNewFile).toBe(true);
    expect(medium.showNewDirectory).toBe(false);
    expect(medium.showViewModes).toBe(true);
    expect(medium.showZoom).toBe(false);

    const narrow = treeToolbarVisibility("narrow");
    expect(narrow.showOpenAndAdd).toBe(true);
    expect(narrow.showNewFile).toBe(false);
    expect(narrow.showNewDirectory).toBe(false);
    expect(narrow.showViewModes).toBe(false);
    expect(narrow.showViewCycle).toBe(true);
    expect(narrow.showZoom).toBe(false);
  });

  it("cycles view modes in a stable order", () => {
    expect(nextTreeViewMode("tree")).toBe("compact");
    expect(nextTreeViewMode("compact")).toBe("flat");
    expect(nextTreeViewMode("flat")).toBe("tree");
  });
});
