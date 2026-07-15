import type { GitChange } from "./git";
import type { GitWorkspaceRootInfo } from "../types";

export interface WorkspaceFlatGroupModel {
  root: GitWorkspaceRootInfo;
  changes: GitChange[];
}

/**
 * Group flat change rows under their repository, preserving repo name order
 * then path order within each project (issue #324 S2).
 */
export function buildWorkspaceFlatGroups(
  roots: readonly GitWorkspaceRootInfo[],
  changesByRepo: ReadonlyMap<string, readonly GitChange[]>,
): WorkspaceFlatGroupModel[] {
  const groups: WorkspaceFlatGroupModel[] = [];
  const ordered = [...roots].sort((a, b) => a.name.localeCompare(b.name));
  for (const root of ordered) {
    const changes = [...(changesByRepo.get(root.repoRoot) ?? [])]
      .sort((a, b) => a.path.localeCompare(b.path));
    if (changes.length === 0) continue;
    groups.push({ root, changes });
  }
  return groups;
}

/** Directory portion of a git path for compact single-line display. */
export function changePathDirectory(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 1) return "";
  parts.pop();
  return parts.join("/");
}

export function changeFileName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
