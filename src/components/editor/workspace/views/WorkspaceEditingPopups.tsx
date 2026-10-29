import { ClipboardHistoryPopup } from "../ClipboardHistoryPopup";
import { CodeInsightNotice, type CodeInsightNoticeState } from "../CodeInsightNotice";
import type { GoToLineRequest } from "../CodeMirrorHost";
import { CodeStyleSettingsDialog } from "../CodeStyleSettingsDialog";
import { GenerateCodeDialog } from "../GenerateCodeDialog";
import { GoToLineDialog } from "../GoToLineDialog";
import { KeymapCheatSheetDialog } from "../KeymapCheatSheetDialog";
import { KeymapMigrationNotice } from "../KeymapMigrationNotice";
import { KeymapSettingsDialog } from "../KeymapSettingsDialog";
import { SurroundWithDialog } from "../SurroundWithDialog";
import { type LspFileState } from "../codeWorkspaceModel";
import { useCodeGeneration } from "../hooks/useCodeGeneration";
import { useWorkspaceClipboard } from "../hooks/useWorkspaceClipboard";
import { useWorkspaceCodeStyle } from "../hooks/useWorkspaceCodeStyle";
import { useWorkspaceEditorCommands } from "../hooks/useWorkspaceEditorCommands";
import { useWorkspaceKeymap } from "../hooks/useWorkspaceKeymap";
import { useWorkspaceActionProjection } from "../hooks/useWorkspaceActionProjection";
import { useWorkspaceStatusBridge } from "../hooks/useWorkspaceStatusBridge";
import { useWorkspaceUiActions } from "../hooks/useWorkspaceUiActions";
import { useWorkspaceActionsController } from "../useWorkspaceActionsController";
import { activeSchemeForLanguage } from "../workspaceCodeStyleSchemes";
import { BUILTIN_KEYMAP_PRESETS, dismissKeymapDefaultsMigrationNotice } from "../workspaceKeymapScheme";


export interface WorkspaceEditingPopupsProps {
  uiActions: ReturnType<typeof useWorkspaceUiActions>;
  editorCommands: ReturnType<typeof useWorkspaceEditorCommands>;
  clipboard: ReturnType<typeof useWorkspaceClipboard>;
  codeGeneration: ReturnType<typeof useCodeGeneration>;
  activeLanguageId: string | null;
  setStatusMessage: (message: string) => void;
  keymapCheatSheetOpen: boolean;
  actionsController: ReturnType<typeof useWorkspaceActionsController>;
  setKeymapCheatSheetOpen: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  codeInsightNotice: CodeInsightNoticeState | null;
  setCodeInsightNotice: import("react").Dispatch<import("react").SetStateAction<CodeInsightNoticeState | null>>;
  statusBridge: ReturnType<typeof useWorkspaceStatusBridge>;
  activeLspState: LspFileState | null;
  goToLineRequest: GoToLineRequest | null;
  setGoToLineRequest: import("react").Dispatch<import("react").SetStateAction<GoToLineRequest | null>>;
  keymap: ReturnType<typeof useWorkspaceKeymap>;
  codeStyle: ReturnType<typeof useWorkspaceCodeStyle>;
  activeFile: import("../editorGroupTypes").OpenFileViewModel | null;
}

