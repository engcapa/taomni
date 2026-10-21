import { confirmAppDialog, promptAppDialog } from "../../../../../lib/appDialogs";
import {
  lspPrepareRename,
  lspRename,
  type LspDocumentDescriptor,
  type LspDocumentStatus,
  type LspPosition,
  type LspRange,
  type LspRenameResult,
  type LspWorkspaceEdit,
} from "../../../../../lib/editor/lsp";
import type { CodeWorkspaceRootInfo } from "../../../../../types";
import { buildCapabilityEvidence } from "../../capabilityEvidence";
import { errorMessage, type LspFileState, type OpenFileState } from "../../codeWorkspaceModel";
import { buildRefactorPlan, refactorApplyGate, type RefactorKind, type RefactorPlanV3, type WorkspaceEditRecoveryPlan } from "../../refactorPlan";
import { type ReplaceFilePreimage } from "../../replaceInFilesModel";
import { type WorkspaceEditApplyOutcome, type WorkspaceEditApplyTransactionSummary } from "../../workspaceEditApply";
import { workspaceEditOperations } from "../../workspaceEditPreview";
import { workspaceSemanticIndexTokenRevisionCurrent } from "../../workspaceSemanticIndex";
import { type RenameSymbolAtResult } from "../model";

export interface RenameSymbolAtContext {
  lspFilesRef: import("react").RefObject<Record<string, LspFileState>>;
  setStatusMessage: (message: string) => void;
  semanticIndex: import("../../useWorkspaceSemanticIndex").WorkspaceSemanticIndexController;
  ensureWorkspaceSemanticDocumentsSynced: (requiredFileKey: string, expectedRevision: number) => Promise<OpenFileState | null>;
  lspDescriptorForFile: (file: OpenFileState) => LspDocumentDescriptor | null;
  updateLspStatusForFile: (file: OpenFileState, status: LspDocumentStatus) => void;
  promptSymbolName: (input: { file: OpenFileState; kind: "rename" | "extract"; range: LspRange | null; defaultName: string; initialValue?: string; error?: string | null; dialog: (initialValue: string) => Promise<string | null>; }) => Promise<string | null>;
  describeSemanticInvalidation: (snapshot: ReturnType<() => import("../../workspaceSemanticIndex").WorkspaceSemanticIndexSnapshot>, tokenRevision: number) => string;
  lspSessionGeneration: () => number;
  projectAnalysisSnapshot: import("../../projectAnalysisModel").JavaProjectAnalysisSnapshotV1 | null;
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
