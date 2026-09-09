import type { LspWorkspaceEditOperation } from "../../../lib/editor/lsp";
import {
  isAbsoluteFsPath,
  normalizeFsPath,
  resolveWorkspaceEditPath,
  relativePathWithinRoot,
} from "./codeWorkspaceModel";

export function workspaceEditOperationPaths(
  operation: LspWorkspaceEditOperation,
  workspaceRoots: readonly string[] = [],
): string[] {
  if (operation.kind === "text") {
    const path = resolveWorkspaceEditPath(operation.document.path, operation.document.uri, workspaceRoots);
    return path ? [path] : [];
  }
  if (operation.kind === "rename") {
    return [
      resolveWorkspaceEditPath(operation.oldPath, operation.oldUri, workspaceRoots),
      resolveWorkspaceEditPath(operation.newPath, operation.newUri, workspaceRoots),
    ].filter((path): path is string => path !== null);
  }
  const path = resolveWorkspaceEditPath(operation.path, operation.uri, workspaceRoots);
  return path ? [path] : [];
}

/**
 * Provider-backed semantic edits must remain entirely inside an opened root.
 * This guard runs before preview confirmation and before the final semantic
 * revision check, so malformed, virtual, relative, or escaping paths cannot
 * reach either loose-file fallbacks or resource mutation hooks.
 */
export function validateSemanticWorkspaceEditPaths(
  operations: readonly LspWorkspaceEditOperation[],
  workspaceRoots: readonly string[],
): string | null {
  const roots = workspaceRoots
    .map((root) => normalizeFsPath(root.trim()))
    .filter((root) => isAbsoluteFsPath(root));
  if (roots.length === 0) {
    return "Semantic WorkspaceEdit requires at least one absolute workspace root";
  }
  for (const operation of operations) {
    const paths = workspaceEditOperationPaths(operation, roots);
    const expectedPathCount = operation.kind === "rename" ? 2 : 1;
    if (paths.length !== expectedPathCount) {
      return "Semantic WorkspaceEdit contains a non-local or missing filesystem path";
    }
    for (const path of paths) {
      const normalized = normalizeFsPath(path);
      if (!isAbsoluteFsPath(normalized)) {
        return `Semantic WorkspaceEdit path is not an absolute local file: ${path}`;
      }
      if (!roots.some((root) => relativePathWithinRoot(root, normalized) !== null)) {
        return `Semantic WorkspaceEdit path is outside the workspace: ${normalized}`;
      }
    }
  }
  return null;
}
