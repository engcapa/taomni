import { lspCodeActions, lspCodeActionResolve, lspExecuteCommand, type LspCodeAction, type LspDiagnostic, type LspDocumentDescriptor, type LspDocumentStatus, type LspDocumentSymbol, type LspRange, type LspWorkspaceEdit } from "../../../../lib/editor/lsp";
import { confirmAppDialog } from "../../../../lib/appDialogs";
import { type WorkspaceEditApplyOutcome, type WorkspaceEditApplyTransactionSummary } from "../workspaceEditApply";
import { workspaceEditOperations } from "../workspaceEditPreview";
import { buildRefactorPlan, refactorApplyGate, type RefactorKind, type RefactorPlanV3, type WorkspaceEditRecoveryPlan } from "../refactorPlan";
import { WorkspaceEditHistory } from "../workspaceEditHistory";
import { buildCapabilityEvidence } from "../capabilityEvidence";
import { INTENTION_RESOLVE_TIMEOUT_MS, candidateFromProviderAction, IntentionSession } from "../intentionSession";
import { CanonicalCodeActionService, snapshotCodeActionContext, type CodeActionContextIdentity, type CodeActionProviderClient, type CodeActionTransactionSnapshot, type ProviderActionV4 } from "../codeActionProviderAdapter";
import type { MenuItem } from "../../../ContextMenu";
import { type ReplaceFilePreimage } from "../replaceInFilesModel";
import type { CodeWorkspaceRootInfo } from "../../../../types";
import { type LspFileState, type OpenFileState, errorMessage } from "../codeWorkspaceModel";
import { workspaceSemanticIndexTokenRevisionCurrent, type WorkspaceSemanticIndexBuildToken } from "../workspaceSemanticIndex";
import { isExtractMethodKind, type ExtractReceipt } from "../extractMethodFlow";
import { type ExtractSessionState } from "./model";



export interface RequestCodeActionsContext {
  lspFilesRef: import("react").RefObject<Record<string, LspFileState>>;
  semanticIndex: import("../useWorkspaceSemanticIndex").WorkspaceSemanticIndexController;
  ensureWorkspaceSemanticDocumentsSynced: (requiredFileKey: string, expectedRevision: number) => Promise<OpenFileState | null>;
  setStatusMessage: (message: string) => void;
  lspDescriptorForFile: (file: OpenFileState) => LspDocumentDescriptor | null;
  lspSessionGeneration: () => number;
  projectAnalysisSnapshot: import("../projectAnalysisModel").JavaProjectAnalysisSnapshotV1 | null;
  updateLspStatusForFile: (file: OpenFileState, status: LspDocumentStatus) => void;
  canonicalCodeActionServiceRef: import("react").RefObject<CanonicalCodeActionService | null>;
}


