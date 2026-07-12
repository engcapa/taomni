import type { LspTextEdit, LspWorkspaceEdit } from "../../../lib/editor/lsp";
import type { WorkspaceSearchMatch } from "../../../lib/editor/workspaceSearch";

function matchKey(match: WorkspaceSearchMatch): string {
  return `${match.rootId}:${match.path}:${match.lineNumber}:${match.matchStart}:${match.matchEnd}`;
}

/**
 * Build a WorkspaceEdit that replaces the selected Find-in-Files hits.
 * Edits within a file are sorted bottom-to-top by the applier.
 */
export function buildReplaceWorkspaceEdit(
  matches: readonly WorkspaceSearchMatch[],
  replacement: string,
  selectedKeys?: ReadonlySet<string>,
): LspWorkspaceEdit {
  const byFile = new Map<string, { rootPath: string; path: string; edits: LspTextEdit[] }>();
  for (const match of matches) {
    const key = matchKey(match);
    if (selectedKeys && !selectedKeys.has(key)) continue;
    const fileKey = `${match.rootPath}::${match.path}`;
    const line = Math.max(0, match.lineNumber - 1);
    const edit: LspTextEdit = {
      range: {
        start: { line, character: match.matchStart },
        end: { line, character: match.matchEnd },
      },
      newText: replacement,
    };
    const existing = byFile.get(fileKey);
    if (existing) existing.edits.push(edit);
    else {
      byFile.set(fileKey, {
        rootPath: match.rootPath,
        path: match.path,
        edits: [edit],
      });
    }
  }
  return {
    documentEdits: [...byFile.values()].map((file) => {
      const absolute = file.path
        ? `${file.rootPath.replace(/\\/g, "/").replace(/\/+$/, "")}/${file.path.replace(/^\/+/, "")}`
        : file.rootPath;
      return {
        uri: `file://${absolute}`,
        path: absolute,
        edits: file.edits,
      };
    }),
  };
}

export function workspaceSearchMatchKey(match: WorkspaceSearchMatch): string {
  return matchKey(match);
}
