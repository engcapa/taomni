import { lspCodeActionResolve, type LspCodeAction, type LspDiagnostic, type LspDocumentDescriptor, type LspRange, type LspWorkspaceEdit } from "../../../../lib/editor/lsp";
import { loadAutoImportPreferences } from "../../../../lib/autoImportPreferences";
import { planAutoImport, planPasteAutoImports, parseProviderImportCandidates, scanPastedTypeTokens, buildPasteWithImportsChanges, computeImportInsertionOffset, type AutoImportCandidate, type AutoImportPlanOutcome } from "../autoImportModel";
import { confirmAppDialog } from "../../../../lib/appDialogs";
import { readText } from "../../../../lib/clipboard";
import { type EditorCommandId, type EditorCommandOptions } from "../CodeMirrorHost";
import { workspaceEditApplyResponse, type WorkspaceEditApplyOutcome, type WorkspaceEditApplyTransactionSummary } from "../workspaceEditApply";
import { type RefactorKind, type RefactorPlanV3, type WorkspaceEditRecoveryPlan } from "../refactorPlan";
import { sha256Hex } from "../projectAnalysisModel";
import { type CodeActionContextIdentity, type ProviderActionV4 } from "../codeActionProviderAdapter";
import { useProjectFactsStore } from "../../../../stores/projectFactsStore";
import { type ReplaceFilePreimage } from "../replaceInFilesModel";
import { type LspFileState, type OpenFileState, errorMessage } from "../codeWorkspaceModel";
import { type WorkspaceSemanticIndexBuildToken } from "../workspaceSemanticIndex";
import { resolveCleanupCapabilities, resolveRearrangeCapabilities, executeCleanupTransaction, executeRearrangeTransaction, validateWorkflowProviderAction, CLEANUP_ACTION_KINDS, REARRANGE_ACTION_KINDS, isCleanupActionKind, isRearrangeActionKind } from "../rearrangeCleanupWorkflow";
import { type ExtractReceipt } from "../extractMethodFlow";



export interface ExecuteAutoImportOnTheFlyContext {
  activeFile: import("../editorGroupTypes").OpenFileViewModel | null;
  lspFilesRef: import("react").RefObject<Record<string, LspFileState>>;
  projectFactsRoot: string;
  requestCodeActions: (file: OpenFileState, range: LspRange, diagnostics?: LspDiagnostic[], only?: string[], options?: { signal?: AbortSignal; allowCapabilityFallback?: boolean; }) => Promise<{ actions: LspCodeAction[]; providerActions: readonly ProviderActionV4[]; context: CodeActionContextIdentity | null; semanticToken: WorkspaceSemanticIndexBuildToken | null; requestFailure: { kind: "stale" | "sync-pending" | "descriptor-missing" | "failed" | "provider"; message: string; } | null; }>;
  runCodeAction: (action: LspCodeAction, file: OpenFileState, semanticToken?: WorkspaceSemanticIndexBuildToken | null, intentionCandidateId?: string, intentionContext?: CodeActionContextIdentity, receiptSessionId?: string) => Promise<{ ok: boolean; message: string | null; retryable: boolean; appliedReceipt?: ExtractReceipt; }>;
  setStatusMessage: (message: string) => void;
  setAutoImportCandidatePrompt: import("react").Dispatch<import("react").SetStateAction<{ candidates: readonly AutoImportCandidate[]; onSelect: (candidate: AutoImportCandidate) => void; onClose: () => void; } | null>>;
}


