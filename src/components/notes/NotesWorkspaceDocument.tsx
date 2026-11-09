import { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLink, Save } from "lucide-react";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { useNotesContentStore } from "../../stores/notesContentStore";
import { useWorkspacePlatformStore, type WorkspaceIsolatedTab } from "../../stores/workspacePlatformStore";
import { useAppStore } from "../../stores/appStore";
import { getAppPlatform, isTauriRuntime } from "../../lib/runtime";
import { useT } from "../../lib/i18n";
import {
  noteWorkspaceModes, OPEN_NOTES_WORKSPACE_EVENT, openNoteInTao, type NoteWorkspaceMode,
} from "../../lib/notes/notesWorkspaceNavigation";
import { CodeMirrorHost } from "../editor/workspace/CodeMirrorHost";
import { MarkdownPreview } from "../editor/workspace/MarkdownPreview";
import type { OpenFileState } from "../editor/workspace/codeWorkspaceModel";
import { useNoteTask } from "./useNoteTask";
import { NoteTaskActions, NoteTaskStatus } from "./NoteTaskActions";
import { NoteTaskDetails } from "./NoteTaskDetails";
import { NoteContentStatus } from "./NoteContentStatus";
import { useNotesWorkspaceCommands, type NotesCommandsChange } from "./useNotesWorkspaceCommands";

const NO_DIAGNOSTICS: [] = [];
const noHover = async () => null;
const noDefinition = async () => false;
const noReferences = async () => undefined;
const noCompletionIdentity = () => null;
const noCompletionDiagnostic = () => undefined;

export function NotesWorkspaceDocument({ tab, visible, onCommandsChange }: { tab: WorkspaceIsolatedTab; visible: boolean; onCommandsChange?: NotesCommandsChange }) {
  const t = useT();
  const noteId = tab.noteId!;
  const note = useNoteTask(noteId);
  useNotesWorkspaceCommands(noteId, tab.id, tab.workspaceId, onCommandsChange);
  const doc = useNotesContentStore((state) => state.documents[noteId]);
  const [mode, setMode] = useState<NoteWorkspaceMode>(noteWorkspaceModes.get(noteId) ?? "edit");
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
  const save = useCallback(() => { void useNotesContentStore.getState().save(noteId); }, [noteId]);
  const file = useMemo<OpenFileState | null>(() => doc ? {
    ref: { kind: "loose", id: noteId, path }, key: `note:${noteId}`, path,
    title: doc.title || t("notes.titlePlaceholder"), subtitle: "Notes", languagePath: path,
    text: doc.body, savedText: doc.saved.body, eol: "LF", hash: "", mtime: 0,
    size: doc.body.length, loading: false, saving: doc.saving, dirty: doc.dirty,
    documentRevision: 0, error: null,
  } : null, [doc, noteId, path, t]);
  const openHref = useCallback((href: string) => {
    if (!/^https?:\/\//i.test(href)) return true;
    if (isTauriRuntime()) void openExternal(href).catch((error) => useAppStore.getState().setStatusMessage(String(error)));
    else window.open(href, "_blank", "noopener,noreferrer");
    return true;
  }, []);
  return <div data-testid="notes-workspace-document" data-note-id={noteId} data-mode={mode}
    data-active={visible || undefined} aria-hidden={!visible}
    data-dirty={doc?.dirty || undefined} className="flex h-full min-h-0 flex-col" style={{ display: visible ? "flex" : "none" }}
    onKeyDown={(event) => {
      const primary = getAppPlatform() === "macos" ? event.metaKey : event.ctrlKey;
      if (!event.defaultPrevented && !event.nativeEvent.isComposing && primary && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "s") {
        event.preventDefault(); save();
      }
    }}>
    <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-[var(--taomni-divider)] p-1.5">
      <input className="taomni-input h-7 min-w-20 flex-1 text-sm" data-testid="notes-workspace-title"
        aria-label={t("notes.titlePlaceholder")} placeholder={t("notes.titlePlaceholder")}
        value={doc?.title ?? ""} disabled={!doc}
        onChange={(event) => { if (doc) useNotesContentStore.getState().edit({ id: noteId, ...doc }, { title: event.target.value }); }} />
      <div role="group" aria-label={t("notes.previewMode")} className="flex items-center gap-0.5">
        {(["edit", "split", "preview"] as const).map((item) => <button key={item} type="button"
          className="taomni-btn h-7 px-2 text-xs" data-testid={`notes-workspace-mode-${item}`} aria-pressed={item === mode}
          onClick={() => { setMode(item); noteWorkspaceModes.set(noteId, item); }}>
          {t(`notes.${item}Mode`)}
        </button>)}
      </div>
      <button type="button" data-testid="notes-workspace-save" className="taomni-btn flex h-7 items-center gap-1 px-2 text-xs"
        disabled={!doc?.dirty || doc.saving || doc.error === "conflict" || doc.error === "missing"} onClick={save}>
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
    {note && <details className="shrink-0 border-b border-[var(--taomni-divider)]" data-testid="notes-workspace-properties">
      <summary className="cursor-pointer px-2 py-1 text-xs">{t("notes.taskDetails")} · {t(`notes.priority_${note.priority}`)}</summary>
      <div className="max-h-56 overflow-auto p-2 pr-4"><NoteTaskDetails key={note.id} note={note} prefix="notes-workspace" /></div>
    </details>}
    <NoteContentStatus noteId={noteId} />
    {!doc && <p className="p-3 text-xs">{t("notes.loading")}</p>}
    {doc && file && <div className="flex min-h-0 flex-1 overflow-hidden">
      {/* Retain the same editor view when switching preview modes: undo/selection survive. */}
      <div data-testid="notes-workspace-editor" className="min-h-0 min-w-0 flex-1"
        style={{ display: mode === "preview" ? "none" : undefined }}>
        <CodeMirrorHost path={path} fileKey={`note:${noteId}`} viewId={tab.id} doc={doc.body}
          visible={visible && mode !== "preview"} active={visible && mode !== "preview"}
          diagnostics={NO_DIAGNOSTICS} reveal={null} softWrap clipboardWorkspaceId={tab.workspaceId}
          onChange={changeBody} onSave={save} onHover={noHover} onDefinition={noDefinition} onReferences={noReferences}
          getCompletionIdentity={noCompletionIdentity} onCompletionDiagnostic={noCompletionDiagnostic} />
      </div>
      {mode !== "edit" && <div className="min-h-0 min-w-0 flex-1 border-l border-[var(--taomni-divider)]">
        <MarkdownPreview file={file} onOpenHref={openHref} />
      </div>}
    </div>}
    <div data-testid="notes-workspace-status" className="flex shrink-0 gap-3 border-t border-[var(--taomni-divider)] px-2 py-1 text-[11px] text-[var(--taomni-text-muted)]">
      <span>Markdown</span><span>{t(doc?.saving ? "notes.savingContent" : doc?.dirty ? "notes.modifiedContent" : "notes.savedContent")}</span>
      <span>{t("notes.sharedContent")}</span>
    </div>
  </div>;
}
