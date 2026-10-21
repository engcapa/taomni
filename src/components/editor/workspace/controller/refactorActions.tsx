import { lspDefinition, lspPrepareRename, lspReferences, lspRename, type LspCodeAction, type LspDiagnostic, type LspDocumentDescriptor, type LspDocumentStatus, type LspDocumentSymbol, type LspPosition, type LspRange, type LspRenameResult, type LspWorkspaceEdit } from "../../../../lib/editor/lsp";
import { type BottomDockTabId } from "../../../../stores/codeWorkspaceStore";
import { confirmAppDialog, promptAppDialog } from "../../../../lib/appDialogs";
import { type EditorSelectionRange } from "../CodeMirrorHost";
import { type WorkspaceEditApplyOutcome, type WorkspaceEditApplyTransactionSummary } from "../workspaceEditApply";
import { workspaceEditOperations } from "../workspaceEditPreview";
import { buildRefactorPlan, refactorApplyGate, evaluateDestructiveRefactorAvailability, type RefactorKind, type RefactorPlanV3, type WorkspaceEditRecoveryPlan } from "../refactorPlan";
import { buildSafeDeleteWorkspaceEdit, safeDeleteFileCount } from "../safeDelete";
import { buildCapabilityEvidence } from "../capabilityEvidence";
import { candidateFromProviderAction, IntentionSession } from "../intentionSession";
import { type CodeActionContextIdentity, type ProviderActionV4 } from "../codeActionProviderAdapter";
import { type ReferencesResultState } from "../panels/ReferencesPanel";
import { type ReplaceFilePreimage } from "../replaceInFilesModel";
import type { CodeWorkspaceRootInfo } from "../../../../types";
import { type LspFileState, type OpenFileState, errorMessage } from "../codeWorkspaceModel";
import { workspaceSemanticIndexBuildIsCurrent, workspaceSemanticIndexTokenRevisionCurrent, type WorkspaceSemanticIndexBuildToken } from "../workspaceSemanticIndex";
import { EXTRACT_NAMING_UNAVAILABLE_MESSAGE, extractDirtyBufferMessage, extractMethodBoundaryMessage, extractOwnerMatches, extractReceiptMatches, findExtractedMethodSymbol, isExtractMethodKind, type ExtractOwnerSnapshot, type ExtractReceipt, type ExtractSession } from "../extractMethodFlow";
import { type RenameSymbolAtResult, type ExtractSessionState } from "./model";



export interface RenameSymbolAtContext {
  lspFilesRef: import("react").RefObject<Record<string, LspFileState>>;
  setStatusMessage: (message: string) => void;
  semanticIndex: import("../useWorkspaceSemanticIndex").WorkspaceSemanticIndexController;
  ensureWorkspaceSemanticDocumentsSynced: (requiredFileKey: string, expectedRevision: number) => Promise<OpenFileState | null>;
  lspDescriptorForFile: (file: OpenFileState) => LspDocumentDescriptor | null;
  updateLspStatusForFile: (file: OpenFileState, status: LspDocumentStatus) => void;
  promptSymbolName: (input: { file: OpenFileState; kind: "rename" | "extract"; range: LspRange | null; defaultName: string; initialValue?: string; error?: string | null; dialog: (initialValue: string) => Promise<string | null>; }) => Promise<string | null>;
  describeSemanticInvalidation: (snapshot: ReturnType<() => import("../workspaceSemanticIndex").WorkspaceSemanticIndexSnapshot>, tokenRevision: number) => string;
  lspSessionGeneration: () => number;
  projectAnalysisSnapshot: import("../projectAnalysisModel").JavaProjectAnalysisSnapshotV1 | null;
  rootsRef: import("react").RefObject<CodeWorkspaceRootInfo[]>;
  buildPlanOpenFiles: () => Record<string, { documentRevision?: number; revision?: number; canonicalPath?: string; dirty?: boolean; library?: unknown; }>;
  applyLspWorkspaceEdit: (edit: LspWorkspaceEdit, options?: { preview?: boolean; label?: string | null; actionId?: string | null; kind?: RefactorKind; semanticGeneration?: number; semanticRevision?: number; semanticRequireReady?: boolean; recordHistory?: boolean; semanticWorkspaceOnly?: boolean; plan?: RefactorPlanV3 | WorkspaceEditRecoveryPlan; preflightMutation?: () => Promise<void> | void; assertOwnerAtMutationBoundary?: () => void; onTransactionSummary?: (summary: WorkspaceEditApplyTransactionSummary) => void; onActiveEditResolved?: (edit: LspWorkspaceEdit) => void; expectedDiskHashes?: ReadonlyMap<string, string> | null; expectedPreimages?: readonly ReplaceFilePreimage[] | null; }) => Promise<WorkspaceEditApplyOutcome[]>;
}


