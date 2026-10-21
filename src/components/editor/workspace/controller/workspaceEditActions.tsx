import type { BufferMutationPatch, WorkspaceEditApplyOptions } from "./mutationTypes";
import { workspaceReadFile, workspaceReadLooseFile, type WorkspaceFile } from "../../../../lib/editor/workspace";
import { type LspWorkspaceEdit, type LspWorkspaceEditOperation } from "../../../../lib/editor/lsp";
import type { OpenFileEol } from "../editorGroupTypes";
import { type WorkspaceStyleController } from "../workspaceStyleController";
import { buildPreparedSave, nextSaveTransactionId, resolveWritePolicy, type PreparedSave, type SaveCommitResult } from "../saveCommit";
import { confirmAppDialog } from "../../../../lib/appDialogs";
import { applyWorkspaceEdit, buildWorkspaceEditApplyResultV2, classifyWorkspaceEditOperationRetry, retryOpenBufferSave, sliceWorkspaceEditForResume, summarizeWorkspaceEditOutcomes, WorkspaceEditOpenBufferSaveFailure, type WorkspaceEditApplyHooks, type WorkspaceEditApplyOutcome, type WorkspaceEditApplyTransactionSummary } from "../workspaceEditApply";
import { validateSemanticWorkspaceEditPaths } from "../semanticWorkspaceEdit";
import { formatWorkspaceEditPreview, workspaceEditOperations, type WorkspaceEditPreview } from "../workspaceEditPreview";
import { verifyRefactorPostHashes, buildRefactorPostTextIndex, resolveRefactorPostTextForDocument, verifyRefactorMovePostEndpoints, refactorJournalPostImageMatches, prepareRefactorRecoveryJournalV2, recordRefactorRecoveryJournalV2, updateRefactorRecoveryJournalV2, buildTextWorkspaceEditRecoveryPlan, type RefactorPlanV3, type RefactorRecoveryJournalEntryV2, type RefactorRecoveryPreImageV2, type WorkspaceEditRecoveryPlan } from "../refactorPlan";
import { workspaceEditUndoPrecondition, WorkspaceEditHistory, type WorkspaceEditHistoryEntry, type WorkspaceEditPathSnapshot } from "../workspaceEditHistory";
import { type WorkspaceBookmark } from "../todoBookmarks";
import { replacePreimagePathKey, type ReplaceFilePreimage } from "../replaceInFilesModel";
import type { CodeWorkspaceRootInfo } from "../../../../types";
import { type OpenFileState, fsPathComparisonKey, fsPathEquals, normalizeFsPath, relativePathWithinRoot } from "../codeWorkspaceModel";
import { workspaceSemanticIndexBuildIsCurrent } from "../workspaceSemanticIndex";
import { type WorkspaceEditTabSnapshot } from "./model";