export function createExecuteAutoImportOnTheFly(controllerContext: ExecuteAutoImportOnTheFlyContext) {
  return async (
    targetFile?: OpenFileState,
  ): Promise<AutoImportPlanOutcome> => {
    const file = targetFile ?? controllerContext.activeFile;
    if (!file || file.loading || Boolean((file as { library?: boolean }).library)) {
      return { outcome: "none", reason: "disabled" };
    }
    const isJava = file.languagePath.endsWith(".java") || controllerContext.lspFilesRef.current[file.key]?.status?.languageId === "java";
    if (!isJava) {
      return { outcome: "none", reason: "disabled" };
    }

    const settings = loadAutoImportPreferences();
    if (!settings.addUnambiguousImportsOnTheFly) {
      return { outcome: "none", reason: "disabled" };
    }

    // Gating against project facts generation (ED-IMPORT-001-A3)
    const facts = useProjectFactsStore.getState().getWorkspaceFacts(controllerContext.projectFactsRoot);
    if (facts.status !== "ready") {
      return {
        outcome: "none",
        reason: facts.status === "untrusted" ? "untrusted-facts" : "unready-facts",
      };
    }
    const expectedGeneration = facts.generation;

    const diagnostics = controllerContext.lspFilesRef.current[file.key]?.diagnostics ?? [];
    const unresolvedDiags = diagnostics.filter((diag) => (
      /cannot find symbol|cannot be resolved to a type|unknown class|cannot resolve symbol/i.test(diag.message)
    ));

    if (unresolvedDiags.length === 0) {
      return { outcome: "none", reason: "no-candidates" };
    }

    let lastOutcome: AutoImportPlanOutcome = { outcome: "none", reason: "no-candidates" };

    for (const diag of unresolvedDiags) {
      // Re-verify project facts generation before requesting
      const currentFacts = useProjectFactsStore.getState().getWorkspaceFacts(controllerContext.projectFactsRoot);
      if (currentFacts.status !== "ready" || currentFacts.generation !== expectedGeneration) {
        return { outcome: "none", reason: "stale-generation" };
      }

      const { actions, semanticToken } = await controllerContext.requestCodeActions(file, diag.range, [diag], ["quickfix"]);
      const candidates = parseProviderImportCandidates(actions);
      if (candidates.length === 0) continue;

      const plan = planAutoImport({
        symbolName: candidates[0].symbolName,
        candidates,
        documentText: file.text,
        settings,
        isPaste: false,
        projectFactsStatus: currentFacts.status,
        generation: currentFacts.generation,
        expectedGeneration,
      });

      lastOutcome = plan;

      if (plan.outcome === "auto-apply") {
        // Re-verify project facts generation immediately before applying (A3)
        const liveFacts = useProjectFactsStore.getState().getWorkspaceFacts(controllerContext.projectFactsRoot);
        if (liveFacts.status !== "ready" || liveFacts.generation !== expectedGeneration) {
          return { outcome: "none", reason: "stale-generation" };
        }

        const actionToRun = actions.find((a) =>
          a.title.includes(plan.candidate.fullyQualifiedName) ||
          a.title.includes(plan.candidate.symbolName),
        ) ?? actions[0];

        await controllerContext.runCodeAction(actionToRun, file, semanticToken);
        controllerContext.setStatusMessage(`Auto-imported ${plan.candidate.fullyQualifiedName}`);
        return plan;
      }

      if (plan.outcome === "ambiguous") {
        controllerContext.setAutoImportCandidatePrompt({
          candidates: plan.candidates,
          onSelect: (chosen) => {
            controllerContext.setAutoImportCandidatePrompt(null);
            const liveFacts = useProjectFactsStore.getState().getWorkspaceFacts(controllerContext.projectFactsRoot);
            if (liveFacts.status !== "ready" || liveFacts.generation !== expectedGeneration) {
              controllerContext.setStatusMessage("Auto-import cancelled: project facts changed");
              return;
            }
            const matchedAction = actions.find((a) =>
              a.title.includes(chosen.fullyQualifiedName) ||
              a.title.includes(chosen.symbolName),
            ) ?? actions[0];
            void controllerContext.runCodeAction(matchedAction, file, semanticToken);
            controllerContext.setStatusMessage(`Imported ${chosen.fullyQualifiedName}`);
          },
          onClose: () => controllerContext.setAutoImportCandidatePrompt(null),
        });
        return plan;
      }
    }

    return lastOutcome;
  };
}



export interface ExecutePasteWithAutoImportContext {
  activeFile: import("../editorGroupTypes").OpenFileViewModel | null;
  clipboardHandle: import("../workspaceClipboardSession").WorkspaceClipboardHandle;
  executeActiveEditorCommand: (commandId: EditorCommandId, options?: EditorCommandOptions) => boolean;
  lspFilesRef: import("react").RefObject<Record<string, LspFileState>>;
  projectFactsRoot: string;
  updateFileText: (key: string, text: string) => void;
  setStatusMessage: (message: string) => void;
  setAutoImportCandidatePrompt: import("react").Dispatch<import("react").SetStateAction<{ candidates: readonly AutoImportCandidate[]; onSelect: (candidate: AutoImportCandidate) => void; onClose: () => void; } | null>>;
}