export function createRenameSymbolAt(controllerContext: RenameSymbolAtContext) {
  return async (
    file: OpenFileState,
    position: LspPosition,
    options: {
      title?: string;
      label?: string;
      confirmLabel?: string;
      /** Caller-owned prompt (Extract Method naming); defaults to the Rename dialog. */
      promptName?: (defaultName: string, range: LspRange | null) => Promise<string | null>;
      /** Re-checked after every await; false aborts without writing. */
      isCurrent?: () => boolean;
    } = {},
  ): Promise<RenameSymbolAtResult> => {
    const isCurrent = () => (options.isCurrent ? options.isCurrent() : true);
    const staleResult = (): RenameSymbolAtResult => ({
      status: "stale",
      message: "Rename was cancelled because the workspace changed",
    });
    if (!isCurrent()) return staleResult();
    const caps = controllerContext.lspFilesRef.current[file.key]?.status?.capabilities;
    if (caps && !caps.rename) {
      const message = "Rename is not supported by this language server";
      controllerContext.setStatusMessage(message);
      return { status: "failed", message };
    }
    const expectedRevision = controllerContext.semanticIndex.current().revision;
    const live = await controllerContext.ensureWorkspaceSemanticDocumentsSynced(file.key, expectedRevision);
    if (!isCurrent()) return staleResult();
    if (!live) {
      const message = "Rename requires the language server to finish synchronizing current editor buffers";
      controllerContext.setStatusMessage(message);
      return { status: "failed", message };
    }
    const descriptor = controllerContext.lspDescriptorForFile(live);
    if (!descriptor) {
      return { status: "failed", message: "Cannot resolve the language server for this rename" };
    }
    const buildToken = controllerContext.semanticIndex.beginBuild("language-server");
    try {
      const prepared = await lspPrepareRename(descriptor, position);
      controllerContext.updateLspStatusForFile(live, prepared.status);
      if (!isCurrent()) {
        controllerContext.semanticIndex.abandonBuild(buildToken);
        return staleResult();
      }
      if (!prepared.allowed && prepared.range == null && !prepared.placeholder) {
        controllerContext.semanticIndex.abandonBuild(buildToken);
        const message = prepared.message ?? "Cannot rename symbol here";
        controllerContext.setStatusMessage(message);
        return { status: "failed", message };
      }
      const defaultName = prepared.placeholder
        ?? (() => {
          const lines = live.text.split("\n");
          const line = lines[position.line] ?? "";
          if (prepared.range) {
            return line.slice(prepared.range.start.character, prepared.range.end.character);
          }
          return line.slice(position.character).match(/^[A-Za-z0-9_$]+/)?.[0] ?? "";
        })();
      const nameRange: LspRange | null = prepared.range ?? (() => {
        const line = live.text.split("\n")[position.line] ?? "";
        const before = line.slice(0, position.character).match(/[A-Za-z0-9_$]*$/)?.[0] ?? "";
        const after = line.slice(position.character).match(/^[A-Za-z0-9_$]*/)?.[0] ?? "";
        if (!before && !after) return null;
        return {
          start: { line: position.line, character: position.character - before.length },
          end: { line: position.line, character: position.character + after.length },
        };
      })();
      const nextName = options.promptName
        ? await options.promptName(defaultName, nameRange)
        : await controllerContext.promptSymbolName({
            file: live,
            kind: "rename",
            range: nameRange,
            defaultName,
            dialog: (initialValue) => promptAppDialog({
              title: options.title ?? "Rename Symbol",
              label: options.label ?? "New name",
              initialValue,
              confirmLabel: options.confirmLabel ?? "Rename",
            }),
          });
      if (!isCurrent()) {
        controllerContext.semanticIndex.abandonBuild(buildToken);
        return staleResult();
      }
      if (!nextName) {
        // The user dismissed the naming prompt (Escape/Cancel): keep the
        // provider default name and never treat this as a provider answer.
        controllerContext.semanticIndex.abandonBuild(buildToken);
        return { status: "cancelled" };
      }
      if (nextName === defaultName) {
        controllerContext.semanticIndex.abandonBuild(buildToken);
        return { status: "unchanged" };
      }
      const beforeRename = controllerContext.semanticIndex.current();
      // ED-AUDIT-008: revision equality is the freshness contract. Unrelated
      // provider work in flight (jdtls indexing/progress) is not a workspace
      // change and must not cancel a rename the user already confirmed.
      if (beforeRename.revision !== buildToken.revision) {
        controllerContext.semanticIndex.abandonBuild(buildToken);
        const message = "Rename was cancelled because the workspace changed while the dialog was open "
          + `(${controllerContext.describeSemanticInvalidation(beforeRename, buildToken.revision)})`;
        controllerContext.setStatusMessage(message);
        return { status: "stale", message };
      }
      let renamed: LspRenameResult;
      try {
        renamed = await lspRename(descriptor, position, nextName);
      } catch (err) {
        // The semantic provider rejected the name; nothing was written, so a
        // caller that owns its own prompt may keep the input and retry.
        const message = errorMessage(err);
        controllerContext.semanticIndex.failBuild(buildToken, message);
        controllerContext.setStatusMessage(message);
        return { status: "failed", message, retryable: true };
      }
      controllerContext.updateLspStatusForFile(live, renamed.status);
      if (!isCurrent()) return staleResult();
      let operationCount = workspaceEditOperations(renamed.edit).length;
      // JDT LS can answer the first rename request with an empty edit while
      // its cross-file index is finishing a watcher update.  The document
      // revision is still unchanged, so a short same-token retry is safe and
      // avoids exposing a transient "Rename produced no edits" result to the
      // user.  A real edit or a second empty response follows the normal
      // result path below.
      if (operationCount === 0 && isCurrent() && controllerContext.semanticIndex.current().revision === buildToken.revision) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (isCurrent() && controllerContext.semanticIndex.current().revision === buildToken.revision) {
          try {
            renamed = await lspRename(descriptor, position, nextName);
            controllerContext.updateLspStatusForFile(live, renamed.status);
            operationCount = workspaceEditOperations(renamed.edit).length;
          } catch (err) {
            const message = errorMessage(err);
            controllerContext.semanticIndex.failBuild(buildToken, message);
            controllerContext.setStatusMessage(message);
            return { status: "failed", message, retryable: true };
          }
        }
      }
      if (operationCount === 0) {
        controllerContext.semanticIndex.finishQuery(buildToken, { kind: "rename", resultCount: 0 });
        const message = "Rename produced no edits";
        controllerContext.setStatusMessage(message);
        // Only the provider answering with an empty edit is replayable; a user
        // cancel or an unchanged name must never resubmit a name.
        return { status: "empty-edit", message, retryable: true };
      }
      const completion = controllerContext.semanticIndex.finishQuery(buildToken, {
        kind: "rename",
        resultCount: operationCount,
      });
      if (
        !completion.accepted
        // Provider progress and an already-consumed invalidation can leave
        // staleReasons populated without changing the pinned workspace
        // revision. The rename response is still valid in that case; reject
        // only a real revision change after the provider answered.
        || !workspaceSemanticIndexTokenRevisionCurrent(completion.snapshot, buildToken)
      ) {
        const message = "Rename result became stale because the workspace changed; run Rename again "
          + `(${controllerContext.describeSemanticInvalidation(completion.snapshot, buildToken.revision)})`;
        controllerContext.setStatusMessage(message);
        return { status: "stale", message };
      }
      const documentUri = descriptor.documentUri ?? controllerContext.lspFilesRef.current[file.key]?.status?.uri ?? descriptor.filePath;
      const evidence = buildCapabilityEvidence({
        capabilityId: "refactor.rename",
        languageId: descriptor.languageId ?? "java",
        provider: {
          id: descriptor.languageId ?? "jdtls",
          version: null,
          generation: controllerContext.lspSessionGeneration(),
        },
        projectFingerprint: controllerContext.projectAnalysisSnapshot?.projectFingerprint ?? "",
        uri: documentUri,
        revision: live.documentRevision ?? 0,
        position,
        scope: "project",
        complete: false,
        reason: "provider rename response; AST completeness not guaranteed",
      });
      const plan = buildRefactorPlan({
        actionId: `rename:${documentUri}:${position.line}:${position.character}`,
        kind: "rename",
        evidence,
        edit: renamed.edit,
        roots: controllerContext.rootsRef.current,
        openFiles: controllerContext.buildPlanOpenFiles(),
        completeness: {
          value: "partial",
          source: "protocol-bounded",
          proof: "provider rename response; AST completeness not guaranteed",
        },
      });
      const gate = refactorApplyGate(plan);
      if (!gate.allowed) {
        controllerContext.semanticIndex.abandonBuild(buildToken);
        const message = `Rename blocked: ${gate.reason}`;
        controllerContext.setStatusMessage(message);
        return { status: "failed", message };
      }
      if (gate.requiresConfirm) {
        const confirmed = await confirmAppDialog({
          title: "Rename Warning",
          message: gate.reason ?? "The rename produced warnings. Proceed anyway?",
          confirmLabel: "Proceed",
        });
        if (!isCurrent()) {
          controllerContext.semanticIndex.abandonBuild(buildToken);
          return staleResult();
        }
        if (!confirmed) {
          controllerContext.semanticIndex.abandonBuild(buildToken);
          const message = "Rename cancelled";
          controllerContext.setStatusMessage(message);
          return { status: "cancelled", message };
        }
      }
      const guardRenameOwner = (stage: string) => {
        if (isCurrent()) return;
        throw new Error(
          `RENAME_OWNER_STALE: the rename owner changed before ${stage}`,
        );
      };
      const outcomes = await controllerContext.applyLspWorkspaceEdit(renamed.edit, {
        preview: true,
        label: `Rename symbol to "${nextName}"`,
        semanticGeneration: buildToken.generation,
        semanticRevision: buildToken.revision,
        // Background provider progress does not change the workspace revision.
        // Keep the same freshness rule at the final mutation boundary as at
        // the rename response gate above; owner and preimage checks still run.
        semanticRequireReady: false,
        semanticWorkspaceOnly: true,
        plan,
        // DEC-07: the Extract owner/receipt guard runs after the preview and
        // immediately before the first writer, and again at the exact mutation
        // boundary after any read, so a view/file switch during the async
        // snapshot or preview can never rename an abandoned document.
        preflightMutation: () => guardRenameOwner("the first write"),
        assertOwnerAtMutationBoundary: () => guardRenameOwner("the mutation boundary"),
      });
      const rejected = outcomes.find(
        (outcome) => outcome.status === "failed" || outcome.status === "skipped",
      );
      if (rejected) {
        const reason = "reason" in rejected && rejected.reason
          ? rejected.reason
          : "the workspace edit was rejected";
        if (reason.includes("RENAME_OWNER_STALE")) return staleResult();
        const message = `Rename failed: ${reason}`;
        controllerContext.setStatusMessage(message);
        return { status: "failed", message };
      }
      return { status: "applied" };
    } catch (err) {
      const message = errorMessage(err);
      controllerContext.semanticIndex.failBuild(buildToken, message);
      controllerContext.setStatusMessage(message);
      return { status: "failed", message };
    }
  };
}