export interface ApplyLspWorkspaceEditNowContext {
  captureWorkspaceEditPathSnapshots: (edit: LspWorkspaceEdit) => Promise<WorkspaceEditPathSnapshot[] | null>;
  captureWorkspaceEditBookmarkSnapshot: (paths: readonly string[]) => WorkspaceBookmark[];
  captureWorkspaceEditTabSnapshot: (paths: readonly string[]) => WorkspaceEditTabSnapshot;
  workspaceInstanceIdRef: import("react").RefObject<string>;
  workspaceInstanceId: string;
  rootsRef: import("react").RefObject<CodeWorkspaceRootInfo[]>;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  absolutePathForOpenFile: (file: OpenFileState) => string | null;
  workspaceResourceOperationLockedRef: import("react").RefObject<boolean>;
  lspDocumentVersion: (key: string) => number | null;
  isLspDocumentSynced: (key: string, text: string) => boolean;
  replayWorkspaceRestoreRef: import("react").RefObject<boolean>;
  mutateOpenBuffer: (key: string, patch: BufferMutationPatch, reason: "workspace-edit" | "user-edit" | "programmatic" | "reload" | "save-writeback" | "save-metadata" | "history-replay") => OpenFileState | null;
  updateFileText: (key: string, text: string) => void;
  saveOpenBufferText: (key: string, textToSave?: string, saveOptions?: { eol?: OpenFileEol | "lf" | "crlf" | "cr"; encoding?: string; bom?: boolean; }, onCommitResult?: (result: SaveCommitResult) => void) => Promise<WorkspaceFile | null>;
  replayWorkspaceEncodingRef: import("react").RefObject<Map<string, { encoding: string; bom: boolean; eol?: "lf" | "crlf" | "cr"; }> | null>;
  workspaceStyleControllerRef: import("react").RefObject<WorkspaceStyleController>;
  commitClosedFilePreparedSave: (prepared: PreparedSave, assertBeforeWrite?: () => void) => Promise<SaveCommitResult>;
  readWorkspaceEditPathSnapshot: (absolutePath: string) => Promise<WorkspaceEditPathSnapshot | null>;
  setRefactoringPreviewModal: import("react").Dispatch<import("react").SetStateAction<{ title: string; preview: WorkspaceEditPreview; originalEdit: LspWorkspaceEdit; plan?: RefactorPlanV3; sourceTexts?: Record<string, string | null>; resolve: (filtered: LspWorkspaceEdit | boolean) => void; } | null>>;
  semanticIndex: import("../useWorkspaceSemanticIndex").WorkspaceSemanticIndexController;
  applyLspResourceOperation: (operation: Exclude<LspWorkspaceEditOperation, { kind: "text"; }>) => Promise<void>;
  setStatusMessage: (message: string) => void;
  refreshTree: () => void;
  workspaceEditHistorySequenceRef: import("react").RefObject<number>;
  replayWorkspacePathSnapshotsRef: import("react").RefObject<(snapshots: readonly WorkspaceEditPathSnapshot[]) => Promise<void>>;
  restoreWorkspaceBookmarkSnapshot: (snapshot: readonly WorkspaceBookmark[], affectedIds: readonly string[]) => void;
  restoreWorkspaceEditTabs: (snapshot: WorkspaceEditTabSnapshot) => Promise<void>;
  workspaceEditHistory: WorkspaceEditHistory;
  setWorkspaceEditHistoryRevision: import("react").Dispatch<import("react").SetStateAction<number>>;
}


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
    // §8.19.1: the edit actually applied after preview filtering drives any
    // resume slicing — never the pre-confirmation original.
    let resolvedEdit = edit;
    // ED-AUDIT-014: the v2 recovery journal is prepared once per apply run,
    // inside preflightMutation — after preview confirmation, before the first
    // mutation — and its typed persistence result gates the transaction.
    // Held in a holder object because the assignment happens inside a closure.
    const preparedJournalRef: { current: RefactorRecoveryJournalEntryV2 | null } = { current: null };
    const assertExpectedDiskHash = (absolutePath: string, diskHash: string | null | undefined): void => {
      if (!expectedDiskHashes) return;
      const expected = expectedDiskHashes.get(replacePreimagePathKey(absolutePath));
      if (expected !== undefined && (diskHash == null || diskHash !== expected)) {
        throw new Error(`${absolutePath} changed since the frozen replace preview; reopen the preview`);
      }
    };
    // ED-AUDIT-014: the transaction id exists before the first apply pass so
    // the prepared recovery journal and the effect ledger share one identity.
    const applyTransactionId = nextSaveTransactionId("tx-wedit");
    const selectedPreimages = (activeEdit: LspWorkspaceEdit): readonly ReplaceFilePreimage[] => {
      if (options.kind !== "replace" || !options.expectedPreimages) return [];
      return workspaceEditOperations(activeEdit).flatMap((operation) => {
        if (operation.kind !== "text") return [];
        const path = operation.document.path;
        const candidates = options.expectedPreimages!.filter((preimage) => path && fsPathEquals(preimage.path, path));
        if (candidates.length !== 1) throw new Error(`Replace refused: missing or ambiguous frozen preimage for ${path}`);
        return candidates;
      });
    };
    const assertReplaceIdentity = (preimage: ReplaceFilePreimage) => {
      if (controllerContext.workspaceInstanceIdRef.current !== controllerContext.workspaceInstanceId
        || (preimage.workspaceInstanceId && preimage.workspaceInstanceId !== controllerContext.workspaceInstanceIdRef.current)) {
        throw new Error("Replace refused: workspace changed during apply");
      }
      if (!controllerContext.rootsRef.current.some((root) => relativePathWithinRoot(root.path, preimage.path) !== null)) {
        throw new Error(`${preimage.path} is outside the workspace; replace refused`);
      }
      const open = Object.values(controllerContext.openFilesRef.current).find((file) => {
        const path = controllerContext.absolutePathForOpenFile(file);
        return path !== null && fsPathEquals(path, preimage.path);
      });
      if (controllerContext.workspaceResourceOperationLockedRef.current || open?.library) {
        throw new Error(`${preimage.path} is read-only; replace refused`);
      }
      if (open) {
        if (preimage.bufferRevision === null) throw new Error(`${preimage.path} was opened since replace preview; please retry`);
        if (open.dirty) throw new Error(`${preimage.path} has unsaved modifications in the editor`);
        if (open.documentRevision !== preimage.bufferRevision) throw new Error(`${preimage.path} was modified in the editor since replace preview; please retry`);
      } else if (preimage.bufferRevision !== null) {
        throw new Error(`${preimage.path} was closed since replace preview; please retry`);
      }
      return open;
    };
    const assertPassBoundary = (pass: { edit: LspWorkspaceEdit; mutationStarted: boolean }) => {
      if (controllerContext.workspaceInstanceIdRef.current !== controllerContext.workspaceInstanceId || controllerContext.workspaceResourceOperationLockedRef.current) {
        throw new Error("Workspace changed or became read-only before mutation");
      }
      if (!pass.mutationStarted) {
        for (const preimage of selectedPreimages(pass.edit)) assertReplaceIdentity(preimage);
      }
    };
    const buildHooks = (
      allowPreview: boolean,
      pass = { edit: resolvedEdit, mutationStarted: false },
    ): WorkspaceEditApplyHooks => ({
      resolvePath: (file) => {
        if (file.path) return normalizeFsPath(file.path);
        return null;
      },
      getOpenBuffer: (absolutePath) => {
        if (controllerContext.workspaceInstanceIdRef.current !== controllerContext.workspaceInstanceId || controllerContext.workspaceResourceOperationLockedRef.current) return null;
        const normalized = normalizeFsPath(absolutePath);
        for (const file of Object.values(controllerContext.openFilesRef.current)) {
          const path = controllerContext.absolutePathForOpenFile(file);
          if (path && fsPathEquals(path, normalized)) {
            if (file.library) return null;
            return {
              text: file.text,
              dirty: file.dirty,
              key: file.key,
              version: controllerContext.lspDocumentVersion(file.key),
              revision: file.documentRevision ?? null,
              lspSynced: controllerContext.isLspDocumentSynced(file.key, file.text),
            };
          }
        }
        return null;
      },
      assertTextDocumentPreconditions: (path) => {
        if (options.kind === "replace" && options.expectedPreimages) {
          const preimage = options.expectedPreimages.find((p) => fsPathEquals(p.path, path));
          if (!preimage) throw new Error(`${path} is missing a frozen replace preimage`);
          assertReplaceIdentity(preimage);
        }
      },
      assertMutationBoundary: () => {
        assertPassBoundary(pass);
        options.assertOwnerAtMutationBoundary?.();
      },
      applyToOpenBuffer: (key, nextText) => {
        pass.mutationStarted = true;
        // ED-AUDIT-008: a restore replaying through this funnel must not
        // create a second undoable document entry beside the journal
        // transaction that owns the change, so its buffer write is recorded
        // as a history replay (see replayWorkspaceRestoreRef).
        if (controllerContext.replayWorkspaceRestoreRef.current) {
          controllerContext.mutateOpenBuffer(key, { text: nextText, error: null }, "history-replay");
          return;
        }
        controllerContext.updateFileText(key, nextText);
      },
      // §5.2.9 open-clean: apply then save so the buffer is not left dirty.
      // ED-AUDIT-003: the shared committer reports a failed or cancelled disk
      // write as a typed result (null here), not a rejection. The applier
      // contract is Promise<void>, so the only truthful failure signal is a
      // throw — otherwise a readonly or conflicted save would be recorded as
      // a phantom "applied-open" and the workspace-edit report would claim a
      // completion the disk never reached. The buffer keeps the applied text,
      // its dirty flag and the committer's error message for in-editor
      // recovery.
      saveOpenBuffer: async (key, nextText) => {
        const commitResult: { current: SaveCommitResult | null } = { current: null };
        const saved = await controllerContext.saveOpenBufferText(key, nextText, undefined, (result) => {
          commitResult.current = result;
        });
        if (!saved) {
          const error = controllerContext.openFilesRef.current[key]?.error;
          const message = error || `save did not commit for open buffer ${key}`;
          throw new WorkspaceEditOpenBufferSaveFailure(
            message,
            commitResult.current?.diskEffect === "unknown" ? "unknown" : "none",
          );
        }
      },
      readDisk: async (absolutePath) => {
        // Prefer workspace APIs via root-relative path when possible.
        for (const root of controllerContext.rootsRef.current) {
          const rel = relativePathWithinRoot(root.path, absolutePath);
          if (rel === null) continue;
          try {
            const disk = await workspaceReadFile(root.path, rel);
            assertExpectedDiskHash(absolutePath, disk.hash);
            const eol = disk.text.includes("\r\n") ? ("crlf" as const) : disk.text.includes("\r") && !disk.text.includes("\n") ? ("cr" as const) : ("lf" as const);
            return {
              text: disk.text,
              hash: disk.hash,
              encoding: disk.encoding ?? "UTF-8",
              bom: disk.bom ?? false,
              eol,
            };
          } catch {
            return null;
          }
        }
        try {
          const disk = await workspaceReadLooseFile(absolutePath);
          assertExpectedDiskHash(absolutePath, disk.hash);
          const eol = disk.text.includes("\r\n") ? ("crlf" as const) : disk.text.includes("\r") && !disk.text.includes("\n") ? ("cr" as const) : ("lf" as const);
          return {
            text: disk.text,
            hash: disk.hash,
            encoding: disk.encoding ?? "UTF-8",
            bom: disk.bom ?? false,
            eol,
          };
        } catch {
          return null;
        }
      },
      writeDisk: async (
        absolutePath,
        text,
        expectedHash,
        encoding = "UTF-8",
        bom = false,
        eol?: "lf" | "crlf" | "cr",
      ) => {
        const replayMetadata = controllerContext.replayWorkspaceEncodingRef.current?.get(fsPathComparisonKey(absolutePath));
        // Replay metadata is the authoritative prior state for undo; it wins
        // over applier defaults but both flow through the single policy
        // resolution shared with open-buffer saves (§8.17.1 step 1). The
        // closed-file path goes through the same shared committer as every
        // other write and returns its full typed result (§8.19.1).
        const prepared = buildPreparedSave({
          transactionId: nextSaveTransactionId(),
          workspaceId: controllerContext.workspaceInstanceId,
          fileKey: `closed:${absolutePath}`,
          filePath: absolutePath,
          text,
          bufferRevision: -1,
          styleGeneration: controllerContext.workspaceStyleControllerRef.current.getGeneration(),
          expectedDiskHash: expectedHash ?? null,
          policy: resolveWritePolicy({
            explicit: {
              encoding: replayMetadata?.encoding ?? encoding,
              bom: replayMetadata?.bom ?? bom,
              eol: replayMetadata?.eol ?? eol ?? "lf",
            },
          }),
        });
        return controllerContext.commitClosedFilePreparedSave(prepared, () => {
          // The committer awaits local-history reads too. Keep the whole-set
          // guard live until it actually invokes the first byte writer.
          assertPassBoundary(pass);
          if (options.kind === "replace" && options.expectedPreimages) {
            const preimage = options.expectedPreimages.find((candidate) => fsPathEquals(candidate.path, absolutePath));
            if (!preimage) throw new Error(`${absolutePath} is missing a frozen replace preimage`);
            assertReplaceIdentity(preimage);
          }
          pass.mutationStarted = true;
        });
      },
      confirmChangeAnnotations: async (annotations) => {
        const visible = annotations.slice(0, 8);
        const details = visible.map((annotation) => (
          annotation.description
            ? `${annotation.label}: ${annotation.description}`
            : annotation.label
        ));
        if (annotations.length > visible.length) {
          details.push(`And ${annotations.length - visible.length} more changes`);
        }
        return confirmAppDialog({
          title: "Apply language server changes",
          message: details.join("\n"),
          confirmLabel: "Apply",
        });
      },
      confirmWorkspaceEdit: allowPreview && options.preview
        ? (preview: WorkspaceEditPreview, edit: LspWorkspaceEdit) => {
            if (preview.usages.length > 0) {
              return (async () => {
                // ED-PARITY-017 DEC-017-05: real preimage text per affected file.
                const sourceTexts: Record<string, string | null> = {};
                for (const path of new Set(preview.usages.map((usage) => usage.path))) {
                  try {
                    const snapshot = await controllerContext.readWorkspaceEditPathSnapshot(path.replace(/^file:\/\//, ""));
                    sourceTexts[path] = snapshot?.exists && typeof snapshot.text === "string" ? snapshot.text : null;
                  } catch {
                    sourceTexts[path] = null;
                  }
                }
                return sourceTexts;
              })().then((sourceTexts) => new Promise<boolean | LspWorkspaceEdit>((resolve) => {
                controllerContext.setRefactoringPreviewModal({
                  sourceTexts,
                  title: options.label?.trim() || preview.label || "Review workspace changes",
                  preview: {
                    ...preview,
                    label: options.label?.trim() || preview.label,
                  },
                  originalEdit: edit,
                  plan: options.plan && "operations" in options.plan ? options.plan : undefined,
                  resolve,
                });
              }));
            }
            return confirmAppDialog({
              title: options.label?.trim() || "Review workspace changes",
              message: formatWorkspaceEditPreview({
                ...preview,
                label: options.label?.trim() || preview.label,
              }),
              confirmLabel: "Apply changes",
            });
          }
        : undefined,
      preflightMutation: options.preflightMutation
        || (options.semanticGeneration != null && options.semanticRevision != null)
        || options.recordHistory !== false
        || (options.kind === "replace" && Boolean(options.expectedPreimages))
        ? async () => {
          await options.preflightMutation?.();
          // ED-REPAIR-002: In replace, verify all preimages before any file is touched
          if (options.kind === "replace" && options.expectedPreimages) {
            for (const preimage of selectedPreimages(pass.edit)) {
              const open = assertReplaceIdentity(preimage);
              if (!open) {
                const containing = controllerContext.rootsRef.current.find(
                  (root) => relativePathWithinRoot(root.path, preimage.path) !== null,
                );
                if (containing) {
                  const rel = relativePathWithinRoot(containing.path, preimage.path) ?? "";
                  const disk = await workspaceReadFile(containing.path, rel);
                  if (disk.hash !== preimage.textHash) {
                    throw new Error(`${preimage.path} changed on disk since replace preview; please retry`);
                  }
                }
              }
            }
          }
          if (options.semanticGeneration == null || options.semanticRevision == null) {
            // fall through to journal preparation below
          } else {
            const current = controllerContext.semanticIndex.current();
            const semanticToken = {
              generation: options.semanticGeneration!,
              revision: options.semanticRevision!,
            };
            const valid = options.semanticRequireReady === false
              ? current.revision === semanticToken.revision
              : workspaceSemanticIndexBuildIsCurrent(current, semanticToken);
            if (!valid) {
              throw new Error("Semantic result became stale before changes were applied; run the action again");
            }
          }
          // ED-AUDIT-014 / ED-REPAIR-004: prepare the v2 recovery journal before the first
          // mutation. A persistence failure aborts the whole transaction with
          // zero writes; a text target without a preimage does the same.
          if (options.recordHistory !== false && !preparedJournalRef.current) {
            const preImages: RefactorRecoveryPreImageV2[] = [];
            for (const operation of workspaceEditOperations(resolvedEdit)) {
              if (operation.kind !== "text") continue;
              const targetPath = operation.document.path ? normalizeFsPath(operation.document.path) : null;
              const snapshot = targetPath
                ? beforeSnapshots?.find((candidate) => fsPathEquals(candidate.path, targetPath))
                : undefined;
              if (!snapshot || snapshot.text === null) continue;
              preImages.push({
                uri: operation.document.uri,
                canonicalPath: snapshot.path,
                preText: snapshot.text,
                encoding: snapshot.encoding,
                bom: snapshot.bom,
                eol: snapshot.eol ?? null,
              });
            }
            const recoveryPlan: WorkspaceEditRecoveryPlan = options.plan ?? buildTextWorkspaceEditRecoveryPlan({
              actionId: options.actionId ?? undefined,
              kind: options.kind,
              label: options.label,
              transactionId: applyTransactionId,
            });
            const preparation = prepareRefactorRecoveryJournalV2({
              plan: recoveryPlan,
              edit: resolvedEdit,
              preImages,
              workspaceRoot: controllerContext.rootsRef.current[0]?.path ?? "",
              transactionId: applyTransactionId,
            });
            if (preparation.state === "incomplete") {
              throw new Error(preparation.reason);
            }
            if (preparation.state === "prepared") {
              const writeResult = recordRefactorRecoveryJournalV2(preparation.entry);
              if (!writeResult.ok) {
                throw new Error(
                  `Refactor recovery journal could not be persisted, no changes were applied. `
                    + `Retry the action. Reason: ${writeResult.reason}`,
                );
              }
              preparedJournalRef.current = preparation.entry;
            }
            // "unsupported" (resource operations) keeps the explicit no-recovery boundary.
          }
        }
        : undefined,
      validateOperationPaths: options.semanticWorkspaceOnly || (options.semanticGeneration != null && options.semanticRevision != null)
        ? (operations) => validateSemanticWorkspaceEditPaths(
          operations,
          controllerContext.rootsRef.current.map((root) => root.path),
        )
        : undefined,
      createFile: (operation) => controllerContext.applyLspResourceOperation(operation),
      renameFile: (operation) => controllerContext.applyLspResourceOperation(operation),
      deleteFile: (operation) => controllerContext.applyLspResourceOperation(operation),
      onActiveEditResolved: (activeEdit) => {
        pass.edit = activeEdit;
        if (allowPreview) {
          resolvedEdit = activeEdit;
          options.onActiveEditResolved?.(activeEdit);
        }
      },
    });
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
      operations: workspaceEditOperations(resolvedEdit),
      outcomes: getSettledOutcomesList(),
      undoAvailability: beforeSnapshots
        ? (_index, _kind, targetPath) => historySafePaths.has(fsPathComparisonKey(targetPath)) ? "available" : "unavailable"
        : undefined,
    });
    {
      let applyResult = buildApplyResult();
      const allOperations = workspaceEditOperations(resolvedEdit);
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
                const remainingEdit = sliceWorkspaceEditForResume(resolvedEdit, nextIndex);
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
            const remainingEdit = sliceWorkspaceEditForResume(resolvedEdit, failedIndex);
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
    const allOperations = workspaceEditOperations(resolvedEdit);
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
