/** Progressive collapse rules for the code-workspace project tree chrome. */

export type TreeToolbarDensity = "wide" | "medium" | "narrow";

export type TreeToolbarVisibility = {
  /** Open file + Add folder — always true by design. */
  showOpenAndAdd: true;
  showNewFile: boolean;
  showNewDirectory: boolean;
  /** Three discrete view-mode buttons. */
  showViewModes: boolean;
  /** Single button that cycles tree → compact → flat when modes are collapsed. */
  showViewCycle: boolean;
  showZoom: boolean;
};

export const TREE_TOOLBAR_WIDE_MIN_PX = 280;
export const TREE_TOOLBAR_MEDIUM_MIN_PX = 200;

export function treeToolbarDensity(widthPx: number): TreeToolbarDensity {
  if (!Number.isFinite(widthPx) || widthPx >= TREE_TOOLBAR_WIDE_MIN_PX) return "wide";
  if (widthPx >= TREE_TOOLBAR_MEDIUM_MIN_PX) return "medium";
  return "narrow";
}

/**
 * What stays inline at each density. Open/Add never collapse into ⋯.
 * Rename/Delete stay in the overflow menu (also available via tree context menu).
 */
export function treeToolbarVisibility(density: TreeToolbarDensity): TreeToolbarVisibility {
  switch (density) {
    case "wide":
      return {
        showOpenAndAdd: true,
        showNewFile: true,
        showNewDirectory: true,
        showViewModes: true,
        showViewCycle: false,
        showZoom: true,
      };
    case "medium":
      return {
        showOpenAndAdd: true,
        showNewFile: true,
        showNewDirectory: false,
        showViewModes: true,
        showViewCycle: false,
        showZoom: false,
      };
    case "narrow":
      return {
        showOpenAndAdd: true,
        showNewFile: false,
        showNewDirectory: false,
        showViewModes: false,
        showViewCycle: true,
        showZoom: false,
      };
  }
}

export type FileTreeViewMode = "tree" | "compact" | "flat";

const VIEW_CYCLE: FileTreeViewMode[] = ["tree", "compact", "flat"];

export function nextTreeViewMode(current: FileTreeViewMode): FileTreeViewMode {
  const index = VIEW_CYCLE.indexOf(current);
  return VIEW_CYCLE[(index + 1) % VIEW_CYCLE.length] ?? "tree";
}

export function treeViewModeLabel(mode: FileTreeViewMode): string {
  switch (mode) {
    case "tree":
      return "Tree view";
    case "compact":
      return "Compact tree view";
    case "flat":
      return "Flat file view";
  }
}
