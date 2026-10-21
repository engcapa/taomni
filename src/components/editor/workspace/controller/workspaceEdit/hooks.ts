import { confirmAppDialog } from "../../../../../lib/appDialogs";
import { type LspWorkspaceEdit } from "../../../../../lib/editor/lsp";
import { workspaceReadFile, workspaceReadLooseFile } from "../../../../../lib/editor/workspace";
import { fsPathComparisonKey, fsPathEquals, normalizeFsPath, relativePathWithinRoot } from "../../codeWorkspaceModel";
import {
  buildTextWorkspaceEditRecoveryPlan,
  prepareRefactorRecoveryJournalV2,
  recordRefactorRecoveryJournalV2,
  type RefactorRecoveryJournalEntryV2,
  type RefactorRecoveryPreImageV2,
  type WorkspaceEditRecoveryPlan,
} from "../../refactorPlan";
import { replacePreimagePathKey, type ReplaceFilePreimage } from "../../replaceInFilesModel";
import { buildPreparedSave, nextSaveTransactionId, resolveWritePolicy, type SaveCommitResult } from "../../saveCommit";
import { validateSemanticWorkspaceEditPaths } from "../../semanticWorkspaceEdit";
import { WorkspaceEditOpenBufferSaveFailure, type WorkspaceEditApplyHooks } from "../../workspaceEditApply";
import { type WorkspaceEditPathSnapshot } from "../../workspaceEditHistory";
import { formatWorkspaceEditPreview, workspaceEditOperations, type WorkspaceEditPreview } from "../../workspaceEditPreview";
import { workspaceSemanticIndexBuildIsCurrent } from "../../workspaceSemanticIndex";
import type { WorkspaceEditApplyOptions } from "../mutationTypes";
import { type ApplyLspWorkspaceEditNowContext } from "./contract";

export interface WorkspaceEditHookContext {
  controllerContext: ApplyLspWorkspaceEditNowContext;
  edit: LspWorkspaceEdit;
  options: WorkspaceEditApplyOptions;
  beforeSnapshots: WorkspaceEditPathSnapshot[] | null;
  expectedDiskHashes: WorkspaceEditApplyOptions["expectedDiskHashes"] | null;
}

export function createWorkspaceEditHooks(context: WorkspaceEditHookContext) {
  const { controllerContext, edit, options, beforeSnapshots, expectedDiskHashes } = context;
  // §8.19.1: the edit actually applied after preview filtering drives any
  // resume slicing — never the pre-confirmation original.
  let resolvedEdit = edit;
  // ED-AUDIT-014: the v2 recovery journal is prepared once per apply run,
  // inside preflightMutation — after preview confirmation, before the first
  // mutation — and its typed persistence result gates the transaction.
  // Held in a holder object because the assignment happens inside a closure.
  const preparedJournalRef: { current: RefactorRecoveryJournalEntryV2 | null; } = { current: null };
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
  const assertPassBoundary = (pass: { edit: LspWorkspaceEdit; mutationStarted: boolean; }) => {
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
      const commitResult: { current: SaveCommitResult | null; } = { current: null };
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

  return {
    buildHooks,
    preparedJournalRef,
    applyTransactionId,
    get resolvedEdit() { return resolvedEdit; },
  };
}
