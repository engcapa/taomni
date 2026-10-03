import type { LspDocumentSymbol } from "../../../lib/editor/lsp";
import type { CodeWorkspaceNavigationSegment } from "../../../stores/codeWorkspaceStatusStore";
import type { CodeWorkspaceFileRef } from "../../../types";

/**
 * IDEA navigation-bar path for the status bar (ED-PARITY-010 DEC-010-06):
 * root › directories › file › enclosing symbols. Symbols come from the same
 * documentSymbol chain the breadcrumbs use; without a provider the path stops
 * at the file.
 */
export function workspaceNavigationSegments(
  ref: CodeWorkspaceFileRef,
  roots: readonly { id: string; name: string }[],
  symbolChain: readonly LspDocumentSymbol[],
): CodeWorkspaceNavigationSegment[] {
  const segments: CodeWorkspaceNavigationSegment[] = [];
  const parts = ref.path.split(/[\\/]/).filter(Boolean);
  if (ref.kind === "root") {
    const root = roots.find((candidate) => candidate.id === ref.rootId);
    if (root) segments.push({ label: root.name, kind: "root" });
  }
  const fileName = parts.pop();
  if (ref.kind === "root") {
    for (const dir of parts) segments.push({ label: dir, kind: "dir" });
  }
  if (fileName) segments.push({ label: fileName, kind: "file" });
  for (const symbol of symbolChain) {
    segments.push({ label: symbol.name, kind: "symbol", symbolKind: symbol.kind });
  }
  return segments;
}
