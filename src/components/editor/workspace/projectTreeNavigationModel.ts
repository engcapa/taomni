import type { TreeSelection } from "./codeWorkspaceModel";
import { treeSelectionKey, type ProjectTreeRow } from "./projectTreeRows";

export type TreeNavigationResult =
  | { kind: "select"; row: ProjectTreeRow }
  | { kind: "toggle"; selection: Exclude<TreeSelection, { kind: "file" }> };

function rootId(selection: TreeSelection | undefined): string | null {
  if (!selection) return null;
  return selection.kind === "file" ? (selection.ref.kind === "root" ? selection.ref.rootId : null) : selection.rootId;
}

/** Follow visible ancestry, including compact chains, rather than filesystem parents. */
export function projectTreeNavigationTarget(
  rows: readonly ProjectTreeRow[], selected: TreeSelection | null, key: string,
): TreeNavigationResult | null {
  if (!["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End"].includes(key)) return null;
  const selectable = rows.filter((row) => row.selection);
  if (!selectable.length) return null;
  const currentKey = treeSelectionKey(selected);
  const index = selectable.findIndex((row) => treeSelectionKey(row.selection) === currentKey);
  const select = (row: ProjectTreeRow | undefined): TreeNavigationResult | null => row ? { kind: "select", row } : null;
  if (key === "Home" || key === "End" || index < 0) {
    return select(selectable[key === "End" ? selectable.length - 1 : 0]);
  }
  if (key === "ArrowDown" || key === "ArrowUp") {
    return select(selectable[Math.max(0, Math.min(selectable.length - 1, index + (key === "ArrowDown" ? 1 : -1)))]);
  }
  const row = selectable[index];
  const selection = row.selection!;
  if (selection.kind !== "file" && ((key === "ArrowRight" && !row.expanded) || (key === "ArrowLeft" && row.expanded))) {
    return { kind: "toggle", selection };
  }
  if (key === "ArrowRight" && row.expanded) {
    const child = selectable[index + 1];
    return child && (child.level ?? 0) > (row.level ?? 0) ? select(child) : null;
  }
  if (key === "ArrowLeft") {
    return select(selectable.slice(0, index).reverse().find((candidate) =>
      rootId(candidate.selection) === rootId(selection) && (candidate.level ?? 0) < (row.level ?? 0),
    ));
  }
  return null;
}
