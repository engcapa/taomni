import type { TreeSelection } from "./codeWorkspaceModel";

export interface ProjectTreeNavigationActions {
  onSelect: (selection: TreeSelection) => void;
  onToggleRoot: (rootId: string) => void;
  onToggleDir: (rootId: string, path: string) => void;
}

export function treeRowSelection(row: HTMLElement): TreeSelection | null {
  const { treeKind, rootId, looseId, path = "" } = row.dataset;
  if (treeKind === "root" && rootId) return { kind: "root", rootId };
  if (treeKind === "dir" && rootId) return { kind: "dir", rootId, path };
  if (treeKind === "file" && rootId) return { kind: "file", ref: { kind: "root", rootId, path } };
  if (treeKind === "loose-file" && looseId) return { kind: "file", ref: { kind: "loose", id: looseId, path } };
  return null;
}

/** Navigation selects visible rows; it never invokes a row's activation click. */
export function navigateProjectTree(tree: HTMLElement, key: string, actions: ProjectTreeNavigationActions): boolean {
  if (!["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End"].includes(key)) return false;
  const rows = Array.from(tree.querySelectorAll<HTMLElement>("[role='treeitem'][data-tree-kind]"));
  if (!rows.length) return false;
  const select = (row: HTMLElement | undefined) => {
    const selection = row && treeRowSelection(row);
    if (!selection || !row) return;
    actions.onSelect(selection);
    row.focus({ preventScroll: true });
    row.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  };
  const index = rows.findIndex((row) => row.dataset.selected === "true");
  if (key === "Home" || key === "End" || index < 0) {
    select(rows[key === "End" ? rows.length - 1 : 0]);
    return true;
  }
  if (key === "ArrowDown" || key === "ArrowUp") {
    select(rows[Math.max(0, Math.min(rows.length - 1, index + (key === "ArrowDown" ? 1 : -1)))]);
    return true;
  }
  const row = rows[index];
  const level = Number(row.getAttribute("aria-level"));
  const isDirectory = row.dataset.treeKind === "root" || row.dataset.treeKind === "dir";
  const expanded = row.getAttribute("aria-expanded") === "true";
  if (isDirectory && ((key === "ArrowRight" && !expanded) || (key === "ArrowLeft" && expanded))) {
    if (row.dataset.treeKind === "root") actions.onToggleRoot(row.dataset.rootId!);
    else actions.onToggleDir(row.dataset.rootId!, row.dataset.path!);
  } else if (key === "ArrowRight" && expanded) {
    const child = rows[index + 1];
    if (child && Number(child.getAttribute("aria-level")) > level) select(child);
  } else if (key === "ArrowLeft") {
    // Rendered ancestry handles compact chains and filtered/flat rows without
    // guessing a parent from filesystem segments that may not be visible.
    select(rows.slice(0, index).reverse().find((candidate) =>
      candidate.dataset.rootId === row.dataset.rootId && Number(candidate.getAttribute("aria-level")) < level,
    ));
  }
  return true;
}