export function createExecutePasteWithAutoImport(controllerContext: ExecutePasteWithAutoImportContext) {
  return async (
    textToPaste?: string,
    candidatesOverride?: readonly AutoImportCandidate[],
  ) => {
    const file = controllerContext.activeFile;
    if (!file || Boolean((file as { library?: boolean }).library)) return false;

    let text = textToPaste;
    if (text === undefined) {
      try {
        text = await readText();
      } catch {
        const session = controllerContext.clipboardHandle.historyEntries()[0];
        text = session?.plainText ?? "";
      }
    }

    if (!text) {
      controllerContext.executeActiveEditorCommand("paste");
      return false;
    }

    const isJava = file.languagePath.endsWith(".java") || controllerContext.lspFilesRef.current[file.key]?.status?.languageId === "java";
    const settings = loadAutoImportPreferences();

    // ED-IMPORT-001-A2: paste mode "none" means plain paste without imports
    if (!isJava || settings.pasteImportMode === "none") {
      controllerContext.executeActiveEditorCommand("paste");
      return true;
    }

    // Check project facts status and generation (A3)
    const facts = useProjectFactsStore.getState().getWorkspaceFacts(controllerContext.projectFactsRoot);
    if (facts.status !== "ready") {
      controllerContext.executeActiveEditorCommand("paste");
      return true;
    }
    const expectedGeneration = facts.generation;

    const tokens = scanPastedTypeTokens(text);
    if (tokens.length === 0) {
      controllerContext.executeActiveEditorCommand("paste");
      return true;
    }

    const candidates: readonly AutoImportCandidate[] = candidatesOverride ?? [];

    const plan = planPasteAutoImports({
      pastedText: text,
      documentText: file.text,
      candidates,
      settings,
      projectFactsStatus: facts.status,
      generation: facts.generation,
      expectedGeneration,
    });

    if (plan.outcome === "auto-apply") {
      const liveFacts = useProjectFactsStore.getState().getWorkspaceFacts(controllerContext.projectFactsRoot);
      if (liveFacts.status !== "ready" || liveFacts.generation !== expectedGeneration) {
        controllerContext.executeActiveEditorCommand("paste");
        return true;
      }

      const dispatched = controllerContext.executeActiveEditorCommand("pasteWithAutoImports", {
        pastePayload: {
          text,
          importStatements: plan.importStatements,
        },
      });

      if (!dispatched) {
        const insertionOffset = computeImportInsertionOffset(file.text);
        const { newDocumentText } = buildPasteWithImportsChanges({
          documentText: file.text,
          pasteOffset: file.text.length,
          pastedText: text,
          importStatements: plan.importStatements,
          insertionOffset,
        });
        controllerContext.updateFileText(file.key, newDocumentText);
      }
      controllerContext.setStatusMessage(`Pasted and auto-imported ${plan.appliedCandidates.map((c) => c.fullyQualifiedName).join(", ")}`);
      return true;
    }

    if (plan.outcome === "ambiguous" && plan.requiresPrompt) {
      controllerContext.setAutoImportCandidatePrompt({
        candidates: plan.ambiguousCandidates,
        onSelect: (chosen) => {
          controllerContext.setAutoImportCandidatePrompt(null);
          const liveFacts = useProjectFactsStore.getState().getWorkspaceFacts(controllerContext.projectFactsRoot);
          if (liveFacts.status !== "ready" || liveFacts.generation !== expectedGeneration) {
            controllerContext.executeActiveEditorCommand("paste");
            return;
          }
          const importStatements = [`import ${chosen.fullyQualifiedName};\n`];
          const dispatched = controllerContext.executeActiveEditorCommand("pasteWithAutoImports", {
            pastePayload: {
              text,
              importStatements,
            },
          });
          if (!dispatched) {
            const insertionOffset = computeImportInsertionOffset(file.text);
            const { newDocumentText } = buildPasteWithImportsChanges({
              documentText: file.text,
              pasteOffset: file.text.length,
              pastedText: text,
              importStatements,
              insertionOffset,
            });
            controllerContext.updateFileText(file.key, newDocumentText);
          }
          controllerContext.setStatusMessage(`Pasted and imported ${chosen.fullyQualifiedName}`);
        },
        onClose: () => {
          controllerContext.setAutoImportCandidatePrompt(null);
          controllerContext.executeActiveEditorCommand("paste");
        },
      });
      return true;
    }

    controllerContext.executeActiveEditorCommand("paste");
    return true;
  };
}