export interface ContinueExtractNamingContext {
  extractSessionRef: import("react").RefObject<ExtractSessionState | null>;
  extractOwnerSnapshot: (session: ExtractSession) => ExtractOwnerSnapshot;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  ensureWorkspaceSemanticDocumentsSynced: (requiredFileKey: string, expectedRevision: number) => Promise<OpenFileState | null>;
  semanticIndex: import("../useWorkspaceSemanticIndex").WorkspaceSemanticIndexController;
  captureMethodSymbolsSettled: (file: OpenFileState) => Promise<LspDocumentSymbol[] | null>;
  setStatusMessage: (message: string) => void;
  renameSymbolAt: (file: OpenFileState, position: LspPosition, options?: { title?: string; label?: string; confirmLabel?: string; promptName?: (defaultName: string, range: LspRange | null) => Promise<string | null>; isCurrent?: () => boolean; }) => Promise<RenameSymbolAtResult>;
  promptSymbolName: (input: { file: OpenFileState; kind: "rename" | "extract"; range: LspRange | null; defaultName: string; initialValue?: string; error?: string | null; dialog: (initialValue: string) => Promise<string | null>; }) => Promise<string | null>;
  promptExtractName: (sessionId: string, options: { title: string; label: string; confirmLabel: string; initialValue: string; }) => Promise<string | null>;
  revealNavLocation: (key: string, position: { line: number; character: number; }) => void;
  finishExtractSession: (session: ExtractSessionState) => void;
}


