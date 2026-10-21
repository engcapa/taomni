import { type LspWorkspaceEdit } from "../../../../lib/editor/lsp";
import type { CodeWorkspaceRootInfo } from "../../../../types";
import { EditorCompareDialog } from "../EditorCompareDialog";
import { InlineRenamePopup } from "../InlineRenamePopup";
import { JavaMainClassPicker } from "../JavaMainClassPicker";
import { RefactorRecoveryReviewDialog } from "../RefactorRecoveryReviewDialog";
import { RefactoringPreviewDialog } from "../RefactoringPreviewDialog";
import { type EditorCompareSession } from "../editorCompareModel";
import { useRefactorRecovery } from "../hooks/useRefactorRecovery";
import { useSymbolRefactoring } from "../hooks/useSymbolRefactoring";
import { useWorkspaceComparisons } from "../hooks/useWorkspaceComparisons";
import { useWorkspaceDebugLaunch } from "../hooks/useWorkspaceDebugLaunch";
import { inlineRenameNameError } from "../inlineRename";
import { writeRefactorOptionsMode } from "../refactorOptions";
import { type RefactorPlanV3 } from "../refactorPlan";
import { type WorkspaceEditPreview } from "../workspaceEditPreview";


export interface WorkspaceRefactoringPopupsProps {
  debugLaunch: ReturnType<typeof useWorkspaceDebugLaunch>;
  inlineRename: import("../controller/model").InlineRenameRequest | null;
  refactoring: ReturnType<typeof useSymbolRefactoring>;
  refactoringPreviewModal: { title: string; preview: WorkspaceEditPreview; originalEdit: LspWorkspaceEdit; plan?: RefactorPlanV3; sourceTexts?: Record<string, string | null>; resolve: (filtered: LspWorkspaceEdit | boolean) => void; } | null;
  setRefactoringPreviewModal: import("react").Dispatch<import("react").SetStateAction<{ title: string; preview: WorkspaceEditPreview; originalEdit: LspWorkspaceEdit; plan?: RefactorPlanV3; sourceTexts?: Record<string, string | null>; resolve: (filtered: LspWorkspaceEdit | boolean) => void; } | null>>;
  refactorRecoveryReview: { entry: import("../refactorPlan").RefactorRecoveryJournalEntryV2; ownerInstanceId: string; preconditions: import("../refactorRecoveryController").RefactorRecoveryPreconditionSummary | null; loading: boolean; error: string | null; busy: boolean; } | null;
  roots: CodeWorkspaceRootInfo[];
  refactorRecovery: ReturnType<typeof useRefactorRecovery>;
  activeCompareSession: EditorCompareSession | null;
  setActiveCompareSession: import("react").Dispatch<import("react").SetStateAction<EditorCompareSession | null>>;
  comparisons: ReturnType<typeof useWorkspaceComparisons>;
}

export function WorkspaceRefactoringPopups(props: WorkspaceRefactoringPopupsProps) {
  const {
    debugLaunch,
    inlineRename,
    refactoring,
    refactoringPreviewModal,
    setRefactoringPreviewModal,
    refactorRecoveryReview,
    roots,
    refactorRecovery,
    activeCompareSession,
    setActiveCompareSession,
    comparisons,
  } = props;
  return (<><JavaMainClassPicker
    open={!!debugLaunch.javaMainCandidates}
    candidates={debugLaunch.javaMainCandidates?.candidates ?? []}
    onClose={() => debugLaunch.setJavaMainCandidates(null)}
    onPick={(main) => {
      const pending = debugLaunch.javaMainCandidates;
      debugLaunch.setJavaMainCandidates(null);
      if (pending) debugLaunch.launchJavaDebug(
        pending.launch,
        main,
        pending.override,
        pending.environment,
        pending.runtimeOptions,
      );
    }}
  />
    {inlineRename && (
      <InlineRenamePopup
        key={inlineRename.id}
        kind={inlineRename.kind}
        anchor={inlineRename.anchor}
        initialValue={inlineRename.initialValue}
        suggestions={inlineRename.suggestions}
        initialError={inlineRename.initialError}
        validate={(name) => inlineRenameNameError(name, inlineRename.languageId)}
        modalOptions={refactoring.refactorModalOptions}
        onCommit={(name) => refactoring.finishInlineRename(inlineRename, { kind: "commit", name })}
        onCancel={() => refactoring.finishInlineRename(inlineRename, { kind: "cancel" })}
        onOpenDialog={(value) => refactoring.finishInlineRename(inlineRename, { kind: "dialog", value })}
        onToggleModalOptions={(modal) => {
          writeRefactorOptionsMode(modal ? "dialog" : "editor");
          refactoring.setRefactorModalOptions(modal);
        }}
      />
    )}
    {refactoringPreviewModal && (
      <RefactoringPreviewDialog
        open={true}
        title={refactoringPreviewModal.title}
        preview={refactoringPreviewModal.preview}
        originalEdit={refactoringPreviewModal.originalEdit}
        plan={refactoringPreviewModal.plan}
        sourceTexts={refactoringPreviewModal.sourceTexts}
        onConfirm={(filteredEdit) => {
          refactoringPreviewModal.resolve(filteredEdit);
          setRefactoringPreviewModal(null);
        }}
        onCancel={() => {
          refactoringPreviewModal.resolve(false);
          setRefactoringPreviewModal(null);
        }}
      />
    )}
    {refactorRecoveryReview && (
      <RefactorRecoveryReviewDialog
        entry={refactorRecoveryReview.entry}
        workspaceRoot={roots[0]?.path ?? refactorRecoveryReview.entry.workspaceRoot}
        preconditions={refactorRecoveryReview.preconditions}
        loading={refactorRecoveryReview.loading}
        error={refactorRecoveryReview.error}
        busy={refactorRecoveryReview.busy}
        onKeep={() => refactorRecovery.keepRecoveryReview(refactorRecoveryReview.entry.recoveryId)}
        onRestore={() => {
          const current = refactorRecovery.refactorRecoveryReviewRef.current;
          if (!current || !current.preconditions) return;
          void refactorRecovery.runRecoveryRestore(current.entry, current.preconditions, current.ownerInstanceId);
        }}
        onDismiss={() => {
          const current = refactorRecovery.refactorRecoveryReviewRef.current;
          if (!current) return;
          void refactorRecovery.runRecoveryDismiss(current.entry, current.ownerInstanceId);
        }}
        onClose={() => refactorRecovery.keepRecoveryReview(refactorRecoveryReview.entry.recoveryId)}
      />
    )}
    {activeCompareSession && (
      <EditorCompareDialog
        session={activeCompareSession}
        onClose={() => setActiveCompareSession(null)}
        onApplyRight={(newText) => comparisons.applyCompareSession(activeCompareSession, newText)}
      />
    )}
  </>);
}