export function WorkspaceEditingPopups(props: WorkspaceEditingPopupsProps) {
  const { snapshot } = useWorkspaceActionProjection(props.actionsController.projection);
  const {
    uiActions,
    editorCommands,
    clipboard,
    codeGeneration,
    activeLanguageId,
    setStatusMessage,
    keymapCheatSheetOpen,
    actionsController,
    setKeymapCheatSheetOpen,
    codeInsightNotice,
    setCodeInsightNotice,
    statusBridge,
    activeLspState,
    goToLineRequest,
    setGoToLineRequest,
    keymap,
    codeStyle,
    activeFile,
  } = props;
  return (<><ClipboardHistoryPopup
    open={uiActions.clipboardHistoryOpen}
    entries={uiActions.clipboardHistoryEntries}
    onPaste={(index) => {
      editorCommands.executeActiveEditorCommand("pasteFromHistory", { historyIndex: index });
    }}
    onDelete={(index) => {
      clipboard.clipboardHandle.removeHistoryEntry(index);
      uiActions.setClipboardHistoryEntries([...clipboard.clipboardHandle.historyEntries()]);
    }}
    onClear={() => {
      clipboard.clipboardHandle.clearHistory();
      uiActions.setClipboardHistoryEntries([]);
    }}
    onClose={() => uiActions.setClipboardHistoryOpen(false)}
  />
    <GenerateCodeDialog
      open={uiActions.generateCode.open}
      phase={uiActions.generateCode.phase}
      candidates={uiActions.generateCode.candidates}
      error={uiActions.generateCode.error}
      onApply={(ids) => void codeGeneration.applyGenerateCandidates(ids)}
      onRetry={() => void codeGeneration.requestGenerateCandidates()}
      onCancel={codeGeneration.closeGenerateDialog}
    />
    <SurroundWithDialog
      open={uiActions.surroundWithDialogOpen}
      languageId={activeLanguageId}
      onClose={() => uiActions.setSurroundWithDialogOpen(false)}
      onPick={(kindId) => {
        const dispatched = editorCommands.executeActiveEditorCommand("surroundWith", {
          surroundKindId: kindId,
          onSemanticEditApplied: ({ applied, provenance }) => {
            if (!applied) {
              setStatusMessage("Surround requires a whole-line selection in one range");
              return;
            }
            // §8.19.8 honest provenance surfacing: local templates never
            // masquerade as Semantic in status reporting.
            setStatusMessage(
              provenance?.kind === "syntax-tree"
                ? `Surround applied (syntax node ${provenance.nodeType})`
                : "Surround applied (local template)",
            );
          },
        });
        if (!dispatched) setStatusMessage("Surround requires an active editor");
      }}
    />
    {keymapCheatSheetOpen && (
      <KeymapCheatSheetDialog
        open={true}
        actionSnapshots={snapshot}
        onClose={() => setKeymapCheatSheetOpen(false)}
        onExecuteCommand={(cmdId) => {
          // §8.17.3: cheatsheet runs the rendered frozen evaluation.
          const entry = snapshot.find((item) => item.id === cmdId);
          if (!entry) return;
          void actionsController.host.executePrepared(entry.evaluation);
        }}
      />
    )}
    {codeInsightNotice && (
      <CodeInsightNotice
        notice={codeInsightNotice}
        onClose={() => setCodeInsightNotice(null)}
        onConfigure={() => statusBridge.openLanguageServersSettings(activeLspState?.status?.presetId)}
      />
    )}
    {goToLineRequest && (
      <GoToLineDialog
        current={goToLineRequest.current}
        lineCount={goToLineRequest.lineCount}
        onGo={(target) => {
          const request = goToLineRequest;
          setGoToLineRequest(null);
          request.apply(target);
        }}
        onCancel={() => {
          const request = goToLineRequest;
          setGoToLineRequest(null);
          request.cancel();
        }}
        restoreFocusFallback={editorCommands.handleReturnToEditor}
      />
    )}
    {keymap.keymapMigrationNoticeOpen && !keymap.keymapSettingsOpen && (
      <KeymapMigrationNotice
        onOpenKeymap={() => {
          dismissKeymapDefaultsMigrationNotice();
          keymap.setKeymapMigrationNoticeOpen(false);
          keymap.setKeymapSettingsOpen(true);
        }}
        onDismiss={() => {
          dismissKeymapDefaultsMigrationNotice();
          keymap.setKeymapMigrationNoticeOpen(false);
        }}
      />
    )}
    {keymap.keymapSettingsOpen && (
      <KeymapSettingsDialog
        open={true}
        snapshot={snapshot}
        schemes={keymap.keymapSchemes}
        activeSchemeId={keymap.activeKeymapSchemeId}
        defaultSchemeName="IDEA defaults"
        corruptDiagnostic={keymap.keymapCorruptDiagnostic}
        onActiveSchemeChange={keymap.setActiveKeymapSchemeId}
        onSchemesChange={(schemes) => keymap.setKeymapSchemes([...schemes])}
        onApplyScheme={keymap.applyKeymapScheme}
        presets={BUILTIN_KEYMAP_PRESETS}
        assignActionId={keymap.keymapAssignActionId}
        restoreFocusFallback={editorCommands.handleReturnToEditor}
        onClose={() => {
          keymap.setKeymapSettingsOpen(false);
          keymap.setKeymapAssignActionId(null);
        }}
      />
    )}
    <CodeStyleSettingsDialog
      open={codeStyle.codeStyleSettingsOpen}
      store={codeStyle.codeStyleSchemes}
      activeLanguageId={(() => {
        const ext = activeFile?.languagePath.split(".").pop()?.toLowerCase() ?? "";
        return ext || null;
      })()}
      provenance={activeFile ? {
        filePath: activeFile.subtitle,
        effectiveLabel: codeStyle.getEffectiveCodeStyleForFile(activeFile)?.label ?? "—",
        source: codeStyle.getEffectiveCodeStyleForFile(activeFile)?.source ?? "fallback",
        schemeName: activeSchemeForLanguage(
          codeStyle.codeStyleSchemes,
          activeFile.languagePath.split(".").pop()?.toLowerCase() || null,
        ).name,
      } : null}
      onChange={codeStyle.changeCodeStyleSchemes}
      onClose={() => codeStyle.setCodeStyleSettingsOpen(false)}
    />
  </>);
}
