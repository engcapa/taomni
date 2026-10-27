/**
 * IDEA Project tool window header rules for the code-workspace project tree.
 *
 * The header is IDEA's single title row: the view selector ("Project ▾") on
 * the left and the title actions New (+), Select Opened File, Expand All,
 * Collapse All, Options (⋮) and Hide (−) on the right. Only Expand All folds
 * into Options when the pane gets narrow.
 */

export type TreeToolbarDensity = "wide" | "medium" | "narrow";

export type TreeToolbarVisibility = {
  /** Expand All inline; otherwise it is the first Options entry. */
  showExpandAll: boolean;
};

export const TREE_TOOLBAR_WIDE_MIN_PX = 280;
export const TREE_TOOLBAR_MEDIUM_MIN_PX = 200;

export function treeToolbarDensity(widthPx: number): TreeToolbarDensity {
  if (!Number.isFinite(widthPx) || widthPx >= TREE_TOOLBAR_WIDE_MIN_PX) return "wide";
  if (widthPx >= TREE_TOOLBAR_MEDIUM_MIN_PX) return "medium";
  return "narrow";
}

export function treeToolbarVisibility(density: TreeToolbarDensity): TreeToolbarVisibility {
  return { showExpandAll: density !== "narrow" };
}

export type FileTreeViewMode = "tree" | "compact" | "flat" | "files" | "list" | "packages";

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
    case "files":
      return "All files";
    case "list":
      return "Details list";
    case "packages":
      return "Packages";
  }
}

/** Header title of the view selector: IDEA "Project", or the flat file list. */
export function treeViewTitle(mode: FileTreeViewMode): string {
  return mode === "list" ? "Details List" : mode === "packages" ? "Packages" : mode === "files" ? "All Files" : mode === "flat" ? "Project Files" : "Project";
}

/**
 * IDEA "Details" (ViewInplaceComments) for a file row: modification time and
 * size, e.g. "2026/9/28 17:31, 327 B". `mtime` may be seconds or milliseconds.
 */
export function treeFileDetails(size: number, mtime: number, locale?: string): string {
  const parts: string[] = [];
  const date = treeModifiedDate(mtime, locale);
  if (date) parts.push(date);
  if (Number.isFinite(size) && size >= 0) parts.push(formatTreeBytes(size));
  return parts.join(", ");
}

const dateFormats = new Map<string, Intl.DateTimeFormat>();
export function treeModifiedDate(mtime: number, locale?: string): string {
  if (!Number.isFinite(mtime) || mtime <= 0) return "";
  const key = locale ?? "default";
  let formatter = dateFormats.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    dateFormats.set(key, formatter);
  }
  return formatter.format(new Date(mtime < 1e12 ? mtime * 1000 : mtime)).replace(/,\s*/, " ");
}

export function formatTreeBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1).replace(/\.0$/, "") : Math.round(value)} ${units[unit]}`;
}
