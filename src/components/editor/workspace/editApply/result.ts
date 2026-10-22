import type { LspWorkspaceEditOperation } from "../../../../lib/editor/lsp";
import { type WorkspaceEditApplyOutcome, type WorkspaceEditApplyResponse, type WorkspaceEditApplyResultV2, type WorkspaceEditOperationEffect } from "./model";
import { workspaceEditResumeToken } from "./resume";

/**
 * Assemble the v2 whole-transaction result from ordered outcomes (§8.19.1):
 * a first blocked/failed boundary stops the run, everything before it is
 * committed or a confirmed no-op, and the resume token names the boundary.
 */
export function buildWorkspaceEditApplyResultV2(input: {
  transactionId: string;
  operations: readonly LspWorkspaceEditOperation[];
  outcomes: readonly WorkspaceEditApplyOutcome[];
  /** Shell-reported per-operation undo availability; defaults to unavailable. */
  undoAvailability?: (
    index: number,
    kind: WorkspaceEditOperationEffect["kind"],
    targetPath: string,
  ) => "available" | "unavailable";
}): WorkspaceEditApplyResultV2 {
  const { transactionId, operations, outcomes, undoAvailability } = input;

  // A null operationIndex means validation/confirmation refused before any
  // mutation: declined previews are cancelled, hard failures are blocked.
  const preMutation = outcomes.find((outcome) => outcome.operationIndex === null);
  if (preMutation) {
    return {
      transactionId,
      disposition: preMutation.status === "skipped" ? "cancelled" : "blocked",
      effects: [],
      nextOperationIndex: null,
      resumeToken: null,
    };
  }

  // ED-REPAIR-001: preserve latest settled outcome per operation index
  const latestOutcomesByIndex = new Map<number, WorkspaceEditApplyOutcome>();
  for (const outcome of outcomes) {
    if (outcome.operationIndex !== null) {
      latestOutcomesByIndex.set(outcome.operationIndex, outcome);
    }
  }

  const effects: WorkspaceEditOperationEffect[] = [];
  let failureBoundary: number | null = null;
  const recordedIndices = Array.from(latestOutcomesByIndex.keys()).sort((a, b) => a - b);
  for (const index of recordedIndices) {
    const outcome = latestOutcomesByIndex.get(index)!;
    const operation = operations[index];
    const kind = operation?.kind ?? "text";
    const targetPath = operation
      ? (operation.kind === "rename"
        ? operation.newPath ?? operation.newUri
        : operation.kind === "text"
          ? operation.document.path ?? operation.document.uri
          : operation.path ?? operation.uri)
      : outcome.path;
    const sourcePath = operation?.kind === "rename"
      ? operation.oldPath ?? operation.oldUri
      : null;
    const appliedOrSettled = outcome.status.startsWith("applied") || outcome.status === "noop";
    if (!appliedOrSettled && failureBoundary === null) {
      failureBoundary = index;
    }
    let result: WorkspaceEditOperationEffect["result"];
    if (outcome.status === "applied-disk") {
      result = outcome.result ?? null;
    } else if (kind !== "text") {
      result = outcome.status.startsWith("applied")
        ? { kind: "committed", diskEffect: "committed", path: targetPath }
        : {
          kind: "failed",
          diskEffect: "none",
          path: targetPath,
          message: outcome.status === "noop" ? "no-op" : ("reason" in outcome ? outcome.reason : "operation failed"),
          recoveryId: null,
        };
    } else {
      // Open-buffer-only edits carry no disk transaction fact.
      result = null;
    }
    effects.push({
      operationId: `${transactionId}:op-${index}`,
      index,
      kind,
      sourcePath,
      targetPath,
      result,
      undoState: appliedOrSettled
        ? undoAvailability?.(index, kind, targetPath) ?? "unavailable"
        : "unavailable",
      bufferEffect: ("bufferEffect" in outcome && outcome.bufferEffect) ? outcome.bufferEffect : (outcome.status === "applied-open" ? "performed" : "none"),
      diskEffect: ("diskEffect" in outcome && outcome.diskEffect) ? outcome.diskEffect : (outcome.status === "applied-disk" ? "committed" : "none"),
    });
  }

  if (failureBoundary === null) {
    return {
      transactionId,
      disposition: "committed",
      effects,
      nextOperationIndex: null,
      resumeToken: null,
    };
  }
  return {
    transactionId,
    disposition: "partial",
    effects,
    nextOperationIndex: failureBoundary,
    resumeToken: workspaceEditResumeToken(transactionId, failureBoundary),
  };
}

export function workspaceEditApplyResponse(
  outcomes: WorkspaceEditApplyOutcome[],
): WorkspaceEditApplyResponse {
  const failure = outcomes.find((outcome) => (
    outcome.status === "failed" || outcome.status === "skipped"
  ));
  if (!failure) {
    return { applied: true, failureReason: null, failedChange: null };
  }
  return {
    applied: false,
    failureReason: failure.reason,
    failedChange: failure.operationIndex,
  };
}

export function summarizeWorkspaceEditOutcomes(outcomes: WorkspaceEditApplyOutcome[]): string {
  const applied = outcomes.filter((item) => item.status.startsWith("applied")).length;
  const unchanged = outcomes.filter((item) => item.status === "noop").length;
  const failed = outcomes.filter((item) => item.status === "failed").length;
  const skipped = outcomes.filter((item) => item.status === "skipped").length;
  const firstReason = outcomes.find((item) => (
    item.status === "failed" || item.status === "skipped"
  ));
  const summary = `Applied ${applied}, unchanged ${unchanged}, failed ${failed}, skipped ${skipped}`;
  return firstReason ? `${summary}: ${firstReason.reason}` : summary;
}
