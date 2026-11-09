import { useEffect, useMemo } from "react";
import { useT } from "../../lib/i18n";
import { useNotesContentStore } from "../../stores/notesContentStore";
import { useWorkspaceActionsController } from "../editor/workspace/useWorkspaceActionsController";
import { useWorkspaceActionProjection } from "../editor/workspace/hooks/useWorkspaceActionProjection";
import type { WorkspaceCommand, WorkspaceCommandRegistration } from "../editor/workspace/workspaceCommands";

export type NotesCommandsChange = (tabId: string, registration: WorkspaceCommandRegistration | null) => void;

/** Publish Save through the same Action owner used by Workspace/AppKit menus. */
export function useNotesWorkspaceCommands(
  noteId: string, tabId: string, workspaceId: string, onCommandsChange?: NotesCommandsChange,
): void {
  const t = useT();
  const document = useNotesContentStore((state) => state.documents[noteId]);
  const commands = useMemo<WorkspaceCommand[]>(() => [{
    id: "notes.save", title: t("platform.saveFile"), category: "File", provenance: "local",
    keybinding: "Ctrl+S", platformKeybindings: { mac: ["Meta+S"] },
    isEnabled: () => {
      const doc = useNotesContentStore.getState().documents[noteId];
      return !!doc?.dirty && !doc.saving && doc.error !== "conflict" && doc.error !== "missing";
    },
    run: () => useNotesContentStore.getState().save(noteId),
  }], [noteId, t]);
  const contextData = useMemo(() => ({ hasActiveFile: !!document, isDirty: document?.dirty }), [document]);
  const { projection } = useWorkspaceActionsController({ workspaceId, commands, activeFocus: "editor", contextData });
  const { commandRegistration } = useWorkspaceActionProjection(projection);
  useEffect(() => { onCommandsChange?.(tabId, commandRegistration); }, [tabId, commandRegistration, onCommandsChange]);
  useEffect(() => () => onCommandsChange?.(tabId, null), [tabId, onCommandsChange]);
}
