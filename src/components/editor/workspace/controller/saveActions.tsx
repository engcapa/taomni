import { workspaceReadFile, workspaceReadLooseFile, type WorkspaceFile, type WorkspaceWriteAck } from "../../../../lib/editor/workspace";
import { lspCodeActions, lspCodeActionResolve, lspWorkspaceDidChangeWatchedFiles, type LspDocumentDescriptor, type LspRange } from "../../../../lib/editor/lsp";
import type { OpenFileEol } from "../editorGroupTypes";
import { type ExplicitIndentationOverride } from "../codeStyleModel";
import { type PreparedSaveCommitter, type SaveTransactionV2, type WorkspaceStyleController } from "../workspaceStyleController";
import { buildFinalBytesReceipt, classifyUnknownDiskEffect, saveCommitResultFromError, SaveTransactionRegistry, type PreparedSave, type SaveCommitResult } from "../saveCommit";
import { createSaveObservationRecord, type SaveObservationRecord } from "../saveObservationContract";
import { recordSaveRaceEvent } from "../saveRaceProbe";
import { hasBlockingDiskEffectResolution, resolveDiskEffectLedgerEntry } from "../workspaceRecovery";
import { historySnapshot } from "../../../../lib/localHistory";
import { resolveEffectiveSavePolicy } from "../workspaceCodeStyleScheme";
import { activeSchemeForLanguage, type CodeStyleSchemeStoreState } from "../workspaceCodeStyleSchemes";
import { type EditorSelectionRange } from "../CodeMirrorHost";
import { validateAndApplyOrganizeImportsPlan } from "../saveOrganizeImportsAdapter";
import { WorkspaceObservationBridge, type WorkspaceSaveObservationResult } from "../workspaceObservationBridge";
import { type WorkspaceIntelligencePreferences } from "../intelligencePreferences";
import { CanonicalCodeActionService, type CodeActionContextIdentity, type CodeActionProviderClient } from "../codeActionProviderAdapter";
import type { CodeWorkspaceRootInfo } from "../../../../types";
import { type LspFileState, type OpenFileState, errorMessage, normalizeFsPath, relativePathWithinRoot } from "../codeWorkspaceModel";
import { type FormatFileOutcome, isJavaBuildFile } from "./model";



export interface CommitClosedFilePreparedSaveContext {
  saveTransactionRegistryRef: import("react").RefObject<SaveTransactionRegistry>;
  rootsRef: import("react").RefObject<CodeWorkspaceRootInfo[]>;
  cancelledSaveCommit: (prepared: PreparedSave, phase: "prepare" | "pre-write", reason: string) => SaveCommitResult;
  writeTextSnapshot: (request: { fileKey?: string; filePath: string; logicalText: string; expectedDiskHash: string | null; policy: { eol: OpenFileEol | "lf" | "crlf" | "cr"; encoding?: string; bom?: boolean; }; bufferVersion?: number; styleGeneration?: number; }) => Promise<WorkspaceWriteAck>;
  readBackDiskSnapshot: (prepared: PreparedSave) => Promise<Pick<WorkspaceFile, "hash" | "text" | "encoding" | "bom" | "size" | "mtime"> | null>;
  recordUnknownDiskEffect: (prepared: PreparedSave, observedHash: string | null, intendedNewHash: string | null) => void;
  recordCommittedDiscardLedgerEntry: (prepared: PreparedSave, writtenHash: string) => void;
}