export function createContinueExtractNaming(controllerContext: ContinueExtractNamingContext) {
  return async (receipt: ExtractReceipt) => {
    const session = controllerContext.extractSessionRef.current;
    if (!session || session.id !== receipt.sessionId) return;
    const ownerMatches = () => controllerContext.extractSessionRef.current === session
      && extractOwnerMatches(session, controllerContext.extractOwnerSnapshot(session));
    const receiptMatches = () => {
      const live = controllerContext.openFilesRef.current[session.fileKey];
      return live
        ? extractReceiptMatches(receipt, { revision: live.documentRevision, text: live.text })
        : false;
    };
    try {
      if (!ownerMatches() || !receiptMatches()) return;
      session.phase = "symbols-after";
      // DEC-03: the provider outline can trail the freshly committed extraction,
      // so a null diff is re-read once before the method is declared unlocatable.
      let found: LspDocumentSymbol | null = null;
      for (let read = 0; read < 2 && !found; read += 1) {
        if (read > 0) {
          await new Promise((resolve) => { window.setTimeout(resolve, 400); });
          if (!ownerMatches() || !receiptMatches()) return;
        }
        const live = controllerContext.openFilesRef.current[session.fileKey];
        // A dirty buffer was mutated without a save, so the provider model still
        // holds the pre-extraction document; push the current buffer before the
        // post snapshot or the new method cannot be found at all.
        const synced = live
          ? await controllerContext.ensureWorkspaceSemanticDocumentsSynced(live.key, controllerContext.semanticIndex.current().revision)
          : null;
        const afterSymbols = synced ? await controllerContext.captureMethodSymbolsSettled(synced) : null;
        // A late symbols reply for a superseded owner or a moved B1 must not
        // open a prompt or move focus.
        if (!ownerMatches() || !receiptMatches()) return;
        found = afterSymbols && session.beforeSymbols
          ? findExtractedMethodSymbol(session.beforeSymbols, afterSymbols)
          : null;
      }
      const postLive = controllerContext.openFilesRef.current[session.fileKey];
      if (!postLive) return;
      if (!found) {
        controllerContext.setStatusMessage(EXTRACT_NAMING_UNAVAILABLE_MESSAGE);
        return;
      }
      // DEC-03/DEC-08: a dirty buffer keeps the extraction in the buffer; the
      // Rename chain's dirty gate would refuse it, so no prompt is shown.
      if (postLive.dirty) {
        controllerContext.setStatusMessage(extractDirtyBufferMessage(found.name));
        return;
      }
      session.phase = "naming";
      // DEC-07: a provider rejection keeps the committed extraction, the real
      // error text and the user's input, so the name can be corrected and
      // retried without repeating the extraction.
      let proposed: string | null = null;
      let replayName: string | null = null;
      let replays = 0;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const attemptFile = controllerContext.openFilesRef.current[session.fileKey] ?? postLive;
        const replayed = replayName;
        replayName = null;
        const outcome = await controllerContext.renameSymbolAt(attemptFile, found.selectionRange.start, {
          title: "Extract Method",
          label: "Method name",
          confirmLabel: "Rename",
          isCurrent: () => ownerMatches() && receiptMatches(),
          promptName: async (defaultName, range) => {
            if (replayed) return replayed;
            // ED-PARITY-017: in-place naming on the extracted method; Escape
            // keeps the provider default name (the extraction stays committed).
            const value = await controllerContext.promptSymbolName({
              file: attemptFile,
              kind: "extract",
              range,
              defaultName,
              initialValue: proposed ?? defaultName,
              dialog: (initialValue) => controllerContext.promptExtractName(session.id, {
                title: "Extract Method",
                label: "Method name",
                confirmLabel: "Rename",
                initialValue,
              }),
            });
            if (value && value !== defaultName) proposed = value;
            return value;
          },
        });
        if (controllerContext.extractSessionRef.current !== session) return;
        if (outcome.status === "failed" && outcome.retryable && attempt < 4) continue;
        if (outcome.status === "failed") return; // real reason already surfaced; B1 kept
        // The owner/receipt was invalidated (possibly at the mutation boundary):
        // nothing was written and the naming step must not claim otherwise.
        if (outcome.status === "stale") return;
        if (outcome.status === "empty-edit" && proposed && replays < 3 && attempt < 4) {
          // The provider answered the rename with an empty edit (its workspace
          // model can still trail the freshly written extraction). Replay the
          // same name against a settled model instead of dropping the naming
          // step; the extraction and history stay untouched. Escape/Cancel and
          // an unchanged name return "cancelled"/"unchanged" instead, so a
          // dismissed prompt can never rename anything.
          replayName = proposed;
          replays += 1;
          await new Promise((resolve) => { window.setTimeout(resolve, 1200); });
          if (!ownerMatches() || !receiptMatches()) return;
          continue;
        }
        // DEC-03: focus returns to the editor at the call-statement line. The
        // rename committed a new revision for this same owner, so only the
        // owner identity is re-checked here — a switched/closed view stays
        // untouched.
        controllerContext.revealNavLocation(session.fileKey, session.selection.start);
        return;
      }
    } finally {
      controllerContext.finishExtractSession(session);
    }
  };
}



