import type { GitChange } from "./git";

export interface ChangeTreeFile {
  type: "file";
  path: string;
  name: string;
  change: GitChange;
}

export interface ChangeTreeDir {
  type: "dir";
  path: string;
  name: string;
  children: ChangeTreeNode[];
}

export type ChangeTreeNode = ChangeTreeDir | ChangeTreeFile;

/**
 * Build a directory tree from a flat list of changes. Directory chains with a
 * single sub-directory and no files are compacted (e.g. `src/main/java`) the way
 * IntelliJ's change tree does. Directories sort before files, both alphabetical.
 */
export function buildPathTree(changes: GitChange[]): ChangeTreeNode[] {
  const root: ChangeTreeDir = { type: "dir", path: "", name: "", children: [] };
  for (const change of changes) {
    const parts = change.path.split("/").filter(Boolean);
    let dir = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const segment = parts[i];
      const dirPath = dir.path ? `${dir.path}/${segment}` : segment;
      let next = dir.children.find(
        (c): c is ChangeTreeDir => c.type === "dir" && c.name === segment,
      );
      if (!next) {
        next = { type: "dir", path: dirPath, name: segment, children: [] };
        dir.children.push(next);
      }
      dir = next;
    }
    dir.children.push({
      type: "file",
      path: change.path,
      name: parts[parts.length - 1] ?? change.path,
      change,
    });
  }
  compact(root);
  sortChildren(root);
  return root.children;
}

function compact(dir: ChangeTreeDir): void {
  for (const child of dir.children) {
    if (child.type === "dir") compact(child);
  }
  // Merge a single-dir-only chain into its parent label.
  for (let i = 0; i < dir.children.length; i += 1) {
    let node = dir.children[i];
    while (
      node.type === "dir" &&
      node.children.length === 1 &&
      node.children[0].type === "dir"
    ) {
      const only = node.children[0] as ChangeTreeDir;
      node = {
        type: "dir",
        path: only.path,
        name: `${node.name}/${only.name}`,
        children: only.children,
      };
      dir.children[i] = node;
    }
  }
}

function sortChildren(dir: ChangeTreeDir): void {
  dir.children.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const child of dir.children) {
    if (child.type === "dir") sortChildren(child);
  }
}

/** All file paths under a node (the node itself if it is a file). */
export function collectFilePaths(node: ChangeTreeNode): string[] {
  if (node.type === "file") return [node.path];
  return node.children.flatMap(collectFilePaths);
}