export function createCommitClosedFilePreparedSave(controllerContext: CommitClosedFilePreparedSaveContext) {
  return async (
    prepared: PreparedSave,
    assertBeforeWrite?: () => void,
  ): Promise<SaveCommitResult> => {
    const registry = controllerContext.saveTransactionRegistryRef.current;
    const owner = registry.begin(prepared.workspaceId, prepared.fileKey, prepared.transactionId);
    try {
      let historyId: string | undefined;
      // Snapshot current disk contents before bulk WorkspaceEdit writes.
      try {
        let oldText: string | null = null;
        for (const root of controllerContext.rootsRef.current) {
          const rel = relativePathWithinRoot(root.path, prepared.filePath);
          if (rel === null) continue;
          try {
            oldText = (await workspaceReadFile(root.path, rel)).text;
          } catch {
            oldText = null;
          }
          break;
        }
        if (oldText == null) {
          try {
            oldText = (await workspaceReadLooseFile(prepared.filePath)).text;
          } catch {
            oldText = null;
          }
        }
        if (oldText != null && oldText.length <= 2 * 1024 * 1024) {
          const historyEntry = await historySnapshot(prepared.filePath, oldText, "replace").catch(() => null);
          if (historyEntry) historyId = `local-history-${historyEntry.id}`;
        }
      } catch {
        // Best-effort history; never block the edit write.
      }

      let ack: WorkspaceWriteAck;
      const ownerBeforeWrite = registry.check(owner);
      if (!ownerBeforeWrite.active) {
        return controllerContext.cancelledSaveCommit(prepared, "pre-write", ownerBeforeWrite.reason);
      }
      try {
        assertBeforeWrite?.();
      } catch (error) {
        return controllerContext.cancelledSaveCommit(prepared, "pre-write", errorMessage(error));
      }
      try {
        ack = await controllerContext.writeTextSnapshot({
          filePath: prepared.filePath,
          logicalText: prepared.text,
          expectedDiskHash: prepared.expectedDiskHash,
          policy: prepared.policy,
        });
      } catch (writeError) {
        // Same typed classification as open-buffer commits (§8.19.1).
        const mapped = saveCommitResultFromError(prepared.transactionId, writeError);
        if (mapped.diskEffect !== "unknown") {
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
        }
        // The bridge could not prove whether bytes landed: verify against the
        // real on-disk hash before reporting anything.
        const observed = await controllerContext.readBackDiskSnapshot(prepared);
        const verification = classifyUnknownDiskEffect({
          writtenHash: mapped.error.intentHash ?? mapped.error.writtenHash,
          expectedOldHash: prepared.expectedDiskHash,
          observedHash: observed?.hash ?? null,
        });
        const intendedHash = mapped.error.intentHash ?? mapped.error.writtenHash ?? null;
        if (verification.outcome === "committed" && observed) {
          // Intended bytes are provably on disk; continue as committed.
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
          // Verified zero disk effect — clear any stale ledger row for this
          // exact transaction/path only.
          resolveDiskEffectLedgerEntry(prepared.workspaceId, prepared.transactionId, prepared.filePath);
          return {
            kind: mapped.kind,
            transactionId: prepared.transactionId,
            diskEffect: "none",
            memoryEffect: "unchanged",
            providerEffect: "not-sent",
            error: mapped.error,
          } as SaveCommitResult;
        } else {
          controllerContext.recordUnknownDiskEffect(
            prepared,
            verification.outcome === "foreign" ? verification.observedHash : observed?.hash ?? null,
            intendedHash,
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
      }

      const receipt = buildFinalBytesReceipt(prepared, ack, { historyId });

      // Disk acknowledged. Watcher notify is generation-gated like every
      // other writeback side effect.
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
          reason: "Closed-file write owner was discarded during the write",
          receipt: { ...receipt, recoveryId },
          historyId: receipt.historyId,
          recoveryId,
        };
      }
      await lspWorkspaceDidChangeWatchedFiles(prepared.workspaceId, [{
        path: prepared.filePath,
        type: 2,
      }]).catch(() => 0);
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
      // A settled closed-file write clears its own ledger row for this path
      // only (§8.19.1).
      resolveDiskEffectLedgerEntry(prepared.workspaceId, prepared.transactionId, prepared.filePath);
      // No open buffer owns this write: no didSave is sent and nothing merges
      // back into memory ("saved-current" reports only the disk fact).
      return {
        kind: "saved-current",
        transactionId: prepared.transactionId,
        diskEffect: "committed",
        memoryEffect: "saved-current",
        providerEffect: "not-sent",
        file: ack.file,
        receipt,
        historyId: receipt.historyId,
      };
    } finally {
      registry.settle(owner);
    }
  };
}