export interface RunRearrangeExecuteContext {
  workspaceInstanceId: string;
  rearrangeRequestTokenRef: import("react").RefObject<number>;
  absolutePathForOpenFile: (file: OpenFileState) => string | null;
  lspDescriptorForFile: (file: OpenFileState) => LspDocumentDescriptor | null;
  setStatusMessage: (message: string) => void;
  lspFilesRef: import("react").RefObject<Record<string, LspFileState>>;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  workspaceInstanceIdRef: import("react").RefObject<string>;
  requestCodeActions: (file: OpenFileState, range: LspRange, diagnostics?: LspDiagnostic[], only?: string[], options?: { signal?: AbortSignal; allowCapabilityFallback?: boolean; }) => Promise<{ actions: LspCodeAction[]; providerActions: readonly ProviderActionV4[]; context: CodeActionContextIdentity | null; semanticToken: WorkspaceSemanticIndexBuildToken | null; requestFailure: { kind: "stale" | "sync-pending" | "descriptor-missing" | "failed" | "provider"; message: string; } | null; }>;
  lspDocumentVersion: (key: string) => number | null;
  workspaceResourceOperationLockedRef: import("react").RefObject<boolean>;
  lspSessionGeneration: () => number;
  applyLspWorkspaceEdit: (edit: LspWorkspaceEdit, options?: { preview?: boolean; label?: string | null; actionId?: string | null; kind?: RefactorKind; semanticGeneration?: number; semanticRevision?: number; semanticRequireReady?: boolean; recordHistory?: boolean; semanticWorkspaceOnly?: boolean; plan?: RefactorPlanV3 | WorkspaceEditRecoveryPlan; preflightMutation?: () => Promise<void> | void; assertOwnerAtMutationBoundary?: () => void; onTransactionSummary?: (summary: WorkspaceEditApplyTransactionSummary) => void; onActiveEditResolved?: (edit: LspWorkspaceEdit) => void; expectedDiskHashes?: ReadonlyMap<string, string> | null; expectedPreimages?: readonly ReplaceFilePreimage[] | null; }) => Promise<WorkspaceEditApplyOutcome[]>;
  activeCapabilities: import("../../../../lib/editor/lsp").LspCapabilitySummary | null;
  activeLspState: LspFileState | null;
}


