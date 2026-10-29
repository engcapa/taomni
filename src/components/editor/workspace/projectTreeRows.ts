import type { ReactNode } from "react";
import { fileKey, type TreeSelection } from "./codeWorkspaceModel";

/** Logical order includes offscreen rows; JSX is created only for the viewport. */
export interface ProjectTreeRow {
  key: string;
  selection?: TreeSelection;
  level?: number;
  expanded?: boolean;
  render: () => ReactNode;
}

export function treeSelectionKey(selection: TreeSelection | null | undefined): string | null {
  if (!selection) return null;
  if (selection.kind === "file") return fileKey(selection.ref);
  return selection.kind === "root"
    ? `root:${selection.rootId}`
    : `dir:${selection.rootId}:${selection.path}`;
}