export interface SaveFileContext {
  activeKey: string | null;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  absolutePathForOpenFile: (file: OpenFileState) => string | null;
  workspaceInstanceId: string;
  setStatusMessage: (message: string) => void;
  workspaceStyleControllerRef: import("react").RefObject<WorkspaceStyleController>;
  lspDescriptorForFile: (file: OpenFileState) => LspDocumentDescriptor | null;
  lspFilesRef: import("react").RefObject<Record<string, LspFileState>>;
  findRoot: (rootId: string) => CodeWorkspaceRootInfo | null;
  lspSessionGeneration: () => number;
  projectAnalysisSnapshot: import("../projectAnalysisModel").JavaProjectAnalysisSnapshotV1 | null;
  indentationOverridesRef: import("react").RefObject<Record<string, ExplicitIndentationOverride | null>>;
  codeStyleSchemesRef: import("react").RefObject<CodeStyleSchemeStoreState>;
  intelligencePreferences: WorkspaceIntelligencePreferences;
  commitOpenBufferPreparedSave: PreparedSaveCommitter;
  formatFileText: (file: OpenFileState, selection?: EditorSelectionRange | null) => Promise<FormatFileOutcome>;
  canonicalCodeActionServiceRef: import("react").RefObject<CanonicalCodeActionService | null>;
  setSaveObservations: import("react").Dispatch<import("react").SetStateAction<Record<string, SaveObservationRecord>>>;
  publishWorkspaceObservation: (update: (bridge: WorkspaceObservationBridge) => void) => void;
  promptReloadProject: (key: string, subtitle: string) => Promise<void>;
}


