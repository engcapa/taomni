import { confirmAppDialog } from "../../../../lib/appDialogs";
import { type LspWorkspaceEdit } from "../../../../lib/editor/lsp";
import { fsPathComparisonKey } from "../codeWorkspaceModel";
import {
  buildRefactorPostTextIndex,
  refactorJournalPostImageMatches,
  resolveRefactorPostTextForDocument,
  updateRefactorRecoveryJournalV2,
  verifyRefactorMovePostEndpoints,
  verifyRefactorPostHashes,
} from "../refactorPlan";
import {
  applyWorkspaceEdit,
  buildWorkspaceEditApplyResultV2,
  classifyWorkspaceEditOperationRetry,
  retryOpenBufferSave,
  sliceWorkspaceEditForResume,
  summarizeWorkspaceEditOutcomes,
  type WorkspaceEditApplyOutcome,
  type WorkspaceEditApplyTransactionSummary,
} from "../workspaceEditApply";
import { workspaceEditUndoPrecondition, type WorkspaceEditHistoryEntry, type WorkspaceEditPathSnapshot } from "../workspaceEditHistory";
import { workspaceEditOperations } from "../workspaceEditPreview";
import type { WorkspaceEditApplyOptions } from "./mutationTypes";
import { type ApplyLspWorkspaceEditNowContext } from "./workspaceEdit/contract";
import { createWorkspaceEditHooks } from "./workspaceEdit/hooks";

