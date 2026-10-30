import { memo } from "react";
import type { CodeWorkspaceRootInfo } from "../../../../types";
import { TextInputDialog } from "../../../sidebar/ConfirmDialog";
import { AutoImportCandidateDialog } from "../AutoImportCandidateDialog";
import { AutoImportSettingsDialog } from "../AutoImportSettingsDialog";
import { FileTemplateSettingsDialog } from "../FileTemplateSettingsDialog";
import { NewJavaClassDialog } from "../NewJavaClassDialog";
import { UndoWorkspaceEditConfirmDialog } from "../UndoWorkspaceEditConfirmDialog";
import { type AutoImportCandidate } from "../autoImportModel";
import { useSymbolRefactoring } from "../hooks/useSymbolRefactoring";


export interface WorkspaceGenerationPopupsProps {
  newJavaClassDialogState: { open: boolean; targetDirectory: string; root: CodeWorkspaceRootInfo; dirRelPath: string; sourceRoots: readonly string[]; existingFiles: readonly string[]; projectFactsStatus: string; projectFactsGeneration: number; projectFactsFingerprint: string | null; } | null;
  setNewJavaClassDialogState: import("react").Dispatch<import("react").SetStateAction<{ open: boolean; targetDirectory: string; root: CodeWorkspaceRootInfo; dirRelPath: string; sourceRoots: readonly string[]; existingFiles: readonly string[]; projectFactsStatus: string; projectFactsGeneration: number; projectFactsFingerprint: string | null; } | null>>;
  createJavaClassFromPlan: (plan: import("../fileTemplateModel").PlanTemplateCreationResult & { valid: true; }) => Promise<boolean>;
  setFileTemplateSettingsOpen: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  fileTemplateSettingsOpen: boolean;
  autoImportSettingsOpen: boolean;
  setAutoImportSettingsOpen: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  autoImportCandidatePrompt: { candidates: readonly AutoImportCandidate[]; onSelect: (candidate: AutoImportCandidate) => void; onClose: () => void; } | null;
  workspaceUndoConfirmOpen: boolean;
  workspaceEditHistoryState: import("../workspaceEditHistory").WorkspaceEditHistoryState;
  undoConfirmTriggerRef: import("react").RefObject<HTMLElement | null>;
  closeWorkspaceUndoConfirmation: () => void;
  setWorkspaceUndoConfirmOpen: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  undoWorkspaceEdit: () => Promise<void>;
  refactoring: ReturnType<typeof useSymbolRefactoring>;
}

export const WorkspaceGenerationPopups = memo(function WorkspaceGenerationPopups(props: WorkspaceGenerationPopupsProps) {
  const {
    newJavaClassDialogState,
    setNewJavaClassDialogState,
    createJavaClassFromPlan,
    setFileTemplateSettingsOpen,
    fileTemplateSettingsOpen,
    autoImportSettingsOpen,
    setAutoImportSettingsOpen,
    autoImportCandidatePrompt,
    workspaceUndoConfirmOpen,
    workspaceEditHistoryState,
    undoConfirmTriggerRef,
    closeWorkspaceUndoConfirmation,
    setWorkspaceUndoConfirmOpen,
    undoWorkspaceEdit,
    refactoring,
  } = props;
  return (<>{newJavaClassDialogState && (
    <NewJavaClassDialog
      open={newJavaClassDialogState.open}
      targetDirectory={newJavaClassDialogState.targetDirectory}
      sourceRoots={newJavaClassDialogState.sourceRoots}
      existingFiles={newJavaClassDialogState.existingFiles}
      projectFactsStatus={newJavaClassDialogState.projectFactsStatus}
      onClose={() => setNewJavaClassDialogState(null)}
      onCreate={createJavaClassFromPlan}
      onOpenSettings={() => setFileTemplateSettingsOpen(true)}
    />
  )}
    <FileTemplateSettingsDialog
      open={fileTemplateSettingsOpen}
      onClose={() => setFileTemplateSettingsOpen(false)}
    />
    <AutoImportSettingsDialog
      open={autoImportSettingsOpen}
      onClose={() => setAutoImportSettingsOpen(false)}
    />
    {autoImportCandidatePrompt && (
      <AutoImportCandidateDialog
        open={true}
        candidates={autoImportCandidatePrompt.candidates}
        onSelect={autoImportCandidatePrompt.onSelect}
        onClose={autoImportCandidatePrompt.onClose}
      />
    )}
    {workspaceUndoConfirmOpen && (
      <UndoWorkspaceEditConfirmDialog
        label={workspaceEditHistoryState.undoLabel}
        returnFocusTo={undoConfirmTriggerRef.current}
        onCancel={closeWorkspaceUndoConfirmation}
        onConfirm={() => {
          setWorkspaceUndoConfirmOpen(false);
          void undoWorkspaceEdit();
        }}
      />
    )}
    {refactoring.extractNamingPrompt && (
      <div data-testid="extract-method-name-prompt" onKeyDown={refactoring.handleExtractNamingTab}>
        <TextInputDialog
          title={refactoring.extractNamingPrompt.title}
          label={refactoring.extractNamingPrompt.label}
          initialValue={refactoring.extractNamingPrompt.initialValue}
          confirmLabel={refactoring.extractNamingPrompt.confirmLabel}
          onCancel={() => refactoring.resolveExtractNamingPrompt(null)}
          onConfirm={(value) => refactoring.resolveExtractNamingPrompt(value)}
        />
      </div>
    )}
  </>);
}, (previous, next) => generationPopupsClosed(previous) && generationPopupsClosed(next));

/** Closed owners stay mounted; every open/close transition still renders. */
function generationPopupsClosed(props: WorkspaceGenerationPopupsProps): boolean {
  return props.newJavaClassDialogState === null
    && !props.fileTemplateSettingsOpen
    && !props.autoImportSettingsOpen
    && props.autoImportCandidatePrompt === null
    && !props.workspaceUndoConfirmOpen
    && !props.refactoring.extractNamingPrompt;
}