export function createSaveFile(controllerContext: SaveFileContext) {
  return async (key: string | null = controllerContext.activeKey) => {
      if (!key) return;
      const file = controllerContext.openFilesRef.current[key];
      if (!file || file.loading || file.saving || !file.dirty) return;

      const absPath = controllerContext.absolutePathForOpenFile(file) ?? file.languagePath;
      if (hasBlockingDiskEffectResolution(controllerContext.workspaceInstanceId, absPath)) {
        controllerContext.setStatusMessage(
          `Save blocked for ${file.subtitle}; verify the previous unknown disk result in the recovery center`,
        );
        return;
      }
      let saveActionError: string | null = null;

      const snapshotRevision = file.documentRevision ?? 0;
      const styleGeneration = controllerContext.workspaceStyleControllerRef.current.getGeneration();
      const descriptor = controllerContext.lspDescriptorForFile(file);
      const lspStatus = controllerContext.lspFilesRef.current[file.key]?.status ?? null;
      const projectRoot = file.ref.kind === "root" ? controllerContext.findRoot(file.ref.rootId) : null;
      const saveDocumentUri = descriptor?.documentUri
        ?? lspStatus?.uri
        ?? descriptor?.filePath
        ?? `file://${absPath}`;

      const tx: SaveTransactionV2 = {
        id: `tx-save-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        workspaceId: controllerContext.workspaceInstanceId,
        fileKey: file.key,
        filePath: absPath,
        bufferVersion: snapshotRevision,
        styleGeneration,
        expectedDiskHash: file.hash ?? null,
        documentIdentity: {
          uri: saveDocumentUri,
          path: absPath,
          revision: snapshotRevision,
          languageId: lspStatus?.languageId
            ?? descriptor?.languageId
            ?? "plaintext",
        },
        diskIdentity: {
          mtimeMs: file.mtime,
          sizeBytes: file.size,
          exists: true,
          sha256: file.hash ?? null,
        },
        providerIdentity: {
          id: lspStatus?.presetId ?? null,
          generation: lspStatus?.presetId ? controllerContext.lspSessionGeneration() : null,
        },
        projectIdentity: {
          fingerprint: controllerContext.projectAnalysisSnapshot?.projectFingerprint ?? null,
          rootUri: projectRoot ? `file://${normalizeFsPath(projectRoot.path)}` : null,
        },
        explicitOverride: controllerContext.indentationOverridesRef.current[file.key] ?? null,
        policy: {
          eol: (file.eol?.toLowerCase() as "lf" | "crlf" | "cr") ?? "lf",
          encoding: file.encoding ?? "UTF-8",
          bom: file.bom ?? false,
        },
        text: file.text,
      };

      const schemeLanguageKey = file.languagePath.split(".").pop()?.toLowerCase() ?? "";
      const activeScheme = activeSchemeForLanguage(
        controllerContext.codeStyleSchemesRef.current,
        schemeLanguageKey || null,
      );
      const effectiveSavePolicy = resolveEffectiveSavePolicy(
        activeScheme,
        controllerContext.intelligencePreferences.formatOnSave,
        absPath,
      );

      // The controller prepares (style/normalization/policy freeze into one
      // PreparedSave); the commit core is the single byte writer + writeback
      // owner shared with every other save path (§8.17.1).
      const outcome: SaveCommitResult = await controllerContext.workspaceStyleControllerRef.current.executeSaveTransaction(
        tx,
        (prepared) => controllerContext.commitOpenBufferPreparedSave(prepared),
        {
          savePolicy: effectiveSavePolicy,
          formatOnSave: effectiveSavePolicy.format.enabled,
          formatFn: async (currentText) => {
            try {
              const outcome = await controllerContext.formatFileText({ ...file, text: currentText });
              if (outcome.state === "unavailable") {
                saveActionError = `Format: ${outcome.reason}`;
                return null;
              }
              return outcome.text;
            } catch (err) {
              saveActionError = `Format: ${errorMessage(err)}`;
              return null;
            }
          },
          organizeImportsOnSave: effectiveSavePolicy.organizeImports.enabled,
          organizeImportsFn: async (shadowText) => {
            try {
              const textToProcess = shadowText ?? file.text ?? "";
              const wholeFileRange: LspRange = {
                start: { line: 0, character: 0 },
                end: { line: textToProcess.split("\n").length, character: 0 },
              };
              const descriptor = controllerContext.lspDescriptorForFile(file);
              if (!descriptor) return null;

              const context: CodeActionContextIdentity = {
                document: {
                  uri: descriptor.documentUri ?? controllerContext.lspFilesRef.current[file.key]?.status?.uri ?? descriptor.filePath ?? file.key,
                  revision: file.documentRevision,
                  languageId: controllerContext.lspFilesRef.current[file.key]?.status?.languageId ?? descriptor.languageId ?? "plaintext",
                },
                provider: {
                  id: descriptor.languageId === "java" || !descriptor.languageId ? "jdtls" : descriptor.languageId,
                  version: null,
                  generation: controllerContext.lspSessionGeneration(),
                  projectFingerprint: controllerContext.projectAnalysisSnapshot?.projectFingerprint ?? "",
                  trusted: true,
                },
                range: wholeFileRange,
                diagnostics: [],
                only: ["source.organizeImports"],
              };

              const client: CodeActionProviderClient = {
                requestCodeActions: async (params) => {
                  const result = await lspCodeActions(
                    descriptor,
                    params.range,
                    [],
                    params.context.only ? [...params.context.only] : undefined,
                  );
                  return result.actions;
                },
                resolveCodeAction: async (act) => {
                  if (!act.raw) return null;
                  const res = await lspCodeActionResolve(descriptor, act.raw);
                  return res.action;
                },
              };

              const planResult = await controllerContext.canonicalCodeActionServiceRef.current!.planAction(context, client, {
                only: ["source.organizeImports"],
              });
              if (!planResult.plan) {
                const noAction = planResult.requestState === "ready"
                  && planResult.outcome.state === "unresolved"
                  && planResult.outcome.reason === "No actions returned";
                if (planResult.requestState !== "unsupported" && !noAction) {
                  const reason = "reason" in planResult.outcome
                    ? planResult.outcome.reason
                    : planResult.outcome.state;
                  saveActionError = `Organize imports: ${reason}`;
                }
                return null;
              }

              const validation = validateAndApplyOrganizeImportsPlan(
                textToProcess,
                context.document.uri,
                planResult.plan,
                context.document.revision,
              );

              if (validation.valid && validation.transformedText !== null) {
                return validation.transformedText;
              }
              if (!validation.valid) {
                saveActionError = `Organize imports: ${validation.reason ?? "plan validation failed"}`;
              }
            } catch (err) {
              saveActionError = `Organize imports: ${errorMessage(err)}`;
              return null;
            }
            return null;
          },
          getLatestBufferVersion: () => controllerContext.openFilesRef.current[key]?.documentRevision ?? file.documentRevision ?? 0,
        },
      );
      recordSaveRaceEvent("commit-settled", {
        workspaceId: controllerContext.workspaceInstanceId,
        fileKey: key,
        transactionId: outcome.transactionId,
        filePath: absPath ?? file.path,
      }, {
        kind: outcome.kind,
        diskEffect: outcome.diskEffect,
        memoryEffect: outcome.memoryEffect,
        providerEffect: outcome.providerEffect,
      });

      const latestAfterSave = controllerContext.openFilesRef.current[key] ?? null;
      const observation = createSaveObservationRecord({
        result: outcome,
        fileKey: key,
        filePath: absPath,
        uri: saveDocumentUri,
        bufferRevision: latestAfterSave?.documentRevision ?? snapshotRevision,
        isDirty: latestAfterSave?.dirty ?? outcome.memoryEffect !== "saved-current",
      });
      controllerContext.setSaveObservations((current) => ({ ...current, [key]: observation }));
      const observationResult: WorkspaceSaveObservationResult = outcome.diskEffect === "committed"
        ? {
          transactionId: outcome.transactionId,
          diskEffect: outcome.diskEffect,
          receipt: {
            transactionId: outcome.receipt.transactionId,
            encodedBytesSha256: outcome.receipt.encodedBytesSha256,
            ...(outcome.receipt.historyId ? { historyId: outcome.receipt.historyId } : {}),
          },
        }
        : {
          transactionId: outcome.transactionId,
          diskEffect: outcome.diskEffect,
        };
      controllerContext.publishWorkspaceObservation((bridge) => bridge.observeSaveResult({
        result: observationResult,
        fileKey: key,
        bufferRevision: observation.bufferRevision,
      }));

      if (outcome.kind === "saved-current" || outcome.kind === "saved-stale-snapshot") {
        const latestNow = controllerContext.openFilesRef.current[key];
        const wasStale = outcome.kind === "saved-stale-snapshot"
          || (latestNow?.documentRevision ?? 0) > snapshotRevision;
        if (wasStale) {
          controllerContext.setStatusMessage(`Saved previous snapshot of ${file.subtitle}; current changes remain unsaved`);
        } else {
          controllerContext.setStatusMessage(saveActionError
            ? `Saved ${file.subtitle}; save action issue: ${saveActionError}`
            : `Saved ${file.subtitle}`);
        }
        if (isJavaBuildFile(file.languagePath) && controllerContext.lspFilesRef.current[key]?.status?.active) {
          void controllerContext.promptReloadProject(key, file.subtitle);
        }
      } else if (outcome.kind === "committed-writeback-discarded") {
        // Bytes are on disk but no buffer state was resurrected: never show a
        // success toast; the recovery center holds the disk path/hash.
        controllerContext.setStatusMessage(`${file.subtitle} written to disk after it closed; see recovery center for details`);
      } else if (outcome.kind === "cancelled") {
        controllerContext.setStatusMessage(`Save cancelled (${outcome.phase}): ${outcome.reason}`);
      } else if (outcome.kind === "conflict") {
        controllerContext.setStatusMessage(`Save conflict: ${outcome.error.message}`);
      } else if (outcome.diskEffect === "unknown") {
        // Unknown disk effect blocks automatic retries for this path until a
        // re-read confirms the real bytes (§8.18.1).
        controllerContext.setStatusMessage(`Save result unknown for ${file.subtitle}; verify the file in the recovery center before saving again`);
      } else {
        controllerContext.setStatusMessage(`Save failed: ${outcome.error.message}`);
      }
    };
}
