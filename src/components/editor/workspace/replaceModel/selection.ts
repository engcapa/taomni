import type { LspTextEdit, LspWorkspaceEdit } from "../../../../lib/editor/lsp";
import { workspaceEditOperations } from "../workspaceEditPreview";
import { type ReplaceInFilesMatch, type ReplacePreviewSnapshot, type ReplaceSelectionValidation } from "./model";
import { replacePreimagePathKey } from "./preimages";

export function replaceMatchStableKey(match: ReplaceInFilesMatch): string {
  return `${match.filePath}:${match.startLine}:${match.startCharacter}:${match.endLine}:${match.endCharacter}`;
}

/** Deterministic signature of every text edit in a WorkspaceEdit. */
export function replaceEditSignature(edit: LspWorkspaceEdit): string {
  return workspaceEditOperations(edit).map((operation) => {
    if (operation.kind !== "text") {
      const path = operation.kind === "rename"
        ? `${operation.oldPath ?? operation.oldUri}->${operation.newPath ?? operation.newUri}`
        : operation.path ?? operation.uri;
      return `${operation.kind}:${path}`;
    }
    const path = operation.document.path ?? operation.document.uri;
    const edits = operation.document.edits
      .map((item) => [
        item.range.start.line,
        item.range.start.character,
        item.range.end.line,
        item.range.end.character,
        item.newText,
      ].join(":"))
      .join("|");
    return `${operation.kind}:${path}#${edits}`;
  }).join(";");
}

/**
 * ED-IMPROVE-005: the commit may only deliver selections that exist in the
 * frozen snapshot, one edit per selected match, all carrying the frozen
 * replacement text. Any drift is an internal conflict, never a partial write.
 */
export function replaceEditKey(path: string, edit: LspTextEdit): string {
  return [
    replacePreimagePathKey(path),
    edit.range.start.line,
    edit.range.start.character,
    edit.range.end.line,
    edit.range.end.character,
  ].join(":");
}

export function validateReplacePreviewSelection(
  snapshot: ReplacePreviewSnapshot,
  selectedMatchKeys: ReadonlySet<string>,
  filteredEdit: LspWorkspaceEdit,
  sourceEdit?: LspWorkspaceEdit,
): ReplaceSelectionValidation {
  const frozenKeys = new Set(snapshot.matchKeys);
  for (const key of selectedMatchKeys) {
    if (!frozenKeys.has(key)) {
      return {
        ok: false,
        reason: `Selection ${key} is not part of the frozen replace preview; reopen the preview`,
      };
    }
  }
  const allOperations = workspaceEditOperations(filteredEdit);
  const resourceOperations = allOperations.filter((operation) => operation.kind !== "text");
  if (resourceOperations.length > 0) {
    return {
      ok: false,
      reason: "Resource operations are not permitted in Replace in Files; only text edits are allowed",
    };
  }
  const textOperations = allOperations.filter(
    (operation) => operation.kind === "text",
  );
  const edits = textOperations.flatMap((operation) => (
    operation.kind === "text" ? operation.document.edits : []
  ));
  if (edits.length !== selectedMatchKeys.size) {
    return {
      ok: false,
      reason: `Frozen selection has ${selectedMatchKeys.size} matches but the edit carries ${edits.length}; reopen the preview`,
    };
  }
  const seenEditKeys = new Set<string>();
  for (const operation of textOperations) {
    if (operation.kind !== "text") continue;
    const path = operation.document.path ?? operation.document.uri;
    for (const edit of operation.document.edits) {
      const key = replaceEditKey(path, edit);
      if (seenEditKeys.has(key)) {
        return {
          ok: false,
          reason: `Duplicate edit detected for ${path}:${edit.range.start.line}:${edit.range.start.character}; reopen the preview`,
        };
      }
      seenEditKeys.add(key);
      if (edit.newText !== snapshot.replacement) {
        return {
          ok: false,
          reason: "The edit text differs from the frozen replacement; reopen the preview",
        };
      }
    }
  }
  // ED-MAIN-005: each filtered edit must be the exact frozen path/range from the
  // original plan, not a same-count selection that swapped a path or range.
  if (sourceEdit) {
    const sourceKeys = new Set<string>();
    for (const operation of workspaceEditOperations(sourceEdit)) {
      if (operation.kind !== "text") continue;
      const path = operation.document.path ?? operation.document.uri;
      for (const edit of operation.document.edits) sourceKeys.add(replaceEditKey(path, edit));
    }
    for (const operation of textOperations) {
      if (operation.kind !== "text") continue;
      const path = operation.document.path ?? operation.document.uri;
      for (const edit of operation.document.edits) {
        if (!sourceKeys.has(replaceEditKey(path, edit))) {
          return {
            ok: false,
            reason: `Frozen edit ${path}:${edit.range.start.line}:${edit.range.start.character} is not part of the original replace plan; reopen the preview`,
          };
        }
      }
    }
  }
  return { ok: true };
}