export function createRunRearrangeExecute(controllerContext: RunRearrangeExecuteContext) {
  return async (file: OpenFileState): Promise<boolean> => {
    const frozenKey = file.key;
    const frozenInstanceId = controllerContext.workspaceInstanceId;
    // ED-IMPROVE-001: a new invocation (double entry) owns the workflow; the
    // older run's token no longer matches and it fails typed stale.
    ++controllerContext.rearrangeRequestTokenRef.current;
    // Absolute target: provider edit entries carry absolute disk paths or
    // URIs, while file.path is workspace-relative. Match with path-aware
    // equality so a well-formed provider edit is never filtered out, and a
    // foreign-path edit never leaks into this file.
    const targetPath = controllerContext.absolutePathForOpenFile(file) ?? file.path ?? file.key;
    const descriptor = controllerContext.lspDescriptorForFile(file);
    if (!descriptor) {
      const message = `Cannot resolve the language server for ${file.title ?? frozenKey}`;
      controllerContext.setStatusMessage(message);
      return false;
    }
    // ED-IMPROVE-003: prefer the language-server document URI the provider
    // will echo back in its payload; descriptor.filePath may be workspace-relative.
    const targetUri = descriptor.documentUri
      ?? controllerContext.lspFilesRef.current[frozenKey]?.status?.uri
      ?? descriptor.filePath
      ?? frozenKey;
    const result = await executeRearrangeTransaction(
      {
        requestActions: async () => {
          const live = controllerContext.openFilesRef.current[frozenKey];
          if (!live || controllerContext.workspaceInstanceIdRef.current !== frozenInstanceId) {
            return {
              state: "cancelled",
              actions: [],
              reason: "Rearrange cancelled: the file closed or the workspace changed; nothing applied",
            };
          }
          const lines = live.text.split("\n");
          const range: LspRange = {
            start: { line: 0, character: 0 },
            end: {
              line: Math.max(0, lines.length - 1),
              character: lines.length > 0 ? lines[lines.length - 1].length : 0,
            },
          };
          const res = await controllerContext.requestCodeActions(live, range, [], [...REARRANGE_ACTION_KINDS]);
          if (res.requestFailure) {
            return {
              state: res.requestFailure.kind === "stale" ? "stale" : "failed",
              actions: [],
              reason: res.requestFailure.message,
            };
          }
          return {
            state: "ok",
            actions: res.actions.map((action) => ({ kind: action.kind, title: action.title, raw: action.raw })),
          };
        },
        resolveAction: async (action) => {
          const live = controllerContext.openFilesRef.current[frozenKey];
          if (!live || controllerContext.workspaceInstanceIdRef.current !== frozenInstanceId) {
            return { state: "stale", edits: [], reason: "Rearrange cancelled: the file closed during resolve; nothing applied" };
          }
          try {
            const resolved = await lspCodeActionResolve(descriptor, action.raw);
            // ED-IMPROVE-003: validate the complete payload before it can
            // become a plan; cross-file/resource/command/disabled/malformed
            // payloads are rejected here with their category and reason.
            const validation = validateWorkflowProviderAction({
              action: resolved.action,
              targetUri,
              targetPath,
              documentText: live.text,
              documentRevision: live.documentRevision,
              documentVersion: controllerContext.lspDocumentVersion(live.key),
              isSupportedKind: isRearrangeActionKind,
              capabilityLabel: "Rearrange Code",
            });
            if (!validation.ok) {
              return { state: validation.state, edits: [], reason: validation.reason };
            }
            return {
              state: "resolved",
              edits: validation.edits,
              documentVersion: validation.documentVersion,
            };
          } catch (err) {
            return { state: "failed", edits: [], reason: `Rearrange resolve failed: ${errorMessage(err)}; nothing applied` };
          }
        },
        readLive: () => {
          const live = controllerContext.openFilesRef.current[frozenKey];
          if (!live || controllerContext.workspaceInstanceIdRef.current !== frozenInstanceId) return null;
          return {
            text: live.text,
            revision: live.documentRevision,
            readOnly: !!live.library || controllerContext.workspaceResourceOperationLockedRef.current,
            dirty: !!live.dirty,
          };
        },
        providerGeneration: () => controllerContext.lspSessionGeneration(),
        requestToken: () => controllerContext.rearrangeRequestTokenRef.current,
        confirmPreview: (summary) => confirmAppDialog({
          title: "Rearrange preview",
          message: `${summary.targetPath}: ${summary.operationCount} edits. Pre ${summary.preHashShort} → post ${summary.postHashShort}. Apply the rearrangement?`,
          confirmLabel: "Apply rearrange",
        }),
        applyEdit: async (edit, guard, applyContext) => {
          const summaryHolder: { current: WorkspaceEditApplyTransactionSummary | null } = { current: null };
          try {
            const outcomes = await controllerContext.applyLspWorkspaceEdit(edit, {
              recordHistory: true,
              label: "Rearrange Code",
              // ED-IMPROVE-002: the canonical apply boundary prepares the
              // crash-recovery journal before the first mutation, verifies the
              // frozen post-hash independently, and registers the single
              // success history entry only after that verification.
              plan: {
                actionId: `rearrange:${frozenKey}`,
                kind: "other",
                documents: [{
                  uri: applyContext.targetUri,
                  canonicalPath: applyContext.targetPath,
                  expectedDocumentRevision: null,
                  expectedDiskHash: null,
                  owner: "workspace",
                  preTextSha256: sha256Hex(applyContext.preText),
                  expectedPostHash: applyContext.expectedPostHash,
                }],
              },
              preflightMutation: () => guard.assertCurrent(),
              onTransactionSummary: (next) => {
                summaryHolder.current = next;
              },
            });
            const response = workspaceEditApplyResponse(outcomes);
            const summary = summaryHolder.current;
            if (summary && summary.effect === "unknown") {
              return {
                state: "unknown-effect",
                reason: `Rearrange write result is unknown: ${summary.reason ?? response.failureReason ?? "the OS acknowledgement was lost"}`
                  + `; verify ${targetPath} in the recovery center before retrying`,
                recoveryId: summary.recoveryId,
                affectedPaths: summary.affectedPaths,
              };
            }
            if (summary && (summary.postcondition === "mismatch" || summary.postcondition === "unreadable")) {
              return {
                state: "recovery-required",
                reason: `Rearrange postcondition could not be verified after applying`
                  + ` (${summary.postcondition}: ${summary.reason ?? "unknown cause"});`
                  + ` recovery ${summary.recoveryId ?? "entry"} lists the affected files`,
                recoveryId: summary.recoveryId,
                affectedPaths: summary.affectedPaths,
              };
            }
            if (!response.applied) {
              return {
                state: "failed",
                reason: response.failureReason ?? "Rearrange apply failed; see the workspace-edit ledger",
                recoveryId: summary?.recoveryId ?? null,
                affectedPaths: summary?.affectedPaths ?? [],
              };
            }
            const live = controllerContext.openFilesRef.current[frozenKey];
            if (!live || controllerContext.workspaceInstanceIdRef.current !== frozenInstanceId) {
              return { state: "conflict", reason: `${targetPath} closed during apply; verify the disk state before retrying` };
            }
            return { state: "applied", postText: live.text, historyId: summary?.historyId ?? null };
          } catch (err) {
            return { state: "failed", reason: `Rearrange apply failed: ${errorMessage(err)}` };
          }
        },
      },
      {
        scope: "file",
        targetPath,
        targetUri,
        readOnly: !!file.library || controllerContext.workspaceResourceOperationLockedRef.current,
        hasSelection: false,
        capabilities: resolveRearrangeCapabilities(controllerContext.activeCapabilities, controllerContext.activeLspState?.status),
      },
    );
    if (result.ok) {
      controllerContext.setStatusMessage(
        `Rearranged ${file.title ?? targetPath} (${result.operationCount} edits in one transaction); undo restores the preimage`,
      );
      return true;
    }
    controllerContext.setStatusMessage(result.reason);
    return false;
  };
}



