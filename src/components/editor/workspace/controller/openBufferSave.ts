import { type WorkspaceFile, type WorkspaceWriteAck } from "../../../../lib/editor/workspace";
import { lspWorkspaceDidChangeWatchedFiles } from "../../../../lib/editor/lsp";
import type { OpenFileEol } from "../editorGroupTypes";
import { type WorkspaceStyleController } from "../workspaceStyleController";
import { buildFinalBytesReceipt, classifySaveWriteback, classifyUnknownDiskEffect, saveCommitResultFromError, SaveTransactionRegistry, validatePreparedSaveBoundary, type PreparedSave, type SaveCommitResult } from "../saveCommit";
import { holdSaveRaceStage, recordSaveRaceEvent } from "../saveRaceProbe";
import { resolveDiskEffectLedgerEntry } from "../workspaceRecovery";
import { historySnapshot } from "../../../../lib/localHistory";
import { type OpenFileState, errorMessage, applyEditorEol, normalizeEditorText } from "../codeWorkspaceModel";
import { type BufferMutationPatch, type MutationReason } from "./mutationTypes";


export interface CommitOpenBufferPreparedSaveContext {
  saveTransactionRegistryRef: import("react").RefObject<SaveTransactionRegistry>;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  cancelledSaveCommit: (prepared: PreparedSave, phase: "prepare" | "pre-write", reason: string) => SaveCommitResult;
  mutateOpenBuffer: (key: string, patch: BufferMutationPatch, reason: MutationReason) => OpenFileState | null;
  absolutePathForOpenFile: (file: OpenFileState) => string | null;
  workspaceStyleControllerRef: import("react").RefObject<WorkspaceStyleController>;
  writeTextSnapshot: (request: { fileKey?: string; filePath: string; logicalText: string; expectedDiskHash: string | null; policy: { eol: OpenFileEol | "lf" | "crlf" | "cr"; encoding?: string; bom?: boolean; }; bufferVersion?: number; styleGeneration?: number; }) => Promise<WorkspaceWriteAck>;
  readBackDiskSnapshot: (prepared: PreparedSave) => Promise<Pick<WorkspaceFile, "hash" | "text" | "encoding" | "bom" | "size" | "mtime"> | null>;
  recordUnknownDiskEffect: (prepared: PreparedSave, observedHash: string | null, intendedNewHash: string | null) => void;
  recordCommittedDiscardLedgerEntry: (prepared: PreparedSave, writtenHash: string) => void;
  notifyWorkspacePathGitChanged: (rootId: string, path: string) => void;
  semanticIndex: import("../useWorkspaceSemanticIndex").WorkspaceSemanticIndexController;
  saveLspDocument: (file: OpenFileState, text: string) => Promise<void>;
  syncLspDocument: (file: OpenFileState, mode: "open" | "change") => Promise<void>;
}