export function createRequestCodeActions(controllerContext: RequestCodeActionsContext) {
  return async (
    file: OpenFileState,
    range: LspRange,
    diagnostics: LspDiagnostic[] = [],
    only: string[] = [],
    options: { signal?: AbortSignal; allowCapabilityFallback?: boolean } = {},
  ): Promise<{
    actions: LspCodeAction[];
    providerActions: readonly ProviderActionV4[];
    context: CodeActionContextIdentity | null;
    semanticToken: WorkspaceSemanticIndexBuildToken | null;
    /**
     * Why the candidates are unusable; null when the request completed
     * normally. `message` is the accurate user-facing outcome and has already
     * been surfaced on the status line by the time the caller sees it.
     */
    requestFailure: {
      kind: "stale" | "sync-pending" | "descriptor-missing" | "failed" | "provider";
      message: string;
    } | null;
  }> => {
    const caps = controllerContext.lspFilesRef.current[file.key]?.status?.capabilities;
    if (caps && !caps.codeAction && !options.allowCapabilityFallback) {
      return { actions: [], providerActions: [], context: null, semanticToken: null, requestFailure: null };
    }
    const semanticQuery = only.some((kind) => kind === "refactor" || kind.startsWith("refactor."));
    const expectedRevision = controllerContext.semanticIndex.current().revision;
    const live = await controllerContext.ensureWorkspaceSemanticDocumentsSynced(file.key, expectedRevision);
    if (!live) {
      const message = `${semanticQuery ? "Refactor" : "Code actions"} require the language server to finish synchronizing current editor buffers`;
      controllerContext.setStatusMessage(message);
      return { actions: [], providerActions: [], context: null, semanticToken: null, requestFailure: { kind: "sync-pending", message } };
    }
    const descriptor = controllerContext.lspDescriptorForFile(live);
    if (!descriptor) {
      const message = `Cannot resolve the language server for ${semanticQuery ? "refactor" : "code"} actions`;
      controllerContext.setStatusMessage(message);
      return { actions: [], providerActions: [], context: null, semanticToken: null, requestFailure: { kind: "descriptor-missing", message } };
    }
    const buildToken = controllerContext.semanticIndex.beginBuild("language-server");
    try {
      const context = snapshotCodeActionContext({
        document: {
          uri: descriptor.documentUri ?? controllerContext.lspFilesRef.current[live.key]?.status?.uri ?? descriptor.filePath ?? live.key,
          revision: live.documentRevision,
          languageId: controllerContext.lspFilesRef.current[live.key]?.status?.languageId ?? descriptor.languageId ?? "plaintext",
        },
        provider: {
          id: descriptor.languageId === "java" || !descriptor.languageId ? "jdtls" : descriptor.languageId,
          version: null,
          generation: controllerContext.lspSessionGeneration(),
          projectFingerprint: controllerContext.projectAnalysisSnapshot?.projectFingerprint ?? "",
          trusted: true,
        },
        range,
        diagnostics,
        only: only.length > 0 ? only : undefined,
      });

      const client: CodeActionProviderClient = {
        requestCodeActions: async (params) => {
          const result = await lspCodeActions(
            descriptor,
            params.range,
            params.context.diagnostics.map((item) => ({
              range: item.range,
              severity: item.severity,
              code: item.code,
              source: item.source,
              message: item.message,
              tags: item.tags,
              relatedInformation: item.relatedInformation,
              codeDescription: item.codeDescription ? { href: item.codeDescription } : undefined,
              data: item.data,
            })),
            params.context.only ? [...params.context.only] : undefined,
          );
          controllerContext.updateLspStatusForFile(live, result.status);
          return result.actions;
        },
      };

      const serviceRes = await controllerContext.canonicalCodeActionServiceRef.current!.requestCandidates(
        context,
        client,
        { signal: options.signal },
      );
      const providerActions = serviceRes.state === "ready" ? serviceRes.actions : [];
      const rawActions = providerActions.map((providerAction) => providerAction.action);

      const completion = controllerContext.semanticIndex.finishQuery(buildToken, {
        kind: semanticQuery ? "refactor" : "code-action",
        resultCount: rawActions.length,
      });
      if (!completion.accepted) {
        // The workspace revision moved while the provider was producing these
        // candidates. The response is unusable; say so instead of falling
        // through to the generic "no actions" message.
        const message = `${semanticQuery ? "Refactor actions" : "Code actions"} became stale because the workspace changed while requesting them; request them again`;
        controllerContext.setStatusMessage(message);
        return { actions: [], providerActions: [], context: null, semanticToken: null, requestFailure: { kind: "stale", message } };
      }
      // The provider envelope classifies non-ready outcomes (failed / timeout
      // / malformed / unsupported / cancelled). Surface its message instead of
      // collapsing the request into a generic "no actions" claim; a null
      // response ("empty") genuinely means the server offered nothing.
      if (serviceRes.state !== "ready" && serviceRes.state !== "empty") {
        const message = serviceRes.state === "malformed" || serviceRes.state === "failed"
          ? serviceRes.message
          : serviceRes.state === "unsupported"
            ? serviceRes.reason
            : serviceRes.state === "timeout"
              ? "Code action request timed out before the provider answered; try again"
              : serviceRes.state === "cancelled" && serviceRes.detail?.includes("document changed")
                ? "Refactor actions were cancelled because the document changed; try again"
                : "Code action request was cancelled";
        controllerContext.setStatusMessage(message);
        return { actions: [], providerActions: [], context: null, semanticToken: null, requestFailure: { kind: "provider", message } };
      }
      return { actions: rawActions, providerActions, context, semanticToken: buildToken, requestFailure: null };
    } catch (error) {
      const detail = errorMessage(error);
      controllerContext.semanticIndex.failBuild(buildToken, detail);
      const message = `Code actions request failed: ${detail}`;
      controllerContext.setStatusMessage(message);
      return { actions: [], providerActions: [], context: null, semanticToken: null, requestFailure: { kind: "failed", message } };
    }
  };
}