export interface RunExtractMethodContext {
  activeFile: import("../editorGroupTypes").OpenFileViewModel | null;
  extractSessionRef: import("react").RefObject<ExtractSessionState | null>;
  editorSelectionRef: import("react").RefObject<EditorSelectionRange>;
  beginExtractSession: (input: { file: OpenFileState; range: LspRange; uri: string; beforeSymbols: LspDocumentSymbol[] | null; }) => ExtractSessionState | null;
  extractLiveUri: (fileKey: string) => string;
  finishExtractSession: (session: ExtractSessionState) => void;
  ensureWorkspaceSemanticDocumentsSynced: (requiredFileKey: string, expectedRevision: number) => Promise<OpenFileState | null>;
  semanticIndex: import("../useWorkspaceSemanticIndex").WorkspaceSemanticIndexController;
  captureMethodSymbolsSettled: (file: OpenFileState) => Promise<LspDocumentSymbol[] | null>;
  intentionRequestAbortRef: import("react").RefObject<AbortController | null>;
  requestCodeActions: (file: OpenFileState, range: LspRange, diagnostics?: LspDiagnostic[], only?: string[], options?: { signal?: AbortSignal; allowCapabilityFallback?: boolean; }) => Promise<{ actions: LspCodeAction[]; providerActions: readonly ProviderActionV4[]; context: CodeActionContextIdentity | null; semanticToken: WorkspaceSemanticIndexBuildToken | null; requestFailure: { kind: "stale" | "sync-pending" | "descriptor-missing" | "failed" | "provider"; message: string; } | null; }>;
  editorPaneRef: import("react").RefObject<HTMLElement | null>;
  setStatusMessage: (message: string) => void;
  showCodeActionsMenu: (clientX: number, clientY: number, file: OpenFileState, range: LspRange, diagnostics?: LspDiagnostic[], only?: string[], sectionLabel?: string, anchor?: { clientX: number; clientY: number; }, prefetched?: { providerActions: readonly ProviderActionV4[]; context: CodeActionContextIdentity; semanticToken: WorkspaceSemanticIndexBuildToken | null; }) => Promise<void>;
  intentionSessionRef: import("react").RefObject<IntentionSession | null>;
  runCodeAction: (action: LspCodeAction, file: OpenFileState, semanticToken?: WorkspaceSemanticIndexBuildToken | null, intentionCandidateId?: string, intentionContext?: CodeActionContextIdentity, receiptSessionId?: string) => Promise<{ ok: boolean; message: string | null; retryable: boolean; appliedReceipt?: ExtractReceipt; }>;
  continueExtractNaming: (receipt: ExtractReceipt) => Promise<void>;
}


