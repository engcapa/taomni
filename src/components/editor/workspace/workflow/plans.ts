import type { LspWorkspaceEdit } from "../../../../lib/editor/lsp";
import { applyLspTextEditsToString } from "../lspTextEdits";
import { sha256Hex } from "../projectAnalysisModel";
import { buildWorkspaceEditPreview } from "../workspaceEditPreview";
import { type BuildRearrangePlanInput, type WorkflowPlan, type WorkflowConflict, type WorkflowPrecondition, type BuildCleanupPlanInput } from "./types";

export function buildRearrangePlan(input: BuildRearrangePlanInput): WorkflowPlan {
  const conflicts: WorkflowConflict[] = [];
  if (input.readOnly) {
    conflicts.push({
      uri: input.targetUri,
      path: input.targetPath,
      reason: "read-only",
      message: `${input.targetPath} is read-only and cannot be rearranged`,
    });
  }
  if (input.isDirty) {
    conflicts.push({
      uri: input.targetUri,
      path: input.targetPath,
      reason: "dirty-open-buffer",
      message: `${input.targetPath} has uncommitted open changes`,
    });
  }

  const preTextSha256 = sha256Hex(input.currentText);
  const postText = applyLspTextEditsToString(input.currentText, input.edits);
  const expectedPostHash = sha256Hex(postText);

  const edit: LspWorkspaceEdit = {
    documentEdits: [
      {
        uri: input.targetUri,
        path: input.targetPath,
        version: input.documentVersion ?? undefined,
        edits: [...input.edits],
      },
    ],
  };

  const preview = buildWorkspaceEditPreview(edit, { label: "Rearrange Code" });

  const precondition: WorkflowPrecondition = {
    uri: input.targetUri,
    path: input.targetPath,
    preTextSha256,
    documentRevision: input.documentRevision,
    expectedPostHash,
  };

  return {
    workflow: "rearrange",
    scope: input.scope,
    provider: input.provider,
    preconditions: [precondition],
    edit,
    preview,
    conflicts,
    expectedPostHashes: { [input.targetPath]: expectedPostHash },
  };
}

export function buildCleanupPlan(input: BuildCleanupPlanInput): WorkflowPlan {
  const conflicts: WorkflowConflict[] = [];
  if (input.readOnly) {
    conflicts.push({
      uri: input.targetUri,
      path: input.targetPath,
      reason: "read-only",
      message: `${input.targetPath} is read-only and cannot be cleaned up`,
    });
  }
  if (input.isDirty) {
    conflicts.push({
      uri: input.targetUri,
      path: input.targetPath,
      reason: "dirty-open-buffer",
      message: `${input.targetPath} has uncommitted open changes`,
    });
  }

  const preTextSha256 = sha256Hex(input.currentText);
  const postText = applyLspTextEditsToString(input.currentText, input.edits);
  const expectedPostHash = sha256Hex(postText);

  const edit: LspWorkspaceEdit = {
    documentEdits: [
      {
        uri: input.targetUri,
        path: input.targetPath,
        version: input.documentVersion ?? undefined,
        edits: [...input.edits],
      },
    ],
  };

  const preview = buildWorkspaceEditPreview(edit, { label: "Code Cleanup" });

  const precondition: WorkflowPrecondition = {
    uri: input.targetUri,
    path: input.targetPath,
    preTextSha256,
    documentRevision: input.documentRevision,
    expectedPostHash,
  };

  return {
    workflow: "cleanup",
    scope: input.scope,
    profileId: input.profileId ?? "default",
    provider: input.provider,
    preconditions: [precondition],
    edit,
    preview,
    conflicts,
    expectedPostHashes: { [input.targetPath]: expectedPostHash },
  };
}

export function verifyWorkflowPreconditions(
  plan: WorkflowPlan,
  liveDocuments: Record<string, { text: string; revision?: number; readOnly?: boolean; }>,
): { ok: boolean; conflict?: WorkflowConflict; } {
  for (const pc of plan.preconditions) {
    const live = liveDocuments[pc.path] ?? liveDocuments[pc.uri];
    if (!live) continue;
    if (live.readOnly) {
      return {
        ok: false,
        conflict: {
          uri: pc.uri,
          path: pc.path,
          reason: "read-only",
          message: `${pc.path} is read-only`,
        },
      };
    }
    const currentSha = sha256Hex(live.text);
    if (currentSha !== pc.preTextSha256) {
      return {
        ok: false,
        conflict: {
          uri: pc.uri,
          path: pc.path,
          reason: "external-divergence",
          message: `${pc.path} has changed since plan generation`,
        },
      };
    }
    if (
      pc.documentRevision !== undefined &&
      live.revision !== undefined &&
      live.revision !== pc.documentRevision
    ) {
      return {
        ok: false,
        conflict: {
          uri: pc.uri,
          path: pc.path,
          reason: "version-mismatch",
          message: `${pc.path} revision ${live.revision} differs from planned ${pc.documentRevision}`,
        },
      };
    }
  }
  return { ok: true };
}

export function verifyWorkflowFreshness(
  frozenIdentity: { providerGeneration?: number; sessionId?: string; },
  currentIdentity: { providerGeneration?: number; sessionId?: string; },
): { ok: boolean; staleReason?: string; } {
  if (
    frozenIdentity.providerGeneration !== undefined &&
    currentIdentity.providerGeneration !== undefined &&
    frozenIdentity.providerGeneration !== currentIdentity.providerGeneration
  ) {
    return {
      ok: false,
      staleReason: `Provider generation changed (${frozenIdentity.providerGeneration} -> ${currentIdentity.providerGeneration})`,
    };
  }
  if (
    frozenIdentity.sessionId !== undefined &&
    currentIdentity.sessionId !== undefined &&
    frozenIdentity.sessionId !== currentIdentity.sessionId
  ) {
    return {
      ok: false,
      staleReason: `Session identity changed (${frozenIdentity.sessionId} -> ${currentIdentity.sessionId})`,
    };
  }
  return { ok: true };
}

export function verifyWorkflowPostHashes(
  expectedPostHashes: Record<string, string>,
  appliedFiles: Record<string, string>,
): { ok: boolean; mismatchedFiles: string[]; } {
  const mismatchedFiles: string[] = [];
  for (const [path, expectedHash] of Object.entries(expectedPostHashes)) {
    const actualText = appliedFiles[path];
    if (actualText === undefined) {
      mismatchedFiles.push(path);
      continue;
    }
    const actualHash = sha256Hex(actualText);
    if (actualHash !== expectedHash) {
      mismatchedFiles.push(path);
    }
  }
  return {
    ok: mismatchedFiles.length === 0,
    mismatchedFiles,
  };
}

export function cancelWorkflowPlan(_plan?: WorkflowPlan): {
  disposition: "cancelled";
  applied: boolean;
  effects: [];
} {
  return {
    disposition: "cancelled",
    applied: false,
    effects: [],
  };
}