export interface RunCodeActionContext {
  semanticIndex: import("../useWorkspaceSemanticIndex").WorkspaceSemanticIndexController;
  lspDescriptorForFile: (file: OpenFileState) => LspDocumentDescriptor | null;
  setStatusMessage: (message: string) => void;
  intentionSessionRef: import("react").RefObject<IntentionSession | null>;
  lspFilesRef: import("react").RefObject<Record<string, LspFileState>>;
  lspSessionGeneration: () => number;
  projectAnalysisSnapshot: import("../projectAnalysisModel").JavaProjectAnalysisSnapshotV1 | null;
  updateLspStatusForFile: (file: OpenFileState, status: LspDocumentStatus) => void;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  canonicalCodeActionServiceRef: import("react").RefObject<CanonicalCodeActionService | null>;
  rootsRef: import("react").RefObject<CodeWorkspaceRootInfo[]>;
  captureCodeActionTransactionSnapshot: (edit: LspWorkspaceEdit) => Promise<CodeActionTransactionSnapshot | null>;
  restoreCodeActionTransactionSnapshot: (snapshot: CodeActionTransactionSnapshot) => Promise<void>;
  applyLspWorkspaceEdit: (edit: LspWorkspaceEdit, options?: { preview?: boolean; label?: string | null; actionId?: string | null; kind?: RefactorKind; semanticGeneration?: number; semanticRevision?: number; semanticRequireReady?: boolean; recordHistory?: boolean; semanticWorkspaceOnly?: boolean; plan?: RefactorPlanV3 | WorkspaceEditRecoveryPlan; preflightMutation?: () => Promise<void> | void; assertOwnerAtMutationBoundary?: () => void; onTransactionSummary?: (summary: WorkspaceEditApplyTransactionSummary) => void; onActiveEditResolved?: (edit: LspWorkspaceEdit) => void; expectedDiskHashes?: ReadonlyMap<string, string> | null; expectedPreimages?: readonly ReplaceFilePreimage[] | null; }) => Promise<WorkspaceEditApplyOutcome[]>;
  extractSessionRef: import("react").RefObject<ExtractSessionState | null>;
  providerCommandSemanticGuardRef: import("react").RefObject<{ generation: number; revision: number; requireReady: boolean; } | null>;
  providerCommandQueueRef: import("react").RefObject<Promise<void>>;
  workspaceEditHistory: WorkspaceEditHistory;
  setWorkspaceEditHistoryRevision: import("react").Dispatch<import("react").SetStateAction<number>>;
  markProviderSuppressionApplied: (action: LspCodeAction, file: OpenFileState) => void;
}


