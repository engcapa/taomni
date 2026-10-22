import type { LspChangeAnnotation, LspWorkspaceEdit } from "../../../../lib/editor/lsp";
import { buildWorkspaceEditPreview, workspaceEditOperations } from "../workspaceEditPreview";
import { type WorkspaceEditApplyHooks, type WorkspaceEditApplyOutcome } from "./model";
import { applyTextDocumentEdit } from "./text";

export function workspaceEditAnnotationPreflight(edit: LspWorkspaceEdit): {
  confirmations: LspChangeAnnotation[];
  error: string | null;
} {
  const referencedIds = new Set<string>();
  for (const operation of workspaceEditOperations(edit)) {
    if (operation.kind === "text") {
      for (const id of operation.document.annotationIds ?? []) referencedIds.add(id);
    } else if (operation.annotationId) {
      referencedIds.add(operation.annotationId);
    }
  }
  if (referencedIds.size === 0) return { confirmations: [], error: null };

  const annotations = new Map((edit.changeAnnotations ?? []).map((annotation) => (
    [annotation.id, annotation]
  )));
  const missing = [...referencedIds].filter((id) => !annotations.has(id));
  if (missing.length > 0) {
    return {
      confirmations: [],
      error: `WorkspaceEdit references unknown change annotation: ${missing.join(", ")}`,
    };
  }
  return {
    confirmations: [...referencedIds]
      .map((id) => annotations.get(id)!)
      .filter((annotation) => annotation.needsConfirmation),
    error: null,
  };
}

/**
 * Apply a WorkspaceEdit following §5.2.9 rules:
 * - open clean → apply to buffer and save (result dirty=false)
 * - open dirty → apply to buffer, keep dirty (result dirty=true)
 * - unopened → write disk with hash precheck when provided
 * Failures do not roll back already-applied files, but stop later ordered
 * documentChanges so failedChange identifies the first unapplied boundary.
 */
export async function applyWorkspaceEdit(
  edit: LspWorkspaceEdit,
  hooks: WorkspaceEditApplyHooks,
  startIndex = 0,
): Promise<WorkspaceEditApplyOutcome[]> {
  const annotationPreflight = workspaceEditAnnotationPreflight(edit);
  if (annotationPreflight.error) {
    return [{
      operationIndex: null,
      path: "WorkspaceEdit",
      status: "failed",
      reason: annotationPreflight.error,
    }];
  }
  if (hooks.validateOperationPaths) {
    try {
      const validationError = hooks.validateOperationPaths(workspaceEditOperations(edit));
      if (validationError) {
        return [{
          operationIndex: null,
          path: "WorkspaceEdit",
          status: "failed",
          reason: validationError,
        }];
      }
    } catch (error) {
      return [{
        operationIndex: null,
        path: "WorkspaceEdit",
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      }];
    }
  }
  let activeEdit = edit;
  const preview = buildWorkspaceEditPreview(edit);
  hooks.onActiveEditResolved?.(activeEdit);
  if (preview.requiresConfirmation && hooks.confirmWorkspaceEdit) {
    try {
      const confirmed = await hooks.confirmWorkspaceEdit(preview, edit);
      if (!confirmed) {
        return [{
          operationIndex: null,
          path: "WorkspaceEdit",
          status: "skipped",
          reason: "WorkspaceEdit preview was declined",
        }];
      }
      if (typeof confirmed === "object" && confirmed !== null) {
        activeEdit = confirmed;
      }
      hooks.onActiveEditResolved?.(activeEdit);
    } catch (error) {
      return [{
        operationIndex: null,
        path: "WorkspaceEdit",
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      }];
    }
  } else if (annotationPreflight.confirmations.length > 0) {
    if (!hooks.confirmChangeAnnotations) {
      return [{
        operationIndex: null,
        path: "WorkspaceEdit",
        status: "failed",
        reason: "WorkspaceEdit requires change confirmation, but no confirmation UI is available",
      }];
    }
    try {
      const confirmed = await hooks.confirmChangeAnnotations(annotationPreflight.confirmations);
      if (!confirmed) {
        return [{
          operationIndex: null,
          path: "WorkspaceEdit",
          status: "skipped",
          reason: "WorkspaceEdit change confirmation was declined",
        }];
      }
    } catch (error) {
      return [{
        operationIndex: null,
        path: "WorkspaceEdit",
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      }];
    }
  }
  if (hooks.preflightMutation) {
    try {
      await hooks.preflightMutation();
    } catch (error) {
      return [{
        operationIndex: null,
        path: "WorkspaceEdit",
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      }];
    }
  }
  const outcomes: WorkspaceEditApplyOutcome[] = [];
  for (const [offset, operation] of workspaceEditOperations(activeEdit).entries()) {
    const operationIndex = startIndex + offset;
    if (operation.kind === "text") {
      const outcome = await applyTextDocumentEdit(operation.document, operationIndex, hooks);
      outcomes.push(outcome);
      if (outcome.status === "failed" || outcome.status === "skipped") break;
      continue;
    }
    const path = operation.kind === "rename"
      ? operation.newPath ?? operation.newUri
      : operation.path ?? operation.uri;
    try {
      if (operation.kind === "create") {
        if (!hooks.createFile) throw new Error("CreateFile is not supported by this workspace");
        await hooks.createFile(operation);
        outcomes.push({ operationIndex, path, status: "applied-create" });
      } else if (operation.kind === "rename") {
        if (!hooks.renameFile) throw new Error("RenameFile is not supported by this workspace");
        await hooks.renameFile(operation);
        outcomes.push({ operationIndex, path, status: "applied-rename" });
      } else {
        if (!hooks.deleteFile) throw new Error("DeleteFile is not supported by this workspace");
        await hooks.deleteFile(operation);
        outcomes.push({ operationIndex, path, status: "applied-delete" });
      }
    } catch (error) {
      outcomes.push({
        operationIndex,
        path,
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
      break;
    }
  }
  return outcomes;
}
