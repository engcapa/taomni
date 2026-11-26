import { useEffect, useRef } from "react";
import type { NotepadHostContext } from "../../lib/notepad/host/types";
import { acceptTamperedMacros, normalizeMacroSteps, saveMacrosList, type SavedMacroEntry } from "../../lib/notepad/macro/macroManager";
import { viewerTabHost } from "../../lib/notepad/host/viewerTabHost";
import { openFile } from "../../lib/openFile";
import { readPasteText } from "../../lib/clipboard";
import { isUntitledKey } from "../../lib/openFile/pathIdentity";
import type { ViewerDocument } from "../../lib/viewer";
import { useDocumentStore } from "../../stores/documentStore";
import { setNotepadPreferences } from "../../stores/notepadPreferences";
import { useNotepadStore, type NotepadCompareState, type NotepadDocState } from "../../stores/notepadStore";
import { useViewerLabels } from "../viewer/viewerLabels";
import { rememberOpenWith } from "./actions/extraCommands";
import { CompareOverlay } from "./dialogs/CompareOverlay";
import { EditToolDialogs, type NotepadEditModalKind } from "./dialogs/EditToolDialogs";
import { EncodingDialog } from "./dialogs/EncodingDialog";
import { FileLifecycleDialogs, type NotepadLifecycleModal } from "./dialogs/FileLifecycleDialogs";
import { MacroDialogs, type NotepadMacroModalKind } from "./dialogs/MacroDialogs";
import { PickerDialogs, type NotepadPickerDialog } from "./dialogs/PickerDialogs";
import { PreferencesDialog } from "./dialogs/PreferencesDialog";
import { PrintDialog } from "./dialogs/PrintDialog";
import { SessionBackupDialogs, type NotepadSessionModalKind } from "./dialogs/SessionBackupDialogs";
import { ShortcutMapperDialog } from "./dialogs/ShortcutMapperDialog";
import { ToolboxDialogs, type NotepadToolboxKind } from "./dialogs/ToolboxDialogs";