export function createRunCodeAction(controllerContext: RunCodeActionContext) {
  return async (
    action: LspCodeAction,
    file: OpenFileState,
    semanticToken: WorkspaceSemanticIndexBuildToken | null = null,
    intentionCandidateId?: string,
    intentionContext?: CodeActionContextIdentity,
    /**
     * ED-PARITY-007 DEC-07: when the caller owns an Extract Method session, the
     * applied result carries a frozen B1 receipt keyed by that session so the
     * naming phase can never be rebound to a later revision.
     */
    receiptSessionId?: string,
  ): Promise<{
    ok: boolean;
    message: string | null;
    retryable: boolean;
    appliedReceipt?: ExtractReceipt;
  }> => {
    try {
      const assertSemanticCurrent = () => {
        // Revision-pinned freshness: background provider progress does not
        // stale an already-produced candidate list (see
        // workspaceSemanticIndexTokenRevisionCurrent).
        if (
          semanticToken
          && !workspaceSemanticIndexTokenRevisionCurrent(controllerContext.semanticIndex.current(), semanticToken)
        ) {
          throw new Error("Refactor result became stale because the workspace changed; request it again");
        }
      };
      assertSemanticCurrent();
      const descriptor = controllerContext.lspDescriptorForFile(file);
      if (!descriptor) {
        const message = "Cannot resolve the language server for this code action";
        controllerContext.setStatusMessage(message);
        return { ok: false, message, retryable: false };
      }

      const session = controllerContext.intentionSessionRef.current;
      const sessionCandidate = intentionCandidateId
        ? session?.getCandidate(intentionCandidateId) ?? null
        : null;
      if (intentionCandidateId && (!sessionCandidate || !intentionContext)) {
        const message = "Code action session became stale; request the candidates again";
        controllerContext.setStatusMessage(message);
        return { ok: false, message, retryable: false };
      }

      const context = intentionContext ?? snapshotCodeActionContext({
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
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        diagnostics: [],
      });
      const candidate = sessionCandidate ?? candidateFromProviderAction(action, null);
      const client: CodeActionProviderClient = {
        requestCodeActions: async () => [action],
        resolveCodeAction: async (candidateAction) => {
          if (!candidateAction.raw) return null;
          const result = await lspCodeActionResolve(descriptor, candidateAction.raw);
          controllerContext.updateLspStatusForFile(file, result.status);
          return result.action;
        },
      };

      if (intentionCandidateId) session?.markResolving(intentionCandidateId);
      const resolvingSnapshot = intentionCandidateId ? session?.getState() ?? null : null;
      const liveFile = controllerContext.openFilesRef.current[file.key];
      const resolveOutcome = await controllerContext.canonicalCodeActionServiceRef.current!.resolvePlan(
        { ...candidate, rawAction: action },
        context,
        client,
        liveFile?.documentRevision ?? -1,
        controllerContext.lspSessionGeneration(),
        { timeoutMs: INTENTION_RESOLVE_TIMEOUT_MS },
      );
      if (
        intentionCandidateId
        && controllerContext.intentionSessionRef.current?.getState() !== resolvingSnapshot
      ) {
        return {
          ok: false,
          message: "Code action session was superseded by a newer request",
          retryable: false,
        };
      }
      if (resolveOutcome.state === "stale") {
        if (intentionCandidateId) session?.markStale(intentionCandidateId, resolveOutcome.reason);
        const message = `Code action became stale: ${resolveOutcome.reason}`;
        controllerContext.setStatusMessage(message);
        return { ok: false, message, retryable: false };
      }
      if (resolveOutcome.state === "rejected") {
        const message = `Code action rejected: ${resolveOutcome.reason}`;
        if (intentionCandidateId) session?.markFailed(intentionCandidateId, message);
        controllerContext.setStatusMessage(message);
        return { ok: false, message, retryable: false };
      }
      if (resolveOutcome.state === "unresolved") {
        const message = `Code action resolve failed: ${resolveOutcome.reason} — you can retry`;
        if (intentionCandidateId) session?.markFailed(intentionCandidateId, resolveOutcome.reason);
        controllerContext.setStatusMessage(message);
        return { ok: false, message, retryable: resolveOutcome.retryable };
      }
      if (intentionCandidateId) session?.markResolved(intentionCandidateId);
      assertSemanticCurrent();
      const executablePlan = resolveOutcome.plan;
      let refactorPlan: RefactorPlanV3 | undefined;
      const isRefactorAction = executablePlan.kind.startsWith("refactor")
        || executablePlan.title.toLowerCase().includes("refactor");
      if (executablePlan.edit && isRefactorAction) {
        const refactorKind = executablePlan.kind.includes("extract")
          ? "extract"
          : executablePlan.kind.includes("inline")
            ? "inline"
            : executablePlan.kind.includes("change-signature")
              ? "change-signature"
              : executablePlan.kind.includes("move")
                ? "move"
                : "other";
        const evidence = buildCapabilityEvidence({
          capabilityId: `refactor.action:${executablePlan.kind || "custom"}`,
          languageId: descriptor.languageId ?? "java",
          provider: {
            id: descriptor.languageId ?? "jdtls",
            version: null,
            generation: semanticToken?.generation ?? controllerContext.lspSessionGeneration(),
          },
          projectFingerprint: controllerContext.projectAnalysisSnapshot?.projectFingerprint ?? "",
          uri: context.document.uri,
          revision: file.documentRevision ?? 0,
          scope: "project",
          complete: false,
          reason: "provider code action edit",
        });
        // DEC-07: a method extraction is one semantic edit — the declaration
        // and the call site can never be excluded independently. Every text
        // operation is therefore a required group, so the shared preview's
        // Select None, per-file toggle and checkbox all leave it intact.
        const isMethodExtraction = isExtractMethodKind(executablePlan.kind)
          || isExtractMethodKind(action.kind);
        refactorPlan = buildRefactorPlan({
          actionId: intentionCandidateId ?? executablePlan.actionId,
          kind: refactorKind,
          evidence,
          edit: executablePlan.edit,
          roots: controllerContext.rootsRef.current,
          requiredOperationIndexes: isMethodExtraction
            ? workspaceEditOperations(executablePlan.edit).map((_, index) => index)
            : undefined,
          completeness: {
            value: "partial",
            source: "protocol-bounded",
            proof: "provider code action edit",
          },
        });
        const gate = refactorApplyGate(refactorPlan);
        if (!gate.allowed) {
          const message = `Refactoring blocked: ${gate.reason}`;
          controllerContext.setStatusMessage(message);
          return { ok: false, message, retryable: false };
        }
        if (gate.requiresConfirm) {
          const confirmed = await confirmAppDialog({
            title: "Refactoring Warning",
            message: gate.reason ?? "This refactoring produced warnings. Proceed?",
            confirmLabel: "Proceed",
          });
          if (!confirmed) {
            controllerContext.setStatusMessage("Refactoring cancelled");
            return { ok: false, message: "Refactoring cancelled", retryable: false };
          }
        }
      }

      let semanticEditApplied = false;
      let semanticCommandRevision: number | null = null;
      const result = await controllerContext.canonicalCodeActionServiceRef.current!.applyPlan(executablePlan, {
        getLiveDocumentText: (uri) => (
          uri === context.document.uri ? controllerContext.openFilesRef.current[file.key]?.text ?? null : null
        ),
        getLiveDocumentRevision: (uri) => (
          uri === context.document.uri ? controllerContext.openFilesRef.current[file.key]?.documentRevision ?? null : null
        ),
        verifyIdentity: () => {
          const currentFile = controllerContext.openFilesRef.current[file.key];
          if (!currentFile) {
            return { valid: false, status: "stale", reason: "The target document was closed" };
          }
          if (currentFile.documentRevision !== context.document.revision) {
            return {
              valid: false,
              status: "stale",
              reason: `Document revision changed from ${context.document.revision} to ${currentFile.documentRevision}`,
            };
          }
          const currentDescriptor = controllerContext.lspDescriptorForFile(currentFile);
          const currentUri = currentDescriptor?.documentUri
            ?? controllerContext.lspFilesRef.current[currentFile.key]?.status?.uri
            ?? currentDescriptor?.filePath
            ?? currentFile.key;
          if (currentUri !== context.document.uri) {
            return { valid: false, status: "stale", reason: "The language-server document identity changed" };
          }
          const currentProviderGeneration = controllerContext.lspSessionGeneration();
          if (currentProviderGeneration !== context.provider.generation) {
            return {
              valid: false,
              status: "stale",
              reason: `Provider generation changed from ${context.provider.generation} to ${currentProviderGeneration}`,
            };
          }
          if ((controllerContext.projectAnalysisSnapshot?.projectFingerprint ?? "") !== context.provider.projectFingerprint) {
            return { valid: false, status: "stale", reason: "Project analysis changed" };
          }
          if (
            semanticToken
            && !workspaceSemanticIndexTokenRevisionCurrent(controllerContext.semanticIndex.current(), semanticToken)
          ) {
            return { valid: false, status: "stale", reason: "The workspace changed after the actions were requested" };
          }
          return { valid: true };
        },
        captureSnapshot: controllerContext.captureCodeActionTransactionSnapshot,
        restoreSnapshot: controllerContext.restoreCodeActionTransactionSnapshot,
        applyWorkspaceEdit: async (edit, transactionOptions) => {
          let appliedEdit = edit;
          const outcomes = await controllerContext.applyLspWorkspaceEdit(edit, {
            preview: true,
            label: executablePlan.title,
            semanticGeneration: semanticToken?.generation,
            semanticRevision: semanticToken?.revision,
            // Revision-pinned freshness (ED-AUDIT-008): the candidates were
            // produced against this revision, so background provider progress
            // (jdtls workDoneProgress) must not abort the apply. Cross-revision
            // edits are still rejected by the revision equality check.
            semanticRequireReady: false,
            plan: refactorPlan,
            recordHistory: false,
            // A superseded Extract Method session must never commit: the newer
            // chord owns the transaction, so the older flow is refused at the
            // last possible moment instead of writing a second extraction.
            preflightMutation: async () => {
              await transactionOptions?.onBeforeCommit?.();
              if (receiptSessionId && controllerContext.extractSessionRef.current?.id !== receiptSessionId) {
                throw new Error(
                  "EXTRACT_OWNER_STALE: this extraction was superseded by a newer request",
                );
              }
            },
            assertOwnerAtMutationBoundary: () => {
              if (receiptSessionId && controllerContext.extractSessionRef.current?.id !== receiptSessionId) {
                throw new Error(
                  "EXTRACT_OWNER_STALE: this extraction was superseded by a newer request",
                );
              }
            },
            onActiveEditResolved: (nextEdit) => {
              appliedEdit = nextEdit;
            },
          });
          semanticEditApplied = !outcomes.some((outcome) => (
            outcome.status === "failed" || outcome.status === "skipped"
          ));
          if (semanticToken && semanticEditApplied) {
            semanticCommandRevision = controllerContext.semanticIndex.current().revision;
          }
          return { outcomes, appliedEdit };
        },
        executeCommand: async (command, argumentsValue) => {
          const descriptor = controllerContext.lspDescriptorForFile(file);
          if (!descriptor) throw new Error("Cannot resolve the language server for this code action");
          const execute = async () => {
            if (semanticToken) {
              const current = controllerContext.semanticIndex.current();
              if (semanticEditApplied) {
                if (semanticCommandRevision == null || current.revision !== semanticCommandRevision) {
                  throw new Error("Refactor command continuation became stale because the workspace changed");
                }
              } else {
                assertSemanticCurrent();
              }
              controllerContext.providerCommandSemanticGuardRef.current = {
                generation: current.generation,
                revision: semanticEditApplied ? semanticCommandRevision! : semanticToken.revision,
                requireReady: !semanticEditApplied,
              };
            }
            try {
              return await lspExecuteCommand(descriptor, command, argumentsValue);
            } finally {
              if (semanticToken) {
                controllerContext.providerCommandSemanticGuardRef.current = null;
                controllerContext.semanticIndex.invalidate("provider-command");
              }
            }
          };
          if (!semanticToken) return execute();
          const pending = controllerContext.providerCommandQueueRef.current.then(execute);
          controllerContext.providerCommandQueueRef.current = pending.then(() => undefined, () => undefined);
          return pending;
        },
        registerHistoryEntry: (entry) => {
          controllerContext.workspaceEditHistory.push({
            id: entry.id,
            label: entry.label,
            affectedPaths: entry.affectedUris,
            undo: entry.undo,
            redo: entry.redo,
          });
          controllerContext.setWorkspaceEditHistoryRevision((revision) => revision + 1);
        },
        registerRecoveryEntry: (entry) => {
          controllerContext.workspaceEditHistory.push({
            id: entry.id,
            label: `Recover ${entry.label}`,
            affectedPaths: entry.affectedUris,
            undo: entry.recover,
            redo: entry.recover,
          });
          controllerContext.setWorkspaceEditHistoryRevision((revision) => revision + 1);
        },
      });
      if (result.status === "applied") {
        if (!executablePlan.edit && !executablePlan.command) {
          const message = "Code action had no edit or command to apply";
          controllerContext.setStatusMessage(message);
          return { ok: false, message, retryable: false };
        }
        // DEC-07: freeze B1 at the canonical commit/history boundary. The live
        // buffer is read synchronously here so a later `symbols-after` await
        // can never mistake newer user text for the extraction result.
        const committed = controllerContext.openFilesRef.current[file.key];
        const appliedReceipt: ExtractReceipt | undefined = receiptSessionId && committed
          ? {
              sessionId: receiptSessionId,
              fileKey: file.key,
              uri: context.document.uri,
              postRevision: committed.documentRevision,
              postText: committed.text,
              historyId: result.historyId,
            }
          : undefined;
        controllerContext.markProviderSuppressionApplied(action, file);
        controllerContext.setStatusMessage(result.historyId
          ? `Applied code action: ${executablePlan.title}; undo transaction ${result.historyId}`
          : `Executed code action: ${executablePlan.title}`);
        return { ok: true, message: null, retryable: false, appliedReceipt };
      }
      if (result.status === "cancelled") {
        const message = `Code action cancelled: ${result.reason}`;
        controllerContext.setStatusMessage(message);
        return { ok: false, message, retryable: true };
      }
      if ("reason" in result) {
        const message = `Code action ${result.status}: ${result.reason}`;
        controllerContext.setStatusMessage(message);
        return { ok: false, message, retryable: true };
      }
      const recovery = result.recoveryId
        ? result.recoveryState === "registered"
          ? `; recovery ${result.recoveryId} is available through Undo Workspace Edit`
          : `; recovery ${result.recoveryId} ${result.recoveryState}`
        : "";
      const message = `Code action failed: ${result.error}${recovery}`;
      controllerContext.setStatusMessage(message);
      return { ok: false, message, retryable: result.recoveryState !== "unavailable" };
    } catch (error) {
      const message = errorMessage(error);
      controllerContext.setStatusMessage(message);
      return { ok: false, message, retryable: false };
    }
  };
}



