import { confirmAppDialog } from "../../../../../lib/appDialogs";
import { lspDefinition, lspPrepareRename, lspReferences, type LspDocumentDescriptor, type LspDocumentStatus, type LspWorkspaceEdit } from "../../../../../lib/editor/lsp";
import { type BottomDockTabId } from "../../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceRootInfo } from "../../../../../types";
import { buildCapabilityEvidence } from "../../capabilityEvidence";
import { type EditorSelectionRange } from "../../CodeMirrorHost";
import { errorMessage, type LspFileState, type OpenFileState } from "../../codeWorkspaceModel";
import { type ReferencesResultState } from "../../panels/ReferencesPanel";
import {
  buildRefactorPlan,
  evaluateDestructiveRefactorAvailability,
  refactorApplyGate,
  type RefactorKind,
  type RefactorPlanV3,
  type WorkspaceEditRecoveryPlan,
} from "../../refactorPlan";
import { type ReplaceFilePreimage } from "../../replaceInFilesModel";
import { buildSafeDeleteWorkspaceEdit, safeDeleteFileCount } from "../../safeDelete";
import { type WorkspaceEditApplyOutcome, type WorkspaceEditApplyTransactionSummary } from "../../workspaceEditApply";
import { workspaceSemanticIndexBuildIsCurrent } from "../../workspaceSemanticIndex";

export interface SafeDeleteSymbolAtCursorContext {
  activeFile: import("../../editorGroupTypes").OpenFileViewModel | null;
  setStatusMessage: (message: string) => void;
  semanticIndex: import("../../useWorkspaceSemanticIndex").WorkspaceSemanticIndexController;
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
  projectAnalysisSnapshot: import("../../projectAnalysisModel").JavaProjectAnalysisSnapshotV1 | null;
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