export function createRunExtractMethod(controllerContext: RunExtractMethodContext) {
  return async () => {
    const file = controllerContext.activeFile;
    if (!file || file.loading || file.library) return;
    // DEC-07 repeat protection: while one Extract Method owner is alive — from
    // its first request through naming and the rename — a repeated chord is a
    // no-op. Superseding a request that has already applied would commit a
    // second extraction and history entry (observed as a corrupted double
    // apply), so the first transaction keeps ownership until it finishes.
    const inFlight = controllerContext.extractSessionRef.current;
    if (inFlight && inFlight.phase !== "finished") return;
    const selection = controllerContext.editorSelectionRef.current;
    const range: LspRange = {
      start: selection.start,
      end: selection.empty ? selection.start : selection.end,
    };
    // Reserve the transaction owner synchronously, before any await: a repeated
    // chord that arrives while this run samples symbols or requests candidates
    // must see a live owner and become a no-op instead of starting a second
    // extraction that would commit twice.
    const session = controllerContext.beginExtractSession({
      file,
      range,
      uri: controllerContext.extractLiveUri(file.key),
      beforeSymbols: null,
    });
    if (!session) return;
    const abandon = () => {
      controllerContext.finishExtractSession(session);
    };
    // B0 symbols are sampled before any provider write so the post-extraction
    // snapshot can be diffed against the frozen pre-commit context. The buffer is
    // synchronized first: an undo or a previous transaction can leave the
    // provider outline trailing the live buffer, which would poison the diff.
    await controllerContext.ensureWorkspaceSemanticDocumentsSynced(file.key, controllerContext.semanticIndex.current().revision);
    if (controllerContext.extractSessionRef.current !== session) return;
    session.beforeSymbols = await controllerContext.captureMethodSymbolsSettled(file);
    if (controllerContext.extractSessionRef.current !== session) return;
    const requestAbort = new AbortController();
    controllerContext.intentionRequestAbortRef.current?.abort();
    controllerContext.intentionRequestAbortRef.current = requestAbort;
    const requested = await controllerContext.requestCodeActions(
      file,
      range,
      [],
      ["refactor.extract"],
      { signal: requestAbort.signal, allowCapabilityFallback: true },
    );
    if (requestAbort.signal.aborted || controllerContext.intentionRequestAbortRef.current !== requestAbort) {
      abandon();
      return;
    }
    // DEC-05: request failures already surfaced their accurate message.
    if (requested.requestFailure) {
      if (controllerContext.intentionRequestAbortRef.current === requestAbort) controllerContext.intentionRequestAbortRef.current = null;
      abandon();
      return;
    }
    if (requested.context?.document.uri !== session.uri) {
      // The document identity moved while the candidates were requested.
      abandon();
      return;
    }
    const methodCandidates = requested.providerActions.filter(
      (entry) => isExtractMethodKind(entry.action.kind),
    );
    const paneRect = controllerContext.editorPaneRef.current?.getBoundingClientRect();
    const rect = selection.rect;
    const anchor = rect
      ? { clientX: Math.round(rect.left), clientY: Math.round(rect.bottom) }
      : undefined;
    if (methodCandidates.length === 0) {
      // DEC-06: distinguish "nothing selected" from "this selection cannot be
      // extracted"; never claim the server offered no actions on failure.
      controllerContext.setStatusMessage(extractMethodBoundaryMessage(selection.empty));
      if (controllerContext.intentionRequestAbortRef.current === requestAbort) controllerContext.intentionRequestAbortRef.current = null;
      abandon();
      return;
    }
    if (methodCandidates.length > 1) {
      // DEC-02: render exactly the frozen method candidates. Re-requesting with
      // the parent "refactor.extract" prefix here would reintroduce
      // variable/constant/field/interface proposals into the Extract Method menu.
      await controllerContext.showCodeActionsMenu(
        anchor?.clientX ?? (paneRect?.left ?? 0) + 80,
        anchor?.clientY ?? (paneRect?.top ?? 0) + 80,
        file,
        range,
        [],
        ["refactor.extract"],
        "Extract Method",
        anchor,
        {
          providerActions: methodCandidates,
          context: requested.context!,
          semanticToken: requested.semanticToken,
        },
      );
      controllerContext.intentionRequestAbortRef.current = null;
      abandon();
      return;
    }
    const only = methodCandidates[0]!;
    if (only.disabledReason) {
      controllerContext.setStatusMessage(only.disabledReason);
      if (controllerContext.intentionRequestAbortRef.current === requestAbort) controllerContext.intentionRequestAbortRef.current = null;
      abandon();
      return;
    }
    const intentionSnapshot = controllerContext.intentionSessionRef.current?.open(
      [candidateFromProviderAction(only.action, only.evidence, only.disabledReason)],
      {
        fileKey: file.key,
        uri: requested.context!.document.uri,
        documentRevision: requested.context!.document.revision,
        providerGeneration: requested.context!.provider.generation,
        projectFingerprint: requested.context!.provider.projectFingerprint,
      },
    );
    const candidateId = intentionSnapshot?.candidates[0]?.id;
    if (!candidateId) {
      controllerContext.finishExtractSession(session);
      return;
    }
    session.phase = "resolve";
    const outcome = await controllerContext.runCodeAction(
      only.action,
      file,
      requested.semanticToken,
      candidateId,
      requested.context!,
      session.id,
    );
    if (!outcome.appliedReceipt) {
      controllerContext.finishExtractSession(session);
      return;
    }
    session.receipt = outcome.appliedReceipt;
    await controllerContext.continueExtractNaming(outcome.appliedReceipt);
  };
}