export interface RunCleanupExecuteContext {
  workspaceInstanceId: string;
  cleanupRequestTokenRef: import("react").RefObject<number>;
  absolutePathForOpenFile: (file: OpenFileState) => string | null;
  lspDescriptorForFile: (file: OpenFileState) => LspDocumentDescriptor | null;
  setStatusMessage: (message: string) => void;
  lspFilesRef: import("react").RefObject<Record<string, LspFileState>>;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  workspaceInstanceIdRef: import("react").RefObject<string>;
  requestCodeActions: (file: OpenFileState, range: LspRange, diagnostics?: LspDiagnostic[], only?: string[], options?: { signal?: AbortSignal; allowCapabilityFallback?: boolean; }) => Promise<{ actions: LspCodeAction[]; providerActions: readonly ProviderActionV4[]; context: CodeActionContextIdentity | null; semanticToken: WorkspaceSemanticIndexBuildToken | null; requestFailure: { kind: "stale" | "sync-pending" | "descriptor-missing" | "failed" | "provider"; message: string; } | null; }>;
  lspDocumentVersion: (key: string) => number | null;
  workspaceResourceOperationLockedRef: import("react").RefObject<boolean>;
  lspSessionGeneration: () => number;
  applyLspWorkspaceEdit: (edit: LspWorkspaceEdit, options?: { preview?: boolean; label?: string | null; actionId?: string | null; kind?: RefactorKind; semanticGeneration?: number; semanticRevision?: number; semanticRequireReady?: boolean; recordHistory?: boolean; semanticWorkspaceOnly?: boolean; plan?: RefactorPlanV3 | WorkspaceEditRecoveryPlan; preflightMutation?: () => Promise<void> | void; assertOwnerAtMutationBoundary?: () => void; onTransactionSummary?: (summary: WorkspaceEditApplyTransactionSummary) => void; onActiveEditResolved?: (edit: LspWorkspaceEdit) => void; expectedDiskHashes?: ReadonlyMap<string, string> | null; expectedPreimages?: readonly ReplaceFilePreimage[] | null; }) => Promise<WorkspaceEditApplyOutcome[]>;
  activeCapabilities: import("../../../../lib/editor/lsp").LspCapabilitySummary | null;
  activeLspState: LspFileState | null;
}