export interface ShowCodeActionsMenuContext {
  intentionRequestAbortRef: import("react").RefObject<AbortController | null>;
  requestCodeActions: (file: OpenFileState, range: LspRange, diagnostics?: LspDiagnostic[], only?: string[], options?: { signal?: AbortSignal; allowCapabilityFallback?: boolean; }) => Promise<{ actions: LspCodeAction[]; providerActions: readonly ProviderActionV4[]; context: CodeActionContextIdentity | null; semanticToken: WorkspaceSemanticIndexBuildToken | null; requestFailure: { kind: "stale" | "sync-pending" | "descriptor-missing" | "failed" | "provider"; message: string; } | null; }>;
  showCodeInsightNotice: (message: string, action?: "configure" | null) => void;
  setStatusMessage: (message: string) => void;
  intentionSessionRef: import("react").RefObject<IntentionSession | null>;
  beginExtractSessionRef: import("react").RefObject<((input: { file: OpenFileState; range: LspRange; uri: string; beforeSymbols: LspDocumentSymbol[] | null; }) => ExtractSessionState | null) | null>;
  captureMethodSymbolsRef: import("react").RefObject<((file: OpenFileState) => Promise<LspDocumentSymbol[] | null>) | null>;
  runCodeAction: (action: LspCodeAction, file: OpenFileState, semanticToken?: WorkspaceSemanticIndexBuildToken | null, intentionCandidateId?: string, intentionContext?: CodeActionContextIdentity, receiptSessionId?: string) => Promise<{ ok: boolean; message: string | null; retryable: boolean; appliedReceipt?: ExtractReceipt; }>;
  continueExtractNamingRef: import("react").RefObject<((receipt: ExtractReceipt) => Promise<void>) | null>;
  finishExtractSessionRef: import("react").RefObject<((session: ExtractSessionState) => void) | null>;
  openTreeContextMenuAt: (x: number, y: number, items: MenuItem[], menuOptions?: import("../../../ContextMenu").ContextMenuAppearance) => void;
}


