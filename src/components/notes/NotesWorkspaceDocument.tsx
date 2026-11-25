import { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLink, Save } from "lucide-react";
import { useNotesContentStore } from "../../stores/notesContentStore";
import { useWorkspacePlatformStore, type WorkspaceIsolatedTab } from "../../stores/workspacePlatformStore";
import { useAppStore } from "../../stores/appStore";
import { getAppPlatform } from "../../lib/runtime";
import { useT } from "../../lib/i18n";
import {
  noteWorkspaceModes, OPEN_NOTES_WORKSPACE_EVENT, openNoteInTao, type NoteWorkspaceMode,
} from "../../lib/notes/notesWorkspaceNavigation";
import { MarkdownEditor } from "../viewer/markdown/MarkdownEditor";
import type { MarkdownMode } from "../viewer/markdown/MarkdownToolbar";
import type { ViewerDocument } from "../../lib/viewer";
import { createNoteMarkdownOwner } from "./noteMarkdownOwner";
import "../viewer/viewer.css";
import { useNoteTask } from "./useNoteTask";
import { NoteTaskActions, NoteTaskStatus } from "./NoteTaskActions";
import { NoteTaskDetails } from "./NoteTaskDetails";
import { NoteContentStatus } from "./NoteContentStatus";
import { useNotesWorkspaceCommands, type NotesCommandsChange } from "./useNotesWorkspaceCommands";