export interface SafeDeleteSymbolAtCursorContext {
  activeFile: import("../editorGroupTypes").OpenFileViewModel | null;
  setStatusMessage: (message: string) => void;
  semanticIndex: import("../useWorkspaceSemanticIndex").WorkspaceSemanticIndexController;
  ensureWorkspaceSemanticDocumentsSynced: (requiredFileKey: string, expectedRevision: number) => Promise<OpenFileState | null>;
  referencesRequestSequenceRef: import("react").RefObject<number>;
  lspDescriptorForFile: (file: OpenFileState) => LspDocumentDescriptor | null;
  editorSelectionRef: import("react").RefObject<EditorSelectionRange>;
  setBottomDockOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  setBottomDockTab: (tab: BottomDockTabId | ((prev: BottomDockTabId) => BottomDockTabId)) => void;
  setReferencesResult: import("react").Dispatch<import("react").SetStateAction<ReferencesResultState>>;
  updateLspStatusForFile: (file: OpenFileState, status: LspDocumentStatus) => void;
  absolutePathForOpenFile: (file: OpenFileState) => string | null;
  rootsRef: import("react").RefObject<CodeWorkspaceRootInfo[]>;
  lspFilesRef: import("react").RefObject<Record<string, LspFileState>>;
  lspSessionGeneration: () => number;
  projectAnalysisSnapshot: import("../projectAnalysisModel").JavaProjectAnalysisSnapshotV1 | null;
  buildPlanOpenFiles: () => Record<string, { documentRevision?: number; revision?: number; canonicalPath?: string; dirty?: boolean; library?: unknown; }>;
  applyLspWorkspaceEdit: (edit: LspWorkspaceEdit, options?: { preview?: boolean; label?: string | null; actionId?: string | null; kind?: RefactorKind; semanticGeneration?: number; semanticRevision?: number; semanticRequireReady?: boolean; recordHistory?: boolean; semanticWorkspaceOnly?: boolean; plan?: RefactorPlanV3 | WorkspaceEditRecoveryPlan; preflightMutation?: () => Promise<void> | void; assertOwnerAtMutationBoundary?: () => void; onTransactionSummary?: (summary: WorkspaceEditApplyTransactionSummary) => void; onActiveEditResolved?: (edit: LspWorkspaceEdit) => void; expectedDiskHashes?: ReadonlyMap<string, string> | null; expectedPreimages?: readonly ReplaceFilePreimage[] | null; }) => Promise<WorkspaceEditApplyOutcome[]>;
}


