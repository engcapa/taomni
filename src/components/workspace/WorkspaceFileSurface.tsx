import type { PlatformWorkspace } from "../../stores/workspacePlatformStore";
import { useWorkspaceEditorStore } from "../../stores/workspaceEditorStore";
import { useT } from "../../lib/i18n";
import { WorkspaceCodeEditor, type WorkspaceCodeEditorProps } from "./WorkspaceCodeEditor";
import { workspaceEditorRuntimeId, usesSharedWorkspaceEditor } from "./useWorkspaceCodeHost";

/** One complete editor/LSP runtime per workspace, shared by every file type. */
export function WorkspaceFileSurface({ workspace, visible, onCommandsChange }: {
  workspace: PlatformWorkspace;
  visible: boolean;
  onCommandsChange?: WorkspaceCodeEditorProps["onCommandsChange"];
}) {
  const t = useT();
  const active = workspace.openTabs.find((tab) => tab.id === workspace.activeTabId && tab.kind === "file");
  const document = useWorkspaceEditorStore((state) => active ? state.documents[active.id] : undefined);
  const recoveryError = useWorkspaceEditorStore((state) => state.recoveryError);
  const shared = usesSharedWorkspaceEditor(workspace);
  return <div data-testid={active ? "workspace-file-editor" : "workspace-code-tab"}
    data-path={active?.filePath} data-dirty={document?.dirty || undefined}
    className="flex h-full min-h-0 w-full flex-col">
    {document?.error && <div role="alert" data-testid="workspace-editor-error" className="px-2 text-xs text-[var(--taomni-danger)]">{document.error}</div>}
    {recoveryError && <div role="alert" data-testid="workspace-editor-recovery-error" className="px-2 text-xs text-[var(--taomni-danger)]">
      {t("platform.draftRecoveryFailed")} {recoveryError}
    </div>}
    <div className="min-h-0 flex-1"><WorkspaceCodeEditor tabId={workspaceEditorRuntimeId(workspace)} workspace={workspace}
      visible={visible} sharedFiles={shared} onCommandsChange={onCommandsChange} /></div>
  </div>;
}
