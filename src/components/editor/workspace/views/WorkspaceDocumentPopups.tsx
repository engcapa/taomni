import { type EditorSelectionRange } from "../CodeMirrorHost";
import { EditorAiRewriteDialog } from "../EditorAiRewriteDialog";
import { EditorSelectionAiToolbar } from "../EditorSelectionAiToolbar";
import { ExternalFileConflictDialog } from "../ExternalFileConflictDialog";
import { FileEncodingDialog } from "../FileEncodingDialog";
import { LocalHistoryDialog } from "../LocalHistoryDialog";
import { WorkspaceRecoveryDialog } from "../WorkspaceRecoveryDialog";
import { type PendingExternalFileConflict } from "../controller/model";
import { useWorkspacePreferences } from "../controller/useWorkspacePreferences";
import { useEditorAiActions } from "../hooks/useEditorAiActions";
import { useWorkspaceEncoding } from "../hooks/useWorkspaceEncoding";
import { useWorkspaceFileLifecycle } from "../hooks/useWorkspaceFileLifecycle";
import { useWorkspaceLocalHistory } from "../hooks/useWorkspaceLocalHistory";
import { useWorkspaceRecoveryActions } from "../hooks/useWorkspaceRecoveryActions";
import { useWorkspaceRecoveryState } from "../hooks/useWorkspaceRecoveryState";


export interface WorkspaceDocumentPopupsProps {
  visible: boolean;
  externalFileConflicts: PendingExternalFileConflict[];
  fileLifecycle: ReturnType<typeof useWorkspaceFileLifecycle>;
  recoveryState: ReturnType<typeof useWorkspaceRecoveryState>;
  recoveryActions: ReturnType<typeof useWorkspaceRecoveryActions>;
  fileEncodingDialogOpen: boolean;
  activeFile: import("../editorGroupTypes").OpenFileViewModel | null;
  encodingOwner: ReturnType<typeof useWorkspaceEncoding>;
  setFileEncodingDialogOpen: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  localHistoryTarget: { key: string; path: string; } | null;
  openFiles: Record<string, import("../editorGroupTypes").OpenFileViewModel>;
  localHistory: ReturnType<typeof useWorkspaceLocalHistory>;
  editorAi: ReturnType<typeof useEditorAiActions>;
  aiRewriteState: { key: string; path: string; original: string; proposal: string; instruction: string; range: EditorSelectionRange; } | null;
  preferences: ReturnType<typeof useWorkspacePreferences>;
  applySelectionReplacement: (key: string, range: EditorSelectionRange, nextText: string) => void;
  setStatusMessage: (message: string) => void;
}

export function WorkspaceDocumentPopups(props: WorkspaceDocumentPopupsProps) {
  const {
    visible,
    externalFileConflicts,
    fileLifecycle,
    recoveryState,
    recoveryActions,
    fileEncodingDialogOpen,
    activeFile,
    encodingOwner,
    setFileEncodingDialogOpen,
    localHistoryTarget,
    openFiles,
    localHistory,
    editorAi,
    aiRewriteState,
    preferences,
    applySelectionReplacement,
    setStatusMessage,
  } = props;
  return (<>{visible && externalFileConflicts[0] && (
    <ExternalFileConflictDialog
      path={externalFileConflicts[0].path}
      baseText={externalFileConflicts[0].baseText}
      localText={externalFileConflicts[0].localText}
      diskText={externalFileConflicts[0].disk?.text ?? null}
      onKeepLocal={() => fileLifecycle.keepLocalExternalFileConflict(externalFileConflicts[0]!)}
      onLoadDisk={() => {
        void fileLifecycle.loadDiskExternalFileConflict(externalFileConflicts[0]!);
      }}
      onApplyMerge={(text) => fileLifecycle.mergeExternalFileConflict(externalFileConflicts[0]!, text)}
      onCancel={() => fileLifecycle.dismissExternalFileConflict(externalFileConflicts[0]!.key)}
    />
  )}
    {visible && recoveryState.workspaceRecoveryOpen && externalFileConflicts.length === 0 && (
      <WorkspaceRecoveryDialog
        entries={recoveryState.workspaceRecoveryEntries}
        onRecover={(entry) => {
          void recoveryActions.recoverWorkspaceEntry(entry);
        }}
        onDiscard={recoveryActions.discardWorkspaceRecoveryEntry}
        onRecoverAll={recoveryActions.recoverAllWorkspaceEntries}
        onDiscardAll={recoveryActions.discardAllWorkspaceRecoveryEntries}
        onClose={() => recoveryState.setWorkspaceRecoveryOpen(false)}
        ledgerEntries={recoveryState.diskEffectLedgerEntries}
        onAcknowledgeLedgerEntry={recoveryActions.acknowledgeDiskEffectLedgerEntry}
        onReopenLedgerEntry={recoveryActions.reopenDiskEffectLedgerFile}
      />
    )}
    {visible && fileEncodingDialogOpen && activeFile && !activeFile.library && (
      <FileEncodingDialog
        path={activeFile.path}
        currentEncoding={activeFile.encoding ?? "UTF-8"}
        currentBom={activeFile.bom ?? false}
        dirty={activeFile.dirty}
        onReload={(encoding) => encodingOwner.reloadActiveFileWithEncoding(encoding)}
        onConvert={encodingOwner.convertActiveFileEncoding}
        onClose={() => setFileEncodingDialogOpen(false)}
      />
    )}
    {localHistoryTarget && openFiles[localHistoryTarget.key] && (
      <LocalHistoryDialog
        path={localHistoryTarget.path}
        onClose={() => localHistory.setLocalHistoryTarget(null)}
        onRestore={(text) => localHistory.restoreLocalHistoryText(localHistoryTarget.key, text)}
        onCompare={(entry, text) => {
          localHistory.compareLocalHistorySnapshot(localHistoryTarget.key, entry, text);
        }}
      />
    )}
    <EditorSelectionAiToolbar
      visible={!!editorAi.editorAiSelection && !aiRewriteState}
      rect={editorAi.editorAiSelection?.rect ?? null}
      selectionText={editorAi.editorAiSelection?.text ?? ""}
      answerLanguage={preferences.editorAiPreferences.answerLanguage}
      onAction={(action, text) => {
        void editorAi.handleEditorAiAction(action, text);
      }}
      onSetAnswerLanguage={preferences.setAiAnswerLanguage}
      onDismiss={() => editorAi.setEditorAiSelection(null)}
    />
    {aiRewriteState && (
      <EditorAiRewriteDialog
        path={aiRewriteState.path}
        original={aiRewriteState.original}
        proposal={aiRewriteState.proposal}
        instruction={aiRewriteState.instruction}
        onInstructionChange={(value) => editorAi.setAiRewriteState((current) => (
          current ? { ...current, instruction: value } : current
        ))}
        onProposalChange={(value) => editorAi.setAiRewriteState((current) => (
          current ? { ...current, proposal: value } : current
        ))}
        onClose={() => editorAi.setAiRewriteState(null)}
        onRegenerate={() => void editorAi.regenerateAiRewrite()}
        onApply={() => {
          applySelectionReplacement(aiRewriteState.key, aiRewriteState.range, aiRewriteState.proposal);
          editorAi.setAiRewriteState(null);
          setStatusMessage("Applied AI proposal to the selection");
        }}
      />
    )}
  </>);
}