export function createSafeDeleteSymbolAtCursor(controllerContext: SafeDeleteSymbolAtCursorContext) {
  return async () => {
    const file = controllerContext.activeFile;
    if (!file || file.loading) return;
    if (file.library) {
      controllerContext.setStatusMessage(`${file.title} is a read-only library source`);
      return;
    }
    const availability = evaluateDestructiveRefactorAvailability(null);
    if (availability.state === "disabled") {
      controllerContext.setStatusMessage(availability.message);
      return;
    }
    const expectedRevision = controllerContext.semanticIndex.current().revision;
    const live = await controllerContext.ensureWorkspaceSemanticDocumentsSynced(file.key, expectedRevision);
    if (!live) {
      controllerContext.referencesRequestSequenceRef.current += 1;
      controllerContext.setStatusMessage("Safe Delete requires the language server to finish synchronizing current editor buffers");
      return;
    }
    const descriptor = controllerContext.lspDescriptorForFile(live);
    if (!descriptor) return;
    const position = controllerContext.editorSelectionRef.current.start;
    controllerContext.referencesRequestSequenceRef.current += 1;
    const referencesRequestId = controllerContext.referencesRequestSequenceRef.current;
    controllerContext.setBottomDockOpen(true);
    controllerContext.setBottomDockTab("references");
    controllerContext.setReferencesResult({
      loading: true,
      origin: `Safe Delete · ${live.subtitle}`,
      locations: [],
      error: null,
      semanticGeneration: null,
      semanticRevision: null,
    });
    const buildToken = controllerContext.semanticIndex.beginBuild("language-server");
    try {
      const prepared = await lspPrepareRename(descriptor, position);
      controllerContext.updateLspStatusForFile(live, prepared.status);
      if (!prepared.range) {
        controllerContext.semanticIndex.abandonBuild(buildToken);
        if (controllerContext.referencesRequestSequenceRef.current === referencesRequestId) {
          controllerContext.setReferencesResult({
            loading: false,
            origin: `Safe Delete · ${live.subtitle}`,
            locations: [],
            error: prepared.message ?? "Cannot determine a safe symbol range here",
            semanticGeneration: null,
            semanticRevision: null,
          });
        }
        controllerContext.setStatusMessage(prepared.message ?? "Cannot determine a safe symbol range here");
        return;
      }
      const [references, definition] = await Promise.all([
        lspReferences(descriptor, position, true),
        lspDefinition(descriptor, position).catch(() => null),
      ]);
      controllerContext.updateLspStatusForFile(live, references.status);
      if (definition) controllerContext.updateLspStatusForFile(live, definition.status);
      const completion = controllerContext.semanticIndex.finishQuery(buildToken, {
        kind: "safe-delete",
        resultCount: references.locations.length,
      });
      if (completion.accepted && controllerContext.referencesRequestSequenceRef.current === referencesRequestId) {
        controllerContext.setReferencesResult({
          loading: false,
          origin: `Safe Delete · ${live.subtitle}`,
          locations: references.locations,
          error: null,
          semanticGeneration: buildToken.generation,
          semanticRevision: buildToken.revision,
        });
      }
      if (
        !completion.accepted
        || !workspaceSemanticIndexBuildIsCurrent(completion.snapshot, buildToken)
      ) {
        if (controllerContext.referencesRequestSequenceRef.current === referencesRequestId) {
          controllerContext.setReferencesResult({
            loading: false,
            origin: `Safe Delete · ${live.subtitle}`,
            locations: [],
            error: "Safe Delete references became stale because the workspace changed",
            semanticGeneration: null,
            semanticRevision: null,
          });
        }
        controllerContext.setStatusMessage("Safe Delete references became stale because the workspace changed; run Safe Delete again");
        return;
      }

      const currentPath = controllerContext.absolutePathForOpenFile(live);
      if (!currentPath) {
        controllerContext.setStatusMessage("Safe Delete cannot resolve the active file path");
        return;
      }
      const declarationLocation = definition?.locations.find((location) => location.path) ?? null;
      const declaration = declarationLocation?.path
        ? {
          uri: declarationLocation.uri,
          path: declarationLocation.path,
          range: declarationLocation.range,
        }
        : {
          uri: "",
          path: currentPath,
          range: prepared.range,
        };
      const deletion = buildSafeDeleteWorkspaceEdit(declaration, references.locations, {
        workspaceRoots: controllerContext.rootsRef.current.map((root) => root.path),
      });
      if (!deletion.complete) {
        const reason = deletion.diagnostics.join("; ") || "Safe Delete references are incomplete";
        if (controllerContext.referencesRequestSequenceRef.current === referencesRequestId) {
          controllerContext.setReferencesResult((current) => ({
            ...current,
            loading: false,
            error: reason,
          }));
        }
        controllerContext.setStatusMessage(`Safe Delete blocked: ${reason}`);
        return;
      }
      const line = live.text.split("\n")[prepared.range.start.line] ?? "";
      const symbol = prepared.range.start.line === prepared.range.end.line
        ? line.slice(prepared.range.start.character, prepared.range.end.character).trim()
        : "";
      const fileCount = safeDeleteFileCount(deletion.locations);
      const confirmed = await confirmAppDialog({
        title: "Safe Delete Symbol",
        message: [
          `Delete ${symbol ? `"${symbol}"` : "the selected symbol"} and ${deletion.usageCount} reference${deletion.usageCount === 1 ? "" : "s"}?`,
          `${deletion.locations.length} occurrence${deletion.locations.length === 1 ? "" : "s"} across ${fileCount} file${fileCount === 1 ? "" : "s"} will be changed.`,
          "The complete operation can be undone as one workspace edit.",
        ].join("\n"),
        confirmLabel: "Delete Symbol",
        danger: true,
      });
      if (!confirmed) {
        controllerContext.setStatusMessage("Safe Delete cancelled; references remain open for review");
        return;
      }
      const documentUri = descriptor.documentUri ?? controllerContext.lspFilesRef.current[file.key]?.status?.uri ?? descriptor.filePath;
      const evidence = buildCapabilityEvidence({
        capabilityId: "refactor.safeDelete",
        languageId: descriptor.languageId ?? "java",
        provider: {
          id: descriptor.languageId ?? "jdtls",
          version: null,
          generation: controllerContext.lspSessionGeneration(),
        },
        projectFingerprint: controllerContext.projectAnalysisSnapshot?.projectFingerprint ?? "",
        uri: documentUri,
        revision: live.documentRevision ?? 0,
        position,
        scope: "project",
        complete: deletion.complete,
        reason: deletion.complete
          ? "all references resolved within workspace roots"
          : "references could not be completely resolved",
      });
      const plan = buildRefactorPlan({
        actionId: `safe-delete:${documentUri}:${prepared.range.start.line}:${prepared.range.start.character}`,
        kind: "safe-delete",
        evidence,
        edit: deletion.edit,
        roots: controllerContext.rootsRef.current,
        openFiles: controllerContext.buildPlanOpenFiles(),
        completeness: {
          value: deletion.complete ? "complete" : "partial",
          source: "client-observed-bounded",
          proof: deletion.complete
            ? "client-observed references within workspace roots"
            : "references could not be completely resolved",
        },
      });
      const gate = refactorApplyGate(plan);
      if (!gate.allowed) {
        controllerContext.semanticIndex.abandonBuild(buildToken);
        const reason = gate.reason || "Safe Delete blocked by refactor gate";
        if (controllerContext.referencesRequestSequenceRef.current === referencesRequestId) {
          controllerContext.setReferencesResult((current) => ({
            ...current,
            loading: false,
            error: reason,
          }));
        }
        controllerContext.setStatusMessage(`Safe Delete blocked: ${reason}`);
        return;
      }
      await controllerContext.applyLspWorkspaceEdit(deletion.edit, {
        label: "Safe delete symbol",
        semanticGeneration: buildToken.generation,
        semanticRevision: buildToken.revision,
        semanticWorkspaceOnly: true,
        plan,
      });
    } catch (error) {
      controllerContext.semanticIndex.failBuild(buildToken, errorMessage(error));
      if (controllerContext.referencesRequestSequenceRef.current === referencesRequestId) {
        controllerContext.setReferencesResult({
          loading: false,
          origin: `Safe Delete · ${live.subtitle}`,
          locations: [],
          error: errorMessage(error),
          semanticGeneration: null,
          semanticRevision: null,
        });
      }
      controllerContext.setStatusMessage(`Cannot safely delete symbol: ${errorMessage(error)}`);
    }
  };
}
