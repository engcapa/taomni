import type { PlatformWorkspace } from "../../stores/workspacePlatformStore";
import { useT } from "../../lib/i18n";
import { NotesWorkspaceDocument } from "./NotesWorkspaceDocument";
import { useNotesContentSync } from "./useNotesContentSync";
import type { NotesCommandsChange } from "./useNotesWorkspaceCommands";

export function NotesWorkspace({ workspace, visible, onCommandsChange }: { workspace: PlatformWorkspace; visible: boolean; onCommandsChange?: NotesCommandsChange }) {
  const t = useT();
  useNotesContentSync();
  const notes = workspace.openTabs.filter((tab) => tab.kind === "note" && tab.noteId);
  return <div data-testid="notes-workspace" className="h-full min-h-0" style={{ display: visible ? undefined : "none" }}>
    {!notes.length && <p className="p-5 text-sm text-[var(--taomni-text-muted)]">{t("notes.selectNote")}</p>}
    {notes.map((tab) => <NotesWorkspaceDocument key={tab.id} tab={tab} visible={visible && tab.id === workspace.activeTabId} onCommandsChange={onCommandsChange} />)}
  </div>;
}