export function createCommitOpenBufferPreparedSave(controllerContext: CommitOpenBufferPreparedSaveContext): (prepared: PreparedSave) => Promise<SaveCommitResult> {
  return async (
    prepared: PreparedSave,
  ): Promise<SaveCommitResult> => {
    const key = prepared.fileKey;
    const registry = controllerContext.saveTransactionRegistryRef.current;
    const owner = registry.begin(prepared.workspaceId, key, prepared.transactionId);
    try {
      const fileAtPrepare = controllerContext.openFilesRef.current[key];
      if (!fileAtPrepare) {
        return controllerContext.cancelledSaveCommit(prepared, "pre-write", "Open buffer was closed before write");
      }

      controllerContext.mutateOpenBuffer(key, { saving: true, error: null }, "save-metadata");

      let historyId: string | undefined;
      // Prepare-phase await: snapshot the previous on-disk contents before any
      // overwrite. Never mutates buffer text and never bumps a revision.
      if (prepared.filePath && fileAtPrepare.savedText.length <= 2 * 1024 * 1024) {
        const historyText = `${fileAtPrepare.bom ? "\uFEFF" : ""}${applyEditorEol(fileAtPrepare.savedText, fileAtPrepare.eol)}`;
        const historyEntry = await historySnapshot(prepared.filePath, historyText, "save").catch(() => null);
        if (historyEntry) historyId = `local-history-${historyEntry.id}`;
      }

      // ED-PARITY-002 QA build only: the probe may hold this prepare point
      // (writer not yet invoked) so the runner can type a real edit and prove
      // the pre-write boundary cancels with zero writer calls. Immediately
      // resolved in normal builds and when not armed.
      await holdSaveRaceStage({
        stage: "prepare",
        workspaceId: prepared.workspaceId,
        fileKey: key,
        transactionId: prepared.transactionId,
        filePath: prepared.filePath,
        revision: () => controllerContext.openFilesRef.current[key]?.documentRevision ?? null,
        stillValid: () => !!controllerContext.openFilesRef.current[key],
      });

      // 2. Pre-write commit boundary (SYNCHRONOUS, NO AWAIT)
      const currentBeforeWrite = controllerContext.openFilesRef.current[key];
      let cancellation: string | null = validatePreparedSaveBoundary(prepared, currentBeforeWrite
        ? {
            filePath: controllerContext.absolutePathForOpenFile(currentBeforeWrite) ?? currentBeforeWrite.path ?? "",
            documentRevision: currentBeforeWrite.documentRevision ?? 0,
            styleGeneration: controllerContext.workspaceStyleControllerRef.current.getGeneration(),
          }
        : null);
      if (!cancellation) {
        const ownerCheck = registry.check(owner);
        if (!ownerCheck.active) cancellation = ownerCheck.reason;
      }
      if (cancellation) {
        controllerContext.mutateOpenBuffer(key, { saving: false }, "save-metadata");
        return controllerContext.cancelledSaveCommit(prepared, "pre-write", cancellation);
      }

      // In the SAME synchronous turn, invoke the byte writer.
      const writerPromise = controllerContext.writeTextSnapshot({
        fileKey: key,
        filePath: prepared.filePath,
        logicalText: prepared.text,
        expectedDiskHash: prepared.expectedDiskHash,
        policy: prepared.policy,
      });
      recordSaveRaceEvent("writer-invoked", {
        workspaceId: prepared.workspaceId,
        fileKey: key,
        transactionId: prepared.transactionId,
        filePath: prepared.filePath,
      }, { byteLength: prepared.text.length });

      // ED-PARITY-002 QA build only: the writer above is the real native
      // writer; the probe may hold the ack delivery point (W1) so the runner
      // can type while the UI waits for the real write acknowledgement.
      await holdSaveRaceStage({
        stage: "ack",
        workspaceId: prepared.workspaceId,
        fileKey: key,
        transactionId: prepared.transactionId,
        filePath: prepared.filePath,
        revision: () => controllerContext.openFilesRef.current[key]?.documentRevision ?? null,
        stillValid: () => !!controllerContext.openFilesRef.current[key],
      });

      // 3. Writeback phase (merge, never overwrite text; generation-gated)
      try {
        let ack: WorkspaceWriteAck;
        try {
          ack = await writerPromise;
        } catch (writeError) {
          // §8.18.1: classify the typed IPC error by its native effect fact.
          const mapped = saveCommitResultFromError(prepared.transactionId, writeError);
          recordSaveRaceEvent("writer-failed", {
            workspaceId: prepared.workspaceId,
            fileKey: key,
            transactionId: prepared.transactionId,
            filePath: prepared.filePath,
          }, { kind: mapped.kind, diskEffect: mapped.diskEffect ?? null });
          controllerContext.mutateOpenBuffer(key, { dirty: true, saving: false, error: mapped.error.message }, "save-metadata");
          if (mapped.diskEffect === "unknown") {
            // The bridge could not prove whether bytes landed: verify against
            // the real on-disk hash before reporting anything.
            const observed = await controllerContext.readBackDiskSnapshot(prepared);
            const verification = classifyUnknownDiskEffect({
              writtenHash: mapped.error.intentHash ?? mapped.error.writtenHash,
              expectedOldHash: prepared.expectedDiskHash,
              observedHash: observed?.hash ?? null,
            });
            recordSaveRaceEvent("unknown-readback", {
              workspaceId: prepared.workspaceId,
              fileKey: key,
              transactionId: prepared.transactionId,
              filePath: prepared.filePath,
            }, {
              outcome: verification.outcome,
              observedHash: observed?.hash ?? null,
              writtenHash: mapped.error.intentHash ?? mapped.error.writtenHash ?? null,
              expectedOldHash: prepared.expectedDiskHash,
            });
            if (verification.outcome === "committed" && observed) {
              // Intended bytes are provably on disk: continue through the
              // normal committed classification with recovered metadata.
              ack = {
                file: {
                  path: prepared.filePath,
                  text: observed.text,
                  encoding: observed.encoding ?? prepared.policy.encoding,
                  bom: observed.bom ?? prepared.policy.bom,
                  size: observed.size ?? 0,
                  mtime: observed.mtime ?? 0,
                  hash: observed.hash,
                },
                writtenHash: mapped.error.writtenHash ?? observed.hash,
                writtenByteLength: mapped.error.writtenByteLength ?? observed.size ?? 0,
                intentHash: mapped.error.intentHash ?? mapped.error.writtenHash ?? observed.hash,
                oldHash: mapped.error.oldHash ?? prepared.expectedDiskHash,
                atomicReplaceUsed: true,
              };
            } else if (verification.outcome === "none") {
              // Verified zero disk effect — the write genuinely failed; clear
              // any stale ledger row for this exact transaction/path only.
              resolveDiskEffectLedgerEntry(prepared.workspaceId, prepared.transactionId, prepared.filePath);
              return mapped.kind === "conflict"
                ? {
                  kind: "conflict",
                  transactionId: prepared.transactionId,
                  diskEffect: "none",
                  memoryEffect: "unchanged",
                  providerEffect: "not-sent",
                  error: mapped.error,
                }
                : {
                  kind: "failed",
                  transactionId: prepared.transactionId,
                  diskEffect: "none",
                  memoryEffect: "unchanged",
                  providerEffect: "not-sent",
                  error: mapped.error,
                };
            } else {
              // Foreign content or unreadable: create a recovery entry with
              // the native intent hash and never auto-retry this path until a
              // user resolves it (§8.19.1).
              controllerContext.recordUnknownDiskEffect(
                prepared,
                verification.outcome === "foreign" ? verification.observedHash : observed?.hash ?? null,
                mapped.error.intentHash ?? mapped.error.writtenHash ?? null,
              );
              return {
                kind: "failed",
                transactionId: prepared.transactionId,
                diskEffect: "unknown",
                memoryEffect: "unchanged",
                providerEffect: "unknown",
                error: mapped.error,
                recoveryId: prepared.transactionId,
              };
            }
          } else if (mapped.kind === "conflict") {
            return {
              kind: "conflict",
              transactionId: prepared.transactionId,
              diskEffect: "none",
              memoryEffect: "unchanged",
              providerEffect: "not-sent",
              error: mapped.error,
            };
          } else {
            return {
              kind: "failed",
              transactionId: prepared.transactionId,
              diskEffect: "none",
              memoryEffect: "unchanged",
              providerEffect: "not-sent",
              error: mapped.error,
            };
          }
        }

        recordSaveRaceEvent("ack-delivered", {
          workspaceId: prepared.workspaceId,
          fileKey: key,
          transactionId: prepared.transactionId,
          filePath: prepared.filePath,
        }, {
          writtenHash: ack.writtenHash,
          writtenByteLength: ack.writtenByteLength,
          oldHash: ack.oldHash ?? null,
          documentRevision: controllerContext.openFilesRef.current[key]?.documentRevision ?? null,
        });

        const receipt = buildFinalBytesReceipt(prepared, ack, { historyId });

        // Disk acknowledged. From here only committed kinds exist (§8.18.1).
        const ownerAfterWrite = registry.check(owner);
        if (!ownerAfterWrite.active) {
          // Bytes landed on disk, but the owning buffer/tab/workspace is gone:
          // discard writeback, watcher, git/semantic and LSP side effects and
          // leave a recovery row the user can Reopen/Acknowledge (§8.19.1).
          controllerContext.recordCommittedDiscardLedgerEntry(prepared, ack.writtenHash);
          const recoveryId = prepared.transactionId;
          return {
            kind: "committed-writeback-discarded",
            transactionId: prepared.transactionId,
            diskEffect: "committed",
            memoryEffect: "writeback-discarded",
            providerEffect: "discarded",
            file: ack.file,
            reason: ownerAfterWrite.reason,
            receipt: { ...receipt, recoveryId },
            historyId: receipt.historyId,
            recoveryId,
          };
        }

        const liveBeforeWatcher = controllerContext.openFilesRef.current[key];
        const writebackBeforeWatcher = classifySaveWriteback(prepared, liveBeforeWatcher
          ? { documentRevision: liveBeforeWatcher.documentRevision ?? 0 }
          : null);
        if (writebackBeforeWatcher.kind === "discarded") {
          // Buffer closed while the writer was in flight: the disk write is
          // real, but no buffer or provider state may be resurrected.
          controllerContext.recordCommittedDiscardLedgerEntry(prepared, ack.writtenHash);
          const recoveryId = prepared.transactionId;
          return {
            kind: "committed-writeback-discarded",
            transactionId: prepared.transactionId,
            diskEffect: "committed",
            memoryEffect: "writeback-discarded",
            providerEffect: "discarded",
            file: ack.file,
            reason: writebackBeforeWatcher.reason,
            receipt: { ...receipt, recoveryId },
            historyId: receipt.historyId,
            recoveryId,
          };
        }

        const savedPath = controllerContext.absolutePathForOpenFile(fileAtPrepare);
        let watcherCompletion: Promise<number> | null = null;
        if (savedPath && registry.check(owner).active) {
          if (savedPath.endsWith(".editorconfig")) {
            controllerContext.workspaceStyleControllerRef.current.invalidate(savedPath);
          }
          watcherCompletion = lspWorkspaceDidChangeWatchedFiles(prepared.workspaceId, [{
            path: savedPath,
            type: 2,
          }]);
          recordSaveRaceEvent("watcher-invoked", {
            workspaceId: prepared.workspaceId,
            fileKey: key,
            transactionId: prepared.transactionId,
            filePath: prepared.filePath,
          }, { path: savedPath });
        }
        // ED-PARITY-002 QA build only: the notify above is real; the probe may
        // hold its completion delivery (W2) so the runner can type after the
        // real ack but before the writeback merge. No-op otherwise.
        await holdSaveRaceStage({
          stage: "watcher",
          workspaceId: prepared.workspaceId,
          fileKey: key,
          transactionId: prepared.transactionId,
          filePath: prepared.filePath,
          revision: () => controllerContext.openFilesRef.current[key]?.documentRevision ?? null,
          stillValid: () => registry.check(owner).active,
        });
        if (watcherCompletion) await watcherCompletion.catch(() => 0);
        if (!registry.check(owner).active) {
          controllerContext.recordCommittedDiscardLedgerEntry(prepared, ack.writtenHash);
          const recoveryId = prepared.transactionId;
          return {
            kind: "committed-writeback-discarded",
            transactionId: prepared.transactionId,
            diskEffect: "committed",
            memoryEffect: "writeback-discarded",
            providerEffect: "discarded",
            file: ack.file,
            reason: "Owner lost after watcher notify",
            receipt: { ...receipt, recoveryId },
            historyId: receipt.historyId,
            recoveryId,
          };
        }
        // Re-read and re-classify after the watcher await: edits typed while
        // the notify was pending must merge against the current live buffer,
        // never the pre-await snapshot (they would otherwise be overwritten
        // and their revision would falsely report a clean save).
        const liveAfterWrite = controllerContext.openFilesRef.current[key];
        const writeback = classifySaveWriteback(prepared, liveAfterWrite
          ? { documentRevision: liveAfterWrite.documentRevision ?? 0 }
          : null);
        if (writeback.kind === "discarded") {
          // Buffer closed while the watcher notify was in flight: the disk
          // write is real, but no buffer or provider state may be resurrected.
          controllerContext.recordCommittedDiscardLedgerEntry(prepared, ack.writtenHash);
          const recoveryId = prepared.transactionId;
          return {
            kind: "committed-writeback-discarded",
            transactionId: prepared.transactionId,
            diskEffect: "committed",
            memoryEffect: "writeback-discarded",
            providerEffect: "discarded",
            file: ack.file,
            reason: writeback.reason,
            receipt: { ...receipt, recoveryId },
            historyId: receipt.historyId,
            recoveryId,
          };
        }
        const normalized = normalizeEditorText(ack.file.text);
        const savedBom = prepared.policy.bom;
        const stale = writeback.kind === "saved-stale-snapshot";

        const latestNow = liveAfterWrite!;

        controllerContext.mutateOpenBuffer(
          key,
          {
            savedText: normalized.text,
            text: latestNow.text,
            eol: (prepared.policy.eol.toUpperCase() as OpenFileEol) ?? normalized.eol,
            encoding: prepared.policy.encoding,
            bom: savedBom,
            hash: ack.writtenHash || ack.file.hash,
            mtime: ack.file.mtime,
            size: ack.file.size,
            loading: false,
            saving: false,
            dirty: stale,
            error: null,
            documentRevision: latestNow.documentRevision,
          },
          "save-writeback",
        );

        if (!registry.check(owner).active) {
          // Closed between merge and provider sync; skip didSave/didChange
          // and leave the committed recovery row for Reopen/Acknowledge.
          controllerContext.recordCommittedDiscardLedgerEntry(prepared, ack.writtenHash);
          const recoveryId = prepared.transactionId;
          return {
            kind: "committed-writeback-discarded",
            transactionId: prepared.transactionId,
            diskEffect: "committed",
            memoryEffect: "writeback-discarded",
            providerEffect: "discarded",
            file: ack.file,
            reason: "Owner lost after writeback merge",
            receipt: { ...receipt, recoveryId },
            historyId: receipt.historyId,
            recoveryId,
          };
        }
        if (fileAtPrepare.ref.kind === "root") {
          controllerContext.notifyWorkspacePathGitChanged(fileAtPrepare.ref.rootId, fileAtPrepare.ref.path);
        }
        controllerContext.semanticIndex.invalidate("document-saved", [savedPath ?? fileAtPrepare.path]);

        // A settled save clears its own ledger row for this path only — never
        // other workspaces or paths (§8.18.1).
        resolveDiskEffectLedgerEntry(prepared.workspaceId, prepared.transactionId, prepared.filePath);

        if (!stale) {
          try {
            await controllerContext.saveLspDocument({ ...fileAtPrepare, text: prepared.text }, prepared.text);
            return {
              kind: "saved-current",
              transactionId: prepared.transactionId,
              diskEffect: "committed",
              memoryEffect: "saved-current",
              providerEffect: "did-save",
              file: ack.file,
              receipt,
              historyId: receipt.historyId,
            };
          } catch {
            // Provider sync failed after the disk write: do not roll back or
            // downgrade the disk fact; report the failed provider effect.
            return {
              kind: "saved-current",
              transactionId: prepared.transactionId,
              diskEffect: "committed",
              memoryEffect: "saved-current",
              providerEffect: "failed",
              file: ack.file,
              receipt,
              historyId: receipt.historyId,
            };
          }
        }
        try {
          // Stale-snapshot save: the disk now holds an older revision than the
          // live buffer. Sending didSave(snapshotText) would let the provider
          // observe an old document as the saved one; sync only the current
          // buffer via didChange and let the next explicit save own didSave.
          await controllerContext.syncLspDocument(latestNow, "change");
          return {
            kind: "saved-stale-snapshot",
            transactionId: prepared.transactionId,
            diskEffect: "committed",
            memoryEffect: "kept-dirty",
            providerEffect: "did-change-current",
            file: ack.file,
            savedRevision: prepared.bufferRevision,
            currentRevision: latestNow.documentRevision ?? 0,
            receipt,
            historyId: receipt.historyId,
          };
        } catch {
          return {
            kind: "saved-stale-snapshot",
            transactionId: prepared.transactionId,
            diskEffect: "committed",
            memoryEffect: "kept-dirty",
            providerEffect: "failed",
            file: ack.file,
            savedRevision: prepared.bufferRevision,
            currentRevision: latestNow.documentRevision ?? 0,
            receipt,
            historyId: receipt.historyId,
          };
        }
      } catch (err) {
        const message = errorMessage(err);
        controllerContext.mutateOpenBuffer(
          key,
          {
            dirty: true,
            saving: false,
            error: message,
          },
          "save-metadata",
        );
        throw err instanceof Error ? err : new Error(message);
      }
    } finally {
      registry.settle(owner);
    }
  };
}