export function createApplyLspWorkspaceEditNow(controllerContext: ApplyLspWorkspaceEditNowContext) {
  return async (
    edit: LspWorkspaceEdit,
    options: WorkspaceEditApplyOptions = {},
  ) => {
    const orderedOperations = workspaceEditOperations(edit);
    // ED-MAIN-005: frozen replace-preimage hashes bind the closed-file write to
    // the text read when the preview opened.
    const expectedDiskHashes = options.expectedDiskHashes ?? null;
    const beforeSnapshots = options.recordHistory !== false && orderedOperations.length > 0
      ? await controllerContext.captureWorkspaceEditPathSnapshots(edit)
      : null;
    const beforeBookmarks = beforeSnapshots
      ? controllerContext.captureWorkspaceEditBookmarkSnapshot(beforeSnapshots.map((snapshot) => snapshot.path))
      : null;
    const beforeTabs = beforeSnapshots
      ? controllerContext.captureWorkspaceEditTabSnapshot(beforeSnapshots.map((snapshot) => snapshot.path))
      : null;
    const applyOwner = createWorkspaceEditHooks({
      controllerContext, edit, options, beforeSnapshots, expectedDiskHashes,
    });
    const { buildHooks, preparedJournalRef, applyTransactionId } = applyOwner;
    let outcomes = await applyWorkspaceEdit(edit, buildHooks(true));
    const preMutation = outcomes.find((outcome) => outcome.operationIndex === null);
    if (preMutation) {
      controllerContext.setStatusMessage(summarizeWorkspaceEditOutcomes(outcomes));
      options.onTransactionSummary?.({
        effect: "none",
        postcondition: "not-applied",
        historyId: null,
        recoveryId: null,
        affectedPaths: [],
        reason: ("reason" in preMutation && preMutation.reason) ? preMutation.reason : null,
      });
      return outcomes;
    }
    const allOutcomesHistory: WorkspaceEditApplyOutcome[] = [...outcomes];
    const settledOutcomes = new Map<number, WorkspaceEditApplyOutcome>();
    for (const outcome of outcomes) {
      if (outcome.operationIndex !== null) {
        settledOutcomes.set(outcome.operationIndex, outcome);
      }
    }

    // §8.19.1: per-operation effect ledger with an explicit resume boundary.
    // A partial run stops at the failed operation; the user may re-run the
    // unapplied suffix, and every remaining text operation re-validates its
    // disk hash / open-buffer version before writing.
    const historySafePaths = new Set(
      (beforeSnapshots ?? [])
        .filter((snapshot) => snapshot.exists && snapshot.text !== null)
        .map((snapshot) => fsPathComparisonKey(snapshot.path)),
    );
    const getSettledOutcomesList = () => Array.from(settledOutcomes.values()).sort(
      (a, b) => (a.operationIndex ?? 0) - (b.operationIndex ?? 0),
    );
    const settleSuffix = (suffix: WorkspaceEditApplyOutcome[], startIndex: number) => {
      for (const outcome of suffix) {
        // A suffix-wide preflight failure belongs to its absolute resume
        // boundary, and must remain visible in the final transaction ledger.
        const settled = outcome.operationIndex === null
          ? { ...outcome, operationIndex: startIndex }
          : outcome;
        allOutcomesHistory.push(settled);
        settledOutcomes.set(settled.operationIndex ?? startIndex, settled);
      }
    };
    const buildApplyResult = () => buildWorkspaceEditApplyResultV2({
      transactionId: applyTransactionId,
      operations: workspaceEditOperations(applyOwner.resolvedEdit),
      outcomes: getSettledOutcomesList(),
      undoAvailability: beforeSnapshots
        ? (_index, _kind, targetPath) => historySafePaths.has(fsPathComparisonKey(targetPath)) ? "available" : "unavailable"
        : undefined,
    });
    {
      let applyResult = buildApplyResult();
      const allOperations = workspaceEditOperations(applyOwner.resolvedEdit);
      if (
        applyResult.disposition === "partial"
        && applyResult.nextOperationIndex !== null
        && options.recordHistory !== false
      ) {
        // Bounded resume loop; ED-REPAIR-001: retry only unexecuted operations or retry persistence safely
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const failedIndex = applyResult.nextOperationIndex;
          const failedOutcome = settledOutcomes.get(failedIndex);
          if (!failedOutcome || failedOutcome.status !== "failed") {
            break;
          }
          const retryKind = classifyWorkspaceEditOperationRetry(failedOutcome);
          if (retryKind === "unretryable") {
            // ED-IMPROVE-002 / ED-REPAIR-001: disk unknown or unretryable state blocks blind retry
            break;
          }

          if (retryKind === "retry-save-only") {
            const failedOp = allOperations[failedIndex];
            if (failedOp?.kind !== "text" || failedOutcome.expectedPostText === undefined) {
              break;
            }
            const docPath = failedOp.document.path ?? failedOp.document.uri;
            const resume = await confirmAppDialog({
              title: "Workspace edit save failed",
              message: `Edits to ${docPath} were applied to the open buffer, but saving to disk failed (${failedOutcome.reason}). `
                + `Retry saving and continue remaining operations?`,
              confirmLabel: "Retry save",
            });
            if (!resume) break;
            const retryOutcome = await retryOpenBufferSave({
              operationIndex: failedIndex,
              document: failedOp.document,
              expectedPostText: failedOutcome.expectedPostText,
              expectedKey: failedOutcome.openBufferKey,
              expectedVersion: failedOutcome.openBufferVersion,
              hooks: buildHooks(false),
            });
            allOutcomesHistory.push(retryOutcome);
            settledOutcomes.set(failedIndex, retryOutcome);

            if (retryOutcome.status.startsWith("applied")) {
              const nextIndex = failedIndex + 1;
              if (nextIndex < allOperations.length) {
                const remainingEdit = sliceWorkspaceEditForResume(applyOwner.resolvedEdit, nextIndex);
                const suffixOutcomes = await applyWorkspaceEdit(remainingEdit, buildHooks(false), nextIndex);
                settleSuffix(suffixOutcomes, nextIndex);
              }
            }
          } else {
            // retry-full
            const totalCount = allOperations.length;
            const resume = await confirmAppDialog({
              title: "Workspace edit partially applied",
              message: `${failedIndex} of ${totalCount} changes were applied. `
                + `Retry the remaining ${totalCount - failedIndex} from the failed boundary?`,
              confirmLabel: "Retry remaining changes",
            });
            if (!resume) break;
            const remainingEdit = sliceWorkspaceEditForResume(applyOwner.resolvedEdit, failedIndex);
            const suffixOutcomes = await applyWorkspaceEdit(remainingEdit, buildHooks(false), failedIndex);
            settleSuffix(suffixOutcomes, failedIndex);
          }

          applyResult = buildApplyResult();
          if (applyResult.disposition !== "partial" || applyResult.nextOperationIndex === null) break;
        }
      }
    }
    outcomes = getSettledOutcomesList();
    const allOutcomes = allOutcomesHistory;

    if (allOutcomes.some((outcome) => (
      outcome.status === "applied-create"
      || outcome.status === "applied-rename"
      || outcome.status === "applied-delete"
    ))) {
      controllerContext.refreshTree();
    }
    // ED-MAIN-001: an open-buffer edit mutates memory before an awaited save.
    // A failed save must still count the already-performed buffer effect so the
    // transaction is never reported as a zero-effect no-op.
    const bufferEffectPerformed = (outcome: WorkspaceEditApplyOutcome): boolean => (
      outcome.status === "failed" && outcome.bufferEffect === "performed"
    );
    const mutated = allOutcomes.some((outcome) => outcome.status.startsWith("applied") || bufferEffectPerformed(outcome));
    if (mutated) {
      controllerContext.semanticIndex.invalidate(
        "workspace-edit",
        allOutcomes.flatMap((outcome) => (
          outcome.status.startsWith("applied") || bufferEffectPerformed(outcome) ? [outcome.path] : []
        )),
      );
    }
    // ED-IMPROVE-002 / ED-REPAIR-001: one structured summary per apply run. The effect axis is
    // independent of the execution status: `unknown` marks a write whose OS
    // result could not be proven even though the operation reported failure.
    const appliedEffectPaths = Array.from(new Set(
      allOutcomes
        .filter((outcome) => outcome.status.startsWith("applied") || bufferEffectPerformed(outcome))
        .map((outcome) => outcome.path),
    ));
    const allOperations = workspaceEditOperations(applyOwner.resolvedEdit);
    const hasUnsettledOrFailedOperation = allOperations.some((_, index) => {
      const settled = settledOutcomes.get(index);
      return !settled || settled.status === "failed" || settled.status === "skipped";
    });
    const hasUnknownDiskEffect = allOutcomes.some((outcome) => (
      outcome.status === "failed" && outcome.diskEffect === "unknown"
    ));
    const transactionEffect: WorkspaceEditApplyTransactionSummary["effect"] = hasUnknownDiskEffect
      ? "unknown"
      : appliedEffectPaths.length === 0
        ? "none"
        : hasUnsettledOrFailedOperation
          ? "partial"
          : "performed";
    let historyEntryId: string | null = null;
    const emitTransactionSummary = (
      postcondition: WorkspaceEditApplyTransactionSummary["postcondition"],
      recoveryId: string | null,
    ): void => {
      const failedOutcomes = allOutcomes.filter((outcome) => outcome.status === "failed");
      const reason = failedOutcomes.find((outcome) => outcome.diskEffect === "unknown")?.reason
        ?? failedOutcomes[0]?.reason
        ?? null;
      options.onTransactionSummary?.({
        effect: transactionEffect,
        postcondition,
        historyId: historyEntryId,
        recoveryId,
        affectedPaths: appliedEffectPaths,
        reason,
      });
    };
    let historyUnavailable = options.recordHistory !== false
      && orderedOperations.length > 0
      && beforeSnapshots === null
      && mutated;
    let afterSnapshots: WorkspaceEditPathSnapshot[] | null = null;
    if (beforeSnapshots && mutated) {
      afterSnapshots = await controllerContext.captureWorkspaceEditPathSnapshots(edit);
      if (!afterSnapshots) historyUnavailable = true;
      const afterBookmarks = afterSnapshots
        ? controllerContext.captureWorkspaceEditBookmarkSnapshot(afterSnapshots.map((snapshot) => snapshot.path))
        : null;
      const changed = afterSnapshots?.some((snapshot, index) => (
        snapshot.path !== beforeSnapshots[index]?.path
        || snapshot.exists !== beforeSnapshots[index]?.exists
        || snapshot.text !== beforeSnapshots[index]?.text
        || snapshot.encoding !== beforeSnapshots[index]?.encoding
        || snapshot.bom !== beforeSnapshots[index]?.bom
      ));
      // ED-AUDIT-014: finalize the prepared journal against the real
      // post-state before any success is reported or history registered.
      // Every journalled document (open buffers and closed disk files alike)
      // is verified; a mismatch or unreadable post-state marks the entry
      // recovery-required, lists every applied effect, and never registers
      // the normal success history.
      let recoveryMessage: string | null = null;
      const preparedJournal = preparedJournalRef.current;
      if (preparedJournal) {
        const actualPostTexts: Record<string, string> = {};
        for (const snapshot of afterSnapshots ?? []) {
          if (snapshot.text !== null) actualPostTexts[snapshot.path] = snapshot.text;
        }
        // RC-01: identity-based post index (fsPathComparisonKey) plus ordered
        // move-chain resolution. A document addressed to a pre-move path
        // verifies against the bytes at the end of its move chain; a
        // still-present old path or an ambiguous chain fails closed instead
        // of aliasing a stale buffer into a false success.
        const postIndex = buildRefactorPostTextIndex(actualPostTexts);
        const journalMismatches = preparedJournal.documents.flatMap((doc) => {
          const target = doc.canonicalPath || doc.uri;
          const resolved = resolveRefactorPostTextForDocument(
            { uri: doc.uri, canonicalPath: doc.canonicalPath },
            preparedJournal.resourceMoves ?? [],
            postIndex,
          );
          if (!resolved) {
            return [{ uri: doc.uri, path: target, unreadable: true }];
          }
          return refactorJournalPostImageMatches(doc, resolved.text)
            ? []
            : [{ uri: doc.uri, path: target, unreadable: false }];
        });
        // RC-01: pure moves need endpoint proof (old gone, new present).
        const existsByKey = new Map<string, boolean | null>();
        for (const snapshot of afterSnapshots ?? []) {
          existsByKey.set(fsPathComparisonKey(snapshot.path), snapshot.exists);
        }
        // Ensure both move ends are represented even when a snapshot is
        // missing for one end (treated as not existing, i.e. verification
        // fails closed below).
        for (const move of preparedJournal.resourceMoves ?? []) {
          for (const raw of [move.oldPath ?? move.oldUri, move.newPath ?? move.newUri]) {
            if (raw && !existsByKey.has(fsPathComparisonKey(raw))) {
              existsByKey.set(fsPathComparisonKey(raw), false);
            }
          }
        }
        const movePostCheck = verifyRefactorMovePostEndpoints(
          preparedJournal.resourceMoves ?? [],
          existsByKey,
        );
        const postHashCheck = options.plan
          ? verifyRefactorPostHashes(options.plan, actualPostTexts)
          : { allMatched: true, mismatches: [], missing: [], verifiedDocuments: 0 };
        const failureBoundaryIndex = allOutcomes.find((outcome) => (
          outcome.operationIndex !== null
          && (outcome.status === "failed" || outcome.status === "skipped")
        ))?.operationIndex ?? null;
        const failedOutcomes = allOutcomes.filter((outcome) => outcome.status === "failed" || outcome.status === "skipped");
        // RC-01/AC-06: a required document without post text (`missing`), a
        // plan mismatch, a journal mismatch, or an unverified move endpoint
        // all fail closed. Zero verified documents never stand in for a plan
        // that expected text.
        const hasMissingPost = journalMismatches.some((mismatch) => mismatch.unreadable)
          || postHashCheck.missing.length > 0
          || !movePostCheck.allVerified;
        if (!afterSnapshots || journalMismatches.length > 0 || !postHashCheck.allMatched || !movePostCheck.allVerified) {
          const mismatchedPaths = Array.from(new Set([
            ...journalMismatches.map((mismatch) => mismatch.path),
            ...postHashCheck.mismatches.map((mismatch) => {
              const doc = options.plan?.documents.find((candidate) => candidate.uri === mismatch.uri);
              return doc?.canonicalPath ?? mismatch.uri;
            }),
            ...postHashCheck.missing.map((miss) => {
              const doc = options.plan?.documents.find((candidate) => candidate.uri === miss.uri);
              return doc?.canonicalPath ?? miss.uri;
            }),
            ...movePostCheck.missing,
          ]));
          const appliedEffects = allOutcomes
            .filter((outcome) => outcome.status.startsWith("applied") || bufferEffectPerformed(outcome))
            .map((outcome) => outcome.path);
          const reason = !afterSnapshots
            ? "post-state could not be read"
            : `mismatch on ${mismatchedPaths.join(", ")}`;
          updateRefactorRecoveryJournalV2(preparedJournal.recoveryId, (entry) => ({
            ...entry,
            status: "recovery-required",
            appliedOperationIndex: failureBoundaryIndex,
            verification: {
              mismatchedUris: Object.freeze([
                ...journalMismatches.map((mismatch) => mismatch.uri),
                ...postHashCheck.mismatches.map((mismatch) => mismatch.uri),
                ...postHashCheck.missing.map((miss) => miss.uri),
                ...movePostCheck.missing,
              ]),
              checkedAt: Date.now(),
              appliedEffects: Object.freeze(appliedEffects),
              failedEffects: Object.freeze(
                failedOutcomes.map((outcome) => ({
                  path: outcome.path,
                  status: outcome.status,
                  diskEffect: "diskEffect" in outcome ? outcome.diskEffect : undefined,
                  reason: outcome.reason ?? null,
                })),
              ),
            },
          }));
          console.warn("[refactor] Post-refactor postcondition failure detected:", {
            journalMismatches,
            planMismatches: postHashCheck.mismatches,
            planMissing: postHashCheck.missing,
            moveMissing: movePostCheck.missing,
            hasMissingPost,
          });
          const prefix = preparedJournal.kind === "replace" || preparedJournal.kind === "other"
            ? "Workspace edit"
            : "Refactor";
          const failedDetails = failedOutcomes.map((o) => `${o.path} (${o.reason ?? o.status})`).join("; ");
          recoveryMessage = `${prefix} postcondition failed (${failedDetails ? `failed: ${failedDetails}` : reason}); recovery required. `
            + `Applied changes on: ${appliedEffects.length > 0 ? appliedEffects.join(", ") : "none"}. `
            + `Undo was not registered; the pending recovery entry lists every affected file.`;
        } else if (hasUnsettledOrFailedOperation) {
          // ED-MAIN-001: the buffer effect was already performed but a later
          // await (a disk save) failed. The post-image may match the mutated
          // buffer, but the transaction is not a verified success, so keep the
          // prepared journal discoverable for recovery instead of committing it
          // as a no-op or registering normal success history.
          const failedEffects = allOutcomes
            .filter((outcome) => outcome.status === "failed")
            .map((outcome) => outcome.path);
          updateRefactorRecoveryJournalV2(preparedJournal.recoveryId, (entry) => ({
            ...entry,
            status: "recovery-required",
            appliedOperationIndex: failureBoundaryIndex,
            verification: {
              mismatchedUris: Object.freeze(failedEffects),
              checkedAt: Date.now(),
              appliedEffects: Object.freeze(appliedEffectPaths),
              failedEffects: Object.freeze(
                failedOutcomes.map((outcome) => ({
                  path: outcome.path,
                  status: outcome.status,
                  diskEffect: "diskEffect" in outcome ? outcome.diskEffect : undefined,
                  reason: outcome.reason ?? null,
                })),
              ),
            },
          }));
          const prefix = preparedJournal.kind === "replace" || preparedJournal.kind === "other"
            ? "Workspace edit"
            : "Refactor";
          const failedDetails = failedOutcomes.map((o) => `${o.path} (${o.reason ?? o.status})`).join("; ");
          recoveryMessage = `${prefix} is incomplete (${failedDetails ? `failed: ${failedDetails}` : "a write failed after the buffer changed"}); `
            + `recovery required. Applied changes on: `
            + `${appliedEffectPaths.length > 0 ? appliedEffectPaths.join(", ") : "none"}. `
            + `Undo was not registered; the pending recovery entry lists every affected file.`;
        } else {
          updateRefactorRecoveryJournalV2(preparedJournal.recoveryId, (entry) => ({
            ...entry,
            status: "committed",
            appliedOperationIndex: null,
            verification: {
              mismatchedUris: Object.freeze([]),
              checkedAt: Date.now(),
              appliedEffects: Object.freeze(appliedEffectPaths),
              failedEffects: Object.freeze([]),
            },
          }));
        }
      }
      if (recoveryMessage !== null) {
        controllerContext.setStatusMessage(recoveryMessage);
        emitTransactionSummary(
          afterSnapshots ? "mismatch" : "unreadable",
          preparedJournalRef.current?.recoveryId ?? null,
        );
        return outcomes;
      }
      if (hasUnsettledOrFailedOperation) {
        // ED-MAIN-001: a buffer effect was performed but the transaction
        // failed without a prepared recovery journal (no journal plan). The
        // transaction must not be reported as a verified success nor register
        // normal success history.
        controllerContext.setStatusMessage(
          `Workspace edit is incomplete: ${summarizeWorkspaceEditOutcomes(outcomes)}`,
        );
        emitTransactionSummary(
          afterSnapshots ? "mismatch" : "unreadable",
          preparedJournalRef.current?.recoveryId ?? null,
        );
        return outcomes;
      }
      if (afterSnapshots && changed) {
        const afterSnapshotList = afterSnapshots;
        const affectedBookmarkIds = Array.from(new Set([
          ...(beforeBookmarks ?? []).map((bookmark) => bookmark.id),
          ...(afterBookmarks ?? []).map((bookmark) => bookmark.id),
        ]));
        const afterTabs = controllerContext.captureWorkspaceEditTabSnapshot(
          afterSnapshotList.map((snapshot) => snapshot.path),
        );
        // ED-AUDIT-014 / ED-REPAIR-004: plan-gated or prepared-journal undo verifies the live state still matches
        // the recorded post-state; later user edits (disk or open buffer)
        // block the undo instead of being overwritten.
        const planUndoPaths = (options.plan || preparedJournalRef.current) ? afterSnapshotList : null;
        controllerContext.workspaceEditHistorySequenceRef.current += 1;
        const label = options.label?.trim() || "Workspace edit";
        const entry: WorkspaceEditHistoryEntry = {
          id: `${controllerContext.workspaceInstanceId}:${controllerContext.workspaceEditHistorySequenceRef.current}`,
          label,
          affectedPaths: beforeSnapshots.map((snapshot) => snapshot.path),
          undo: async () => {
            if (planUndoPaths) {
              const currentTexts: Record<string, string> = {};
              for (const snapshot of planUndoPaths) {
                const current = await controllerContext.readWorkspaceEditPathSnapshot(snapshot.path);
                if (current && current.text !== null) currentTexts[snapshot.path] = current.text;
              }
              const precondition = workspaceEditUndoPrecondition(planUndoPaths, currentTexts);
              if (precondition.blocked) {
                throw new Error(`Undo blocked to protect later edits: ${precondition.reasons.join("; ")}`);
              }
            }
            await controllerContext.replayWorkspacePathSnapshotsRef.current(beforeSnapshots);
            controllerContext.restoreWorkspaceBookmarkSnapshot(beforeBookmarks ?? [], affectedBookmarkIds);
            if (beforeTabs) await controllerContext.restoreWorkspaceEditTabs(beforeTabs);
          },
          redo: async () => {
            await controllerContext.replayWorkspacePathSnapshotsRef.current(afterSnapshotList);
            controllerContext.restoreWorkspaceBookmarkSnapshot(afterBookmarks ?? [], affectedBookmarkIds);
            await controllerContext.restoreWorkspaceEditTabs(afterTabs);
          },
        };
        controllerContext.workspaceEditHistory.push(entry);
        controllerContext.setWorkspaceEditHistoryRevision((revision) => revision + 1);
        historyEntryId = entry.id;
      }
    } else {
      const preparedJournal = preparedJournalRef.current;
      if (preparedJournal) {
        if (hasUnknownDiskEffect) {
          // ED-IMPROVE-002: a failed operation whose OS result could not be
          // proven must not close the journal as a no-op. Keep the preimages
          // discoverable for recovery.
          updateRefactorRecoveryJournalV2(preparedJournal.recoveryId, (entry) => ({
            ...entry,
            status: "recovery-required",
            verification: {
              mismatchedUris: Object.freeze(
                allOutcomes
                  .filter((outcome) => outcome.status === "failed" && outcome.diskEffect === "unknown")
                  .map((outcome) => outcome.path),
              ),
              checkedAt: Date.now(),
              appliedEffects: Object.freeze([]),
              failedEffects: Object.freeze(
                allOutcomes
                  .filter((outcome) => outcome.status === "failed")
                  .map((outcome) => ({
                    path: outcome.path,
                    status: outcome.status,
                    diskEffect: outcome.diskEffect,
                    reason: outcome.reason ?? null,
                  })),
              ),
            },
          }));
        } else {
          // Nothing mutated: postconditions hold trivially; close the journal
          // so no pending entry lingers for a no-op transaction.
          updateRefactorRecoveryJournalV2(preparedJournal.recoveryId, (entry) => ({
            ...entry,
            status: "committed",
            verification: {
              mismatchedUris: Object.freeze([]),
              checkedAt: Date.now(),
              appliedEffects: Object.freeze([]),
              failedEffects: Object.freeze([]),
            },
          }));
        }
      }
    }
    controllerContext.setStatusMessage([
      summarizeWorkspaceEditOutcomes(outcomes),
      historyUnavailable ? "Undo unavailable: workspace resource snapshot is incomplete" : null,
    ].filter(Boolean).join("; "));
    emitTransactionSummary(
      !mutated ? "not-applied" : afterSnapshots === null ? "unreadable" : "verified",
      !mutated && hasUnknownDiskEffect ? preparedJournalRef.current?.recoveryId ?? null : null,
    );
    return outcomes;
  };
}

export { type ApplyLspWorkspaceEditNowContext } from "./workspaceEdit/contract";