export function createShowCodeActionsMenu(controllerContext: ShowCodeActionsMenuContext) {
  return async (
    clientX: number,
    clientY: number,
    file: OpenFileState,
    range: LspRange,
    diagnostics: LspDiagnostic[] = [],
    only: string[] = [],
    sectionLabel = "code actions",
    /**
     * ED-PARITY-007 DEC-02: an explicit popup anchor (selection start) for the
     * frozen candidate menu; the pane +80/+80 origin stays the fallback.
     */
    anchor?: { clientX: number; clientY: number },
    /**
     * ED-PARITY-007 DEC-02: an already-frozen candidate list (the caller
     * filtered it) rendered without a second provider request. The Extract
     * Method multi-candidate path uses it so method-only filtering cannot be
     * widened back to variable/constant/field proposals.
     */
    prefetched?: {
      providerActions: readonly ProviderActionV4[];
      context: CodeActionContextIdentity;
      semanticToken: WorkspaceSemanticIndexBuildToken | null;
    },
  ) => {
    let providerActions: readonly ProviderActionV4[];
    let actionContext: CodeActionContextIdentity;
    let menuSemanticToken: WorkspaceSemanticIndexBuildToken | null;
    let filtered: ProviderActionV4[];
    if (prefetched) {
      providerActions = prefetched.providerActions;
      actionContext = prefetched.context;
      menuSemanticToken = prefetched.semanticToken;
      filtered = [...providerActions];
    } else {
      const requestAbort = new AbortController();
      controllerContext.intentionRequestAbortRef.current?.abort();
      controllerContext.intentionRequestAbortRef.current = requestAbort;
      const requested = await controllerContext.requestCodeActions(
        file,
        range,
        diagnostics,
        only,
        { signal: requestAbort.signal },
      );
      if (requestAbort.signal.aborted || controllerContext.intentionRequestAbortRef.current !== requestAbort) return;

      // Request-window staleness is decided by finishQuery acceptance inside
      // requestCodeActions: the response is revision-pinned, and background
      // provider progress (jdtls workDoneProgress) must not stale a produced
      // result. Every requestFailure classification already surfaced its
      // accurate status message there.
      if (requested.requestFailure) {
        controllerContext.showCodeInsightNotice(requested.requestFailure.message);
        return;
      }
      if (!requested.context) {
        controllerContext.setStatusMessage(`No ${sectionLabel} provided by the language server`);
        controllerContext.showCodeInsightNotice(`No ${sectionLabel} provided by the language server`);
        return;
      }
      providerActions = requested.providerActions;
      actionContext = requested.context;
      menuSemanticToken = requested.semanticToken;
      filtered = only.length === 0
        ? [...providerActions]
        : providerActions.filter((providerAction) => only.some((kind) => (
          providerAction.action.kind === kind || providerAction.action.kind?.startsWith(`${kind}.`)
        )));
    }
    if (!filtered.length) {
      controllerContext.setStatusMessage(`No ${sectionLabel} provided by the language server`);
      controllerContext.showCodeInsightNotice(`No ${sectionLabel} provided by the language server`);
      return;
    }
    const sorted = [...filtered].sort((a, b) => {
      const aQuick = a.action.kind?.includes("quickfix") ? 0 : 1;
      const bQuick = b.action.kind?.includes("quickfix") ? 0 : 1;
      if (aQuick !== bQuick) return aQuick - bQuick;
      if (a.action.isPreferred !== b.action.isPreferred) return a.action.isPreferred ? -1 : 1;
      return a.action.title.localeCompare(b.action.title);
    });
    // §8.20.4 W3: freeze the candidate list into the shared Intention session
    // with per-candidate evidence; the menu renders the frozen snapshot so all
    // entry points see identical ids, resolve states and disabled reasons.
    const intentionSnapshot = controllerContext.intentionSessionRef.current!.open(
      sorted.map((providerAction) => candidateFromProviderAction(
        providerAction.action,
        providerAction.evidence,
        providerAction.disabledReason,
      )),
      {
        fileKey: file.key,
        uri: actionContext.document.uri,
        documentRevision: actionContext.document.revision,
        providerGeneration: actionContext.provider.generation,
        projectFingerprint: actionContext.provider.projectFingerprint,
      },
    );
    // Grouped rendering: provider candidates first, then local editor actions
    // (none registered in this funnel yet — the group renders only when present).
    // Candidates were built 1:1 over `sorted`, so index maps back to the action.
    const actionByCandidateId = new Map<string, LspCodeAction>();
    sorted.forEach((providerAction, index) => {
      const candidate = intentionSnapshot.candidates[index];
      if (candidate) actionByCandidateId.set(candidate.id, providerAction.action);
    });
    const openedAt = intentionSnapshot.context.openedAt;
    const openFrozenMenu = () => {
      const current = controllerContext.intentionSessionRef.current?.getState();
      if (!current || current.context.openedAt !== openedAt) return;
      const menuItems: MenuItem[] = [];
      for (const group of current.groups) {
        menuItems.push({ label: group.label, disabled: true });
        for (const candidate of group.candidates) {
          const action = actionByCandidateId.get(candidate.id);
          if (!action) continue;
          const resolveState = current.resolveStates[candidate.id] ?? { status: "idle" as const };
          const retryLabel = resolveState.status === "failed"
            ? `Retry ${candidate.title} (${resolveState.message})`
            : candidate.title;
          menuItems.push({
            testId: `code-workspace-intention-${candidate.id}`,
            label: candidate.disabledReason
              ? `${candidate.title} (${candidate.disabledReason})`
              : retryLabel,
            disabled: candidate.disabledReason !== null
              || resolveState.status === "resolving"
              || resolveState.status === "stale",
            onClick: () => {
              // DEC-02: a generic entry (Refactor This / Alt+Enter / lightbulb /
              // Problems quick fix) that selects a method extraction joins the
              // same transaction, including the post-extraction naming step.
              void (async () => {
                const extractOwner = isExtractMethodKind(action.kind)
                  ? controllerContext.beginExtractSessionRef.current?.({
                      file,
                      range,
                      uri: actionContext.document.uri,
                      beforeSymbols: await controllerContext.captureMethodSymbolsRef.current?.(file) ?? null,
                    }) ?? null
                  : null;
                // The owner is past the request window: only the canonical
                // revision/generation guards decide whether the apply is stale.
                if (extractOwner) extractOwner.phase = "resolve";
                const outcome = await controllerContext.runCodeAction(
                  action,
                  file,
                  menuSemanticToken,
                  candidate.id,
                  actionContext,
                  extractOwner?.id,
                );
                if (outcome.retryable) openFrozenMenu();
                if (outcome.appliedReceipt) {
                  if (extractOwner) extractOwner.receipt = outcome.appliedReceipt;
                  void controllerContext.continueExtractNamingRef.current?.(outcome.appliedReceipt);
                } else if (extractOwner) {
                  controllerContext.finishExtractSessionRef.current?.(extractOwner);
                }
              })();
            },
          });
        }
        if (group.source === "provider-code-action" && current.groups.length > 1) {
          menuItems.push({ label: "", separator: true });
        }
      }
      controllerContext.openTreeContextMenuAt(
        anchor?.clientX ?? clientX,
        anchor?.clientY ?? clientY,
        menuItems,
        { appearance: "code-candidates" },
      );
    };
    openFrozenMenu();
  };
}