export function createRunCleanupExecute(controllerContext: RunCleanupExecuteContext) {
  return async (file: OpenFileState): Promise<boolean> => {
    const frozenKey = file.key;
    const frozenInstanceId = controllerContext.workspaceInstanceId;
    // ED-IMPROVE-001: same request-token supersession as the rearrange owner.
    ++controllerContext.cleanupRequestTokenRef.current;
    const targetPath = controllerContext.absolutePathForOpenFile(file) ?? file.path ?? file.key;
    const descriptor = controllerContext.lspDescriptorForFile(file);
    if (!descriptor) {
      const message = `Cannot resolve the language server for ${file.title ?? frozenKey}`;
      controllerContext.setStatusMessage(message);
      return false;
    }
    // ED-IMPROVE-003: same URI precedence as the rearrange owner.
    const targetUri = descriptor.documentUri
      ?? controllerContext.lspFilesRef.current[frozenKey]?.status?.uri
      ?? descriptor.filePath
      ?? frozenKey;
    const result = await executeCleanupTransaction(
      {
        requestActions: async () => {
          const live = controllerContext.openFilesRef.current[frozenKey];
          if (!live || controllerContext.workspaceInstanceIdRef.current !== frozenInstanceId) {
            return {
              state: "cancelled",
              actions: [],
              reason: "Cleanup cancelled: the file closed or the workspace changed; nothing applied",
            };
          }
          const lines = live.text.split("\n");
          const range: LspRange = {
            start: { line: 0, character: 0 },
            end: {
              line: Math.max(0, lines.length - 1),
              character: lines.length > 0 ? lines[lines.length - 1].length : 0,
            },
          };
          const res = await controllerContext.requestCodeActions(live, range, [], [...CLEANUP_ACTION_KINDS]);
          if (res.requestFailure) {
            return {
              state: res.requestFailure.kind === "stale" ? "stale" : "failed",
              actions: [],
              reason: res.requestFailure.message,
            };
          }
          return {
            state: "ok",
            actions: res.actions.map((action) => ({ kind: action.kind, title: action.title, raw: action.raw })),
          };
        },
        resolveAction: async (action) => {
          const live = controllerContext.openFilesRef.current[frozenKey];
          if (!live || controllerContext.workspaceInstanceIdRef.current !== frozenInstanceId) {
            return { state: "stale", edits: [], reason: "Cleanup cancelled: the file closed during resolve; nothing applied" };
          }
          try {
            const resolved = await lspCodeActionResolve(descriptor, action.raw);
            // ED-IMPROVE-003: same complete-payload validation as Rearrange;
            // generic fixAll/format payloads never pass as Cleanup.
            const validation = validateWorkflowProviderAction({
              action: resolved.action,
              targetUri,
              targetPath,
              documentText: live.text,
              documentRevision: live.documentRevision,
              documentVersion: controllerContext.lspDocumentVersion(live.key),
              isSupportedKind: isCleanupActionKind,
              capabilityLabel: "Code Cleanup",
            });
            if (!validation.ok) {
              return { state: validation.state, edits: [], reason: validation.reason };
            }
            return {
              state: "resolved",
              edits: validation.edits,
              documentVersion: validation.documentVersion,
            };
          } catch (err) {
            return { state: "failed", edits: [], reason: `Cleanup resolve failed: ${errorMessage(err)}; nothing applied` };
          }
        },
        readLive: () => {
          const live = controllerContext.openFilesRef.current[frozenKey];
          if (!live || controllerContext.workspaceInstanceIdRef.current !== frozenInstanceId) return null;
          return {
            text: live.text,
            revision: live.documentRevision,
            readOnly: !!live.library || controllerContext.workspaceResourceOperationLockedRef.current,
            dirty: !!live.dirty,
          };
        },
        providerGeneration: () => controllerContext.lspSessionGeneration(),
        requestToken: () => controllerContext.cleanupRequestTokenRef.current,
        confirmPreview: (summary) => confirmAppDialog({
          title: "Code cleanup preview",
          message: `${summary.targetPath} [${summary.profileId}]: ${summary.operationCount} edits. Pre ${summary.preHashShort} → post ${summary.postHashShort}. Apply the cleanup?`,
          confirmLabel: "Apply cleanup",
        }),
        applyEdit: async (edit, guard, applyContext) => {
          const summaryHolder: { current: WorkspaceEditApplyTransactionSummary | null } = { current: null };
          try {
            const outcomes = await controllerContext.applyLspWorkspaceEdit(edit, {
              recordHistory: true,
              label: "Code Cleanup",
              // ED-IMPROVE-002: same canonical journal/postcondition/history
              // contract as the rearrange owner.
              plan: {
                actionId: `cleanup:${frozenKey}`,
                kind: "other",
                documents: [{
                  uri: applyContext.targetUri,
                  canonicalPath: applyContext.targetPath,
                  expectedDocumentRevision: null,
                  expectedDiskHash: null,
                  owner: "workspace",
                  preTextSha256: sha256Hex(applyContext.preText),
                  expectedPostHash: applyContext.expectedPostHash,
                }],
              },
              preflightMutation: () => guard.assertCurrent(),
              onTransactionSummary: (next) => {
                summaryHolder.current = next;
              },
            });
            const response = workspaceEditApplyResponse(outcomes);
            const summary = summaryHolder.current;
            if (summary && summary.effect === "unknown") {
              return {
                state: "unknown-effect",
                reason: `Cleanup write result is unknown: ${summary.reason ?? response.failureReason ?? "the OS acknowledgement was lost"}`
                  + `; verify ${targetPath} in the recovery center before retrying`,
                recoveryId: summary.recoveryId,
                affectedPaths: summary.affectedPaths,
              };
            }
            if (summary && (summary.postcondition === "mismatch" || summary.postcondition === "unreadable")) {
              return {
                state: "recovery-required",
                reason: `Cleanup postcondition could not be verified after applying`
                  + ` (${summary.postcondition}: ${summary.reason ?? "unknown cause"});`
                  + ` recovery ${summary.recoveryId ?? "entry"} lists the affected files`,
                recoveryId: summary.recoveryId,
                affectedPaths: summary.affectedPaths,
              };
            }
            if (!response.applied) {
              return {
                state: "failed",
                reason: response.failureReason ?? "Cleanup apply failed; see the workspace-edit ledger",
                recoveryId: summary?.recoveryId ?? null,
                affectedPaths: summary?.affectedPaths ?? [],
              };
            }
            const live = controllerContext.openFilesRef.current[frozenKey];
            if (!live || controllerContext.workspaceInstanceIdRef.current !== frozenInstanceId) {
              return { state: "conflict", reason: `${targetPath} closed during apply; verify the disk state before retrying` };
            }
            return { state: "applied", postText: live.text, historyId: summary?.historyId ?? null };
          } catch (err) {
            return { state: "failed", reason: `Cleanup apply failed: ${errorMessage(err)}` };
          }
        },
      },
      {
        scope: "file",
        targetPath,
        targetUri,
        readOnly: !!file.library || controllerContext.workspaceResourceOperationLockedRef.current,
        capabilities: resolveCleanupCapabilities(controllerContext.activeCapabilities, controllerContext.activeLspState?.status),
      },
    );
    if (result.ok) {
      controllerContext.setStatusMessage(
        `Cleaned up ${file.title ?? targetPath} (${result.operationCount} edits in one transaction); undo restores the preimage`,
      );
      return true;
    }
    controllerContext.setStatusMessage(result.reason);
    return false;
  };
}