export function NotesWorkspaceDocument({ tab, visible, onCommandsChange }: { tab: WorkspaceIsolatedTab; visible: boolean; onCommandsChange?: NotesCommandsChange }) {
  const t = useT();
  const noteId = tab.noteId!;
  const note = useNoteTask(noteId);
  useNotesWorkspaceCommands(noteId, tab.id, tab.workspaceId, onCommandsChange);
  const doc = useNotesContentStore((state) => state.documents[noteId]);
  const [mode, setMode] = useState<NoteWorkspaceMode>(noteWorkspaceModes.get(noteId) ?? "preview");
  const [taskDetailsOpen, setTaskDetailsOpen] = useState(false);
  const path = `${noteId}.md`;
  useEffect(() => { void useNotesContentStore.getState().refresh(noteId); }, [noteId]);
  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<{ noteId: string; mode: NoteWorkspaceMode }>).detail;
      if (detail?.noteId === noteId) setMode(detail.mode);
    };
    window.addEventListener(OPEN_NOTES_WORKSPACE_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_NOTES_WORKSPACE_EVENT, onOpen);
  }, [noteId]);
  useEffect(() => {
    if (doc) useWorkspacePlatformStore.getState().renameWorkspaceTab(tab.workspaceId, tab.id, `${doc.title.trim() || t("notes.titlePlaceholder")}.md`);
  }, [doc?.title, tab.workspaceId, tab.id, t]);
  const changeBody = useCallback((body: string) => {
    const current = useNotesContentStore.getState().documents[noteId];
    if (current) useNotesContentStore.getState().edit({ id: noteId, ...current }, { body });
  }, [noteId]);
  const save = useCallback(() => useNotesContentStore.getState().save(noteId), [noteId]);
  const file = useMemo<ViewerDocument | null>(() => doc ? {
    key: `note:${noteId}`, path, kind: "markdown", content: doc.body, savedContent: doc.saved.body,
    savedHash: "", encoding: "UTF-8", bom: false, eol: "LF", savedEncoding: "UTF-8", savedBom: false,
    savedEol: "LF", originalLineEndings: [], mtime: 0, size: doc.body.length, loading: false,
    saving: doc.saving, dirty: doc.dirty, revision: 0, readOnly: doc.error === "missing",
    large: false, truncated: false, chunkOffset: 0, nextOffset: 0, eof: true,
  } : null, [doc, noteId, path, t]);
  const markdownOwner = useMemo(() => createNoteMarkdownOwner({ filename: () => {
    const title = useNotesContentStore.getState().documents[noteId]?.title || "note";
    return `${title.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")}.md`;
  }, onChange: changeBody, onSave: save }), [noteId, changeBody, save]);
  const markdownMode: MarkdownMode = mode === "edit" ? "source" : mode === "preview" ? "live" : "split";
  const onMarkdownMode = (value: MarkdownMode) => {
    const next = value === "source" ? "edit" : value === "live" ? "preview" : "split";
    setMode(next); noteWorkspaceModes.set(noteId, next);
  };
  const report = useCallback((message: string) => useAppStore.getState().setStatusMessage(message), []);
  return <div data-testid="notes-workspace-document" data-note-id={noteId} data-mode={mode}
    data-active={visible || undefined} aria-hidden={!visible}
    data-dirty={doc?.dirty || undefined} className="flex h-full min-h-0 flex-col" style={{ display: visible ? "flex" : "none" }}
    onKeyDown={(event) => {
      const primary = getAppPlatform() === "macos" ? event.metaKey : event.ctrlKey;
      if (!event.defaultPrevented && !event.nativeEvent.isComposing && primary && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "s") {
        event.preventDefault(); void save();
      }
    }}>
    <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-[var(--taomni-divider)] p-1.5">
      <input className="taomni-input h-7 min-w-20 flex-1 text-sm" data-testid="notes-workspace-title"
        aria-label={t("notes.titlePlaceholder")} placeholder={t("notes.titlePlaceholder")}
        value={doc?.title ?? ""} disabled={!doc}
        onChange={(event) => { if (doc) useNotesContentStore.getState().edit({ id: noteId, ...doc }, { title: event.target.value }); }} />
      <button type="button" data-testid="notes-workspace-save" className="taomni-btn flex h-7 items-center gap-1 px-2 text-xs"
        disabled={!doc?.dirty || doc.saving || doc.error === "conflict" || doc.error === "missing"} onClick={() => void save()}>
        <Save className="h-3.5 w-3.5" />{t("platform.saveFile")}
      </button>
      <button type="button" data-testid="notes-workspace-tao" className="taomni-btn flex h-7 items-center gap-1 px-2 text-xs"
        onClick={() => { void openNoteInTao(noteId).catch((error) => useAppStore.getState().setStatusMessage(String(error))); }}>
        <ExternalLink className="h-3.5 w-3.5" />{t("notes.backToTao")}
      </button>
    </div>
    {note && <div className="flex shrink-0 items-center gap-2 border-b border-[var(--taomni-divider)] px-2 py-1">
      <NoteTaskActions note={note} prefix="notes-workspace" onDeleted={() => {
        useWorkspacePlatformStore.getState().closeWorkspaceTab(tab.workspaceId, tab.id);
      }} />
      <span className="text-xs text-[var(--taomni-text-muted)]">{t("notes.taskDetails")}</span>
    </div>}
    <NoteTaskStatus noteId={noteId} />
    {note && <details className="shrink-0 border-b border-[var(--taomni-divider)]" data-testid="notes-workspace-properties"
      open={taskDetailsOpen} onToggle={(event) => setTaskDetailsOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer px-2 py-1 text-xs">{t("notes.taskDetails")} · {t(`notes.priority_${note.priority}`)}</summary>
      {/* WebKitGTK overlay scrollbars reserve a wider pointer lane than their visible thumb. */}
      <div className="max-h-56 overflow-auto p-2 pr-8"><NoteTaskDetails key={note.id} note={note} prefix="notes-workspace" /></div>
    </details>}
    <NoteContentStatus noteId={noteId} />
    {!doc && <p className="p-3 text-xs">{t("notes.loading")}</p>}
    {doc && file && <div data-testid="notes-workspace-editor" className="fv min-h-0 flex-1">
      <MarkdownEditor document={file} owner={markdownOwner} requestedMode={markdownMode} onModeChange={onMarkdownMode} onError={report} />
    </div>}
    <div data-testid="notes-workspace-status" className="flex shrink-0 gap-3 border-t border-[var(--taomni-divider)] px-2 py-1 text-ui-small text-[var(--taomni-text-muted)]">
      <span>Markdown</span><span>{t(doc?.saving ? "notes.savingContent" : doc?.dirty ? "notes.modifiedContent" : "notes.savedContent")}</span>
      <span>{t("notes.sharedContent")}</span>
    </div>
  </div>;
}