export function NotepadDialogsHost({
  document,
  docState,
  hostCtx,
  effectiveReadOnly,
  selectionText,
  currentLine,
  currentOffset,
  lifecycleModal,
  setLifecycleModal,
  editModal,
  setEditModal,
  encodingOpen,
  setEncodingOpen,
  toolboxKind,
  setToolboxKind,
  macroModal,
  setMacroModal,
  printOpen,
  setPrintOpen,
  sessionModal,
  setSessionModal,
  prefsOpen,
  setPrefsOpen,
  mapperOpen,
  setMapperOpen,
  pickerModal,
  setPickerModal,
  aboutOpen,
  setAboutOpen,
  compare,
  tamperInfo,
  savedMacros,
  onError,
  onSaveAs,
  onRename,
  onTrash,
  onElevatedSave,
  onGoTo,
  onApplyColumn,
  onApplyToolboxText,
  onSaveNamedMacro,
  onRunMultiMacro,
  onDeleteMacro,
  onRenameMacro,
  onRunSavedMacro,
  onSaveSession,
  onLoadSession,
  onPasteSpecial,
  onInsertText,
  onReturnFocus,
}: {
  document: ViewerDocument;
  docState: NotepadDocState;
  hostCtx: NotepadHostContext;
  effectiveReadOnly: boolean;
  selectionText: string;
  currentLine: number;
  currentOffset: number;
  lifecycleModal: NotepadLifecycleModal | null;
  setLifecycleModal: (m: NotepadLifecycleModal | null) => void;
  editModal: NotepadEditModalKind;
  setEditModal: (k: NotepadEditModalKind) => void;
  encodingOpen: boolean;
  setEncodingOpen: (v: boolean) => void;
  toolboxKind: NotepadToolboxKind;
  setToolboxKind: (k: NotepadToolboxKind) => void;
  macroModal: NotepadMacroModalKind;
  setMacroModal: (k: NotepadMacroModalKind) => void;
  printOpen: boolean;
  setPrintOpen: (v: boolean) => void;
  sessionModal: NotepadSessionModalKind;
  setSessionModal: (k: NotepadSessionModalKind) => void;
  prefsOpen: boolean;
  setPrefsOpen: (v: boolean) => void;
  mapperOpen: boolean;
  setMapperOpen: (v: boolean) => void;
  pickerModal: NotepadPickerDialog;
  setPickerModal: (m: NotepadPickerDialog) => void;
  aboutOpen: boolean;
  setAboutOpen: (v: boolean) => void;
  compare: NotepadCompareState | null;
  tamperInfo: { expectedHash: string; actualHash: string } | null;
  savedMacros: Array<{ name: string; key?: string; steps: Parameters<typeof normalizeMacroSteps>[0] }>;
  onError: (msg: string | null) => void;
  onSaveAs: (path: string, overwrite: boolean, copy?: boolean) => Promise<void>;
  onRename: (newName: string) => Promise<void>;
  onTrash: () => Promise<void>;
  onElevatedSave: () => Promise<void>;
  onGoTo: (mode: "line" | "offset", val: number) => void;
  onApplyColumn: Parameters<typeof EditToolDialogs>[0]["onApplyColumn"];
  onApplyToolboxText: (nextText: string, onlySel: boolean) => void;
  onSaveNamedMacro: (name: string, shortcut?: string) => Promise<void>;
  onRunMultiMacro: (mode: "times" | "eof", count: number) => Promise<void>;
  onDeleteMacro: (name: string) => Promise<void>;
  onRenameMacro: (oldName: string, newName: string) => Promise<void>;
  onRunSavedMacro: (macro: SavedMacroEntry) => Promise<void>;
  onSaveSession: (filePath?: string | null) => Promise<string>;
  onLoadSession: (filePath?: string | null) => Promise<void>;
  onPasteSpecial: (text: string, kind: "plain" | "html" | "rtf" | "binary") => void;
  onInsertText: (text: string) => Promise<void> | void;
  onReturnFocus: () => void;
}) {
  const label = useViewerLabels();
  const anyModalOpen = Boolean(
    lifecycleModal ||
    editModal ||
    encodingOpen ||
    toolboxKind ||
    macroModal ||
    printOpen ||
    sessionModal ||
    prefsOpen ||
    mapperOpen ||
    pickerModal ||
    aboutOpen ||
    compare?.open,
  );
  const wasOpenRef = useRef(anyModalOpen);
  useEffect(() => {
    if (wasOpenRef.current && !anyModalOpen) {
      queueMicrotask(() => onReturnFocus());
    }
    wasOpenRef.current = anyModalOpen;
  }, [anyModalOpen, onReturnFocus]);

  return (
    <>
      <FileLifecycleDialogs
        modal={lifecycleModal}
        onClose={() => setLifecycleModal(null)}
        onSaveAs={onSaveAs}
        onRename={onRename}
        onTrash={onTrash}
        onElevatedSave={onElevatedSave}
        onOpenFolderFiles={async (files) => {
          for (const f of files) await viewerTabHost.openFile(f, hostCtx);
        }}
        onDisableWholeDocPrompt={() => setNotepadPreferences({ askWholeDocLineOp: false })}
      />

      <EditToolDialogs
        kind={editModal}
        currentLine={currentLine}
        totalLines={document.content.split("\n").length}
        currentOffset={currentOffset}
        totalLength={document.content.length}
        onClose={() => setEditModal(null)}
        onGoTo={onGoTo}
        onApplyColumn={onApplyColumn}
      />

      <EncodingDialog
        open={encodingOpen}
        currentEncoding={document.encoding === "UTF-8" && document.bom ? "UTF-8 BOM" : document.encoding}
        canReopenFromDisk={!isUntitledKey(document.path)}
        content={document.content}
        onClose={() => setEncodingOpen(false)}
        onReopenAs={(enc) => useDocumentStore.getState().reload(document.path, enc)}
        onConvertTo={(enc) => {
          const isBom = enc.toUpperCase() === "UTF-8 BOM";
          useDocumentStore.getState().configure(document.path, {
            encoding: isBom ? "UTF-8" : enc,
            bom: isBom,
          });
        }}
      />

      <ToolboxDialogs
        kind={toolboxKind}
        documentText={document.content}
        selectionText={selectionText}
        filePath={isUntitledKey(document.path) ? null : document.path}
        onClose={() => setToolboxKind(null)}
        onApplyText={onApplyToolboxText}
      />

      <MacroDialogs
        kind={macroModal}
        macros={savedMacros.map((m) => ({ name: m.name, shortcut: m.key, steps: normalizeMacroSteps(m.steps) }))}
        tamperInfo={tamperInfo}
        onClose={() => setMacroModal(null)}
        onSaveNamed={onSaveNamedMacro}
        onRunMulti={onRunMultiMacro}
        onDeleteMacro={onDeleteMacro}
        onRenameMacro={onRenameMacro}
        onRunSavedMacro={onRunSavedMacro}
        onAcceptTampered={async () => {
          await acceptTamperedMacros();
          useNotepadStore.getState().patchMacro({ tampered: false });
        }}
        onResetMacros={async () => {
          await saveMacrosList([]);
          useNotepadStore.getState().patchMacro({ saved: [], tampered: false });
        }}
      />

      <CompareOverlay
        compare={compare}
        onPatch={(patch) => {
          const cur = useNotepadStore.getState().compare;
          useNotepadStore.getState().setCompare(cur ? { ...cur, ...patch } : null);
        }}
        onClose={() => useNotepadStore.getState().setCompare(null)}
      />

      <PrintDialog
        open={printOpen}
        title={docState.titleHint || document.path}
        content={document.content}
        selection={selectionText}
        onClose={() => setPrintOpen(false)}
      />

      <SessionBackupDialogs
        kind={sessionModal}
        onClose={() => setSessionModal(null)}
        onSaveSession={onSaveSession}
        onLoadSession={onLoadSession}
        onRestoreBackup={(entry, restoredContent) => {
          if (entry.path) {
            void viewerTabHost.openFile(entry.path, hostCtx).then(() => {
              useDocumentStore.getState().applyRestoredBackup(entry.path!, {
                content: restoredContent,
                encoding: entry.encoding,
                bom: entry.bom,
                eol: entry.eol as "LF" | "CRLF" | "CR",
                savedHash: entry.savedHash,
              });
            });
          } else {
            viewerTabHost.openUntitled(hostCtx, restoredContent);
          }
        }}
      />

      <PreferencesDialog open={prefsOpen} onClose={() => setPrefsOpen(false)} />
      <ShortcutMapperDialog open={mapperOpen} onClose={() => setMapperOpen(false)} />

      <PickerDialogs
        modal={pickerModal}
        onClose={() => setPickerModal(null)}
        onOpenWith={(mode) => {
          setPickerModal(null);
          void openFile({ path: document.path }, { context: "notepad", mode }).catch((error) => onError(String(error)));
        }}
        onRememberHandler={(mode) => rememberOpenWith(document.path, mode)}
        onPaste={(text, kind) => {
          if (!text || effectiveReadOnly) return;
          onPasteSpecial(text, kind);
        }}
        onInsertText={onInsertText}
        onCompare={(leftTitle, leftContent) => {
          useNotepadStore.getState().setCompare({
            open: true,
            leftTitle,
            leftContent,
            rightTitle: docState.titleHint || document.path,
            rightContent: document.content,
            ignoreWhitespace: false,
            ignoreCase: false,
          });
        }}
        readClipboard={() => readPasteText().catch(() => "")}
      />

      {aboutOpen && (
        <div className="np-modal-backdrop" role="dialog" aria-modal="true" data-testid="notepad-about-dialog">
          <div className="np-modal">
            <div className="np-modal-header">
              <span>Taomni Notepad</span>
              <button type="button" className="np-btn" onClick={() => setAboutOpen(false)}>×</button>
            </div>
            <p className="text-[12px]">
              {label(
                "Taomni 原生多文档记事本工作台：支持列块编辑、宏录制、定期磁盘备份与多编码无损转换。",
                "Taomni native Notepad workbench: column selection, recorded macros, disk backups, and safe multi-encoding editing.",
              )}
            </p>
            <div className="flex justify-end">
              <button type="button" className="np-btn primary" onClick={() => setAboutOpen(false)}>{label("关闭", "Close")}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
