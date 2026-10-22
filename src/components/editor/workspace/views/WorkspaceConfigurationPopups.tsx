import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../stores/codeWorkspaceStore";
import { WorkspaceBuildRunToolsDialog } from "../WorkspaceBuildRunToolsDialog";
import { WorkspaceEditorAppearanceSettingsDialog } from "../WorkspaceEditorAppearanceSettingsDialog";
import { WorkspaceIntelligenceSettingsDialog } from "../WorkspaceIntelligenceSettingsDialog";
import { WorkspaceTabPolicySettingsDialog } from "../WorkspaceTabPolicySettingsDialog";
import { writeWorkspaceBuildRunTools, type WorkspaceBuildRunTools } from "../codeWorkspaceModel";
import { useWorkspaceAppearance } from "../hooks/useWorkspaceAppearance";
import { useWorkspaceClipboard } from "../hooks/useWorkspaceClipboard";
import { useWorkspaceIntelligencePreferences } from "../hooks/useWorkspaceIntelligencePreferences";
import { useWorkspaceTabPolicy } from "../hooks/useWorkspaceTabPolicy";
import { useWorkspaceUiActions } from "../hooks/useWorkspaceUiActions";
import { type WorkspaceTabPolicyV3 } from "../workspaceTabPolicy";


export interface WorkspaceConfigurationPopupsProps {
  appearance: ReturnType<typeof useWorkspaceAppearance>;
  setStatusMessage: (message: string) => void;
  clipboard: ReturnType<typeof useWorkspaceClipboard>;
  uiActions: ReturnType<typeof useWorkspaceUiActions>;
  tabPolicyOwner: ReturnType<typeof useWorkspaceTabPolicy>;
  openOrder: string[];
  openFiles: Record<string, import("../editorGroupTypes").OpenFileViewModel>;
  workspaceInstanceId: string;
  activeEditorGroupId: string;
  applyTabPolicy: (policy: WorkspaceTabPolicyV3) => boolean | void | Promise<boolean | void>;
  intelligence: ReturnType<typeof useWorkspaceIntelligencePreferences>;
  buildRunToolsOpen: boolean;
  buildRunTools: WorkspaceBuildRunTools;
  setBuildRunTools: import("react").Dispatch<import("react").SetStateAction<WorkspaceBuildRunTools>>;
  setBuildRunToolsOpen: import("react").Dispatch<import("react").SetStateAction<boolean>>;
}

export function WorkspaceConfigurationPopups(props: WorkspaceConfigurationPopupsProps) {
  const {
    appearance,
    setStatusMessage,
    clipboard,
    uiActions,
    tabPolicyOwner,
    openOrder,
    openFiles,
    workspaceInstanceId,
    activeEditorGroupId,
    applyTabPolicy,
    intelligence,
    buildRunToolsOpen,
    buildRunTools,
    setBuildRunTools,
    setBuildRunToolsOpen,
  } = props;
  return (<>{appearance.editorAppearanceSettingsOpen && (
    <WorkspaceEditorAppearanceSettingsDialog
      open={appearance.editorAppearanceSettingsOpen}
      profile={appearance.editorAppearanceProfile}
      onApply={(next) => {
        appearance.updateEditorAppearanceProfile(next);
        setStatusMessage("Saved workspace editor appearance settings");
      }}
      onClearClipboardHistory={() => {
        clipboard.clipboardHandle.clearHistory();
        uiActions.setClipboardHistoryEntries([]);
        setStatusMessage("Cleared clipboard history for current workspace session");
      }}
      onClose={() => appearance.setEditorAppearanceSettingsOpen(false)}
    />
  )}
    {tabPolicyOwner.tabPolicySettingsOpen && (
      <WorkspaceTabPolicySettingsDialog
        open={tabPolicyOwner.tabPolicySettingsOpen}
        policy={tabPolicyOwner.tabPolicy}
        openTabs={openOrder.map((key) => ({
          key,
          title: openFiles[key]?.title ?? key,
          dirty: !!openFiles[key]?.dirty,
          pinned: (selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).editorGroups[activeEditorGroupId]?.pinnedKeys ?? []).includes(key),
          preview: selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).editorGroups[activeEditorGroupId]?.previewKey === key,
        }))}
        onApply={applyTabPolicy}
        onClose={tabPolicyOwner.closeTabPolicySettings}
      />
    )}
    {intelligence.intelligenceSettingsOpen && (
      <WorkspaceIntelligenceSettingsDialog
        open={intelligence.intelligenceSettingsOpen}
        preferences={intelligence.intelligencePreferences}
        onApply={(next) => {
          intelligence.setIntelligencePreferences(next);
          setStatusMessage("Saved editor intelligence settings");
        }}
        onClose={() => intelligence.setIntelligenceSettingsOpen(false)}
      />
    )}
    {buildRunToolsOpen && (
      <WorkspaceBuildRunToolsDialog
        config={buildRunTools}
        onSave={(next) => {
          setBuildRunTools(writeWorkspaceBuildRunTools(workspaceInstanceId, next));
          setBuildRunToolsOpen(false);
          setStatusMessage("Saved build and run tool settings");
        }}
        onClose={() => setBuildRunToolsOpen(false)}
      />
    )}
  </>);
}
