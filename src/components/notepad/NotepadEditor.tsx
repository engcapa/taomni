import { useEffect, useMemo, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { ChevronLeft, ChevronRight, Lock } from "lucide-react";
import { extractMarkedMatchesText } from "../../lib/notepad/cm6/marksAndTokens";
import { isImeComposing, useNotepadKeymap } from "../../lib/notepad/commands/keymap";
import { createHostContext, viewerTabHost } from "../../lib/notepad/host/viewerTabHost";
import { notepadListDirTextFiles } from "../../lib/notepad/ipc";
import {
  acceptTamperedMacros,
  loadValidatedMacros,
  runMacroOnce,
  saveMacrosList,
} from "../../lib/notepad/macro/macroManager";
import { NotepadBackupManager } from "../../lib/notepad/persistence/backupManager";
import { documentPathKey, isUntitledKey } from "../../lib/openFile/pathIdentity";
import type { ViewerDocument } from "../../lib/viewer";
import { useRecentFilesStore } from "../../stores/app/recentFiles";
import { useDocumentStore } from "../../stores/documentStore";
import { useNotepadPreferences } from "../../stores/notepadPreferences";
import { createDefaultDocState, useNotepadStore } from "../../stores/notepadStore";
import { useViewerLabels } from "../viewer/viewerLabels";
import { CompareOverlay } from "./dialogs/CompareOverlay";
import { PickerDialogs, type NotepadPickerDialog } from "./dialogs/PickerDialogs";
import { EditToolDialogs, type NotepadEditModalKind } from "./dialogs/EditToolDialogs";
import { EncodingDialog } from "./dialogs/EncodingDialog";
import { FileLifecycleDialogs, type NotepadLifecycleModal } from "./dialogs/FileLifecycleDialogs";
import { MacroDialogs, type NotepadMacroModalKind } from "./dialogs/MacroDialogs";
import { PreferencesDialog } from "./dialogs/PreferencesDialog";
import { PrintDialog } from "./dialogs/PrintDialog";
import { SessionBackupDialogs, type NotepadSessionModalKind } from "./dialogs/SessionBackupDialogs";
import { ShortcutMapperDialog } from "./dialogs/ShortcutMapperDialog";
import { ToolboxDialogs, type NotepadToolboxKind } from "./dialogs/ToolboxDialogs";
import { FindReplaceBar } from "./FindReplaceBar";
import { NotepadMenuBar } from "./NotepadMenuBar";
import { NotepadSplitPanes } from "./NotepadSplitPanes";
import { NotepadStatusBar } from "./NotepadStatusBar";
import { NotepadToolbar } from "./NotepadToolbar";
import { type CursorMetrics } from "./NotepadCodeMirrorPane";
import { FloatingPanels, PanelDockView } from "./panels/PanelHost";
import { useNotepadActions } from "./useNotepadActions";
import { rememberOpenWith } from "./actions/extraCommands";
import { openFile } from "../../lib/openFile";
import "./notepad.css";

export function NotepadEditor({
  document,
  host,
  workspaceId,
  onError,
  onCursorChange,
}: {
  document: ViewerDocument;
  host?: "explorer";
  workspaceId?: string;
  onError: (message: string | null) => void;
  onCursorChange: (cursor: { line: number; column: number }) => void;
}) {
  const label = useViewerLabels();
  const docKey = documentPathKey(document.path);
  const hostCtx = useMemo(() => createHostContext(host, workspaceId), [host, workspaceId]);
  const prefs = useNotepadPreferences();
  const store = useNotepadStore();
  const recentFiles = useRecentFilesStore((s) => s.recentFiles);

  const docState = store.docs[docKey] ?? createDefaultDocState(docKey);
  const effectiveReadOnly = document.readOnly || (document.large && !docState.largeEditConfirmed);

  const viewsRef = useRef<[EditorView | null, EditorView | null]>([null, null]);
  const [metrics, setMetrics] = useState<CursorMetrics>({
    line: 1,
    column: 1,
    offset: 0,
    selChars: 0,
    selLines: 0,
    from: 0,
    to: 0,
  });

  const [lifecycleModal, setLifecycleModal] = useState<NotepadLifecycleModal | null>(null);
  const [editModal, setEditModal] = useState<NotepadEditModalKind>(null);
  const [encodingOpen, setEncodingOpen] = useState(false);
  const [toolboxKind, setToolboxKind] = useState<NotepadToolboxKind>(null);
  const [macroModal, setMacroModal] = useState<NotepadMacroModalKind>(null);
  const [printOpen, setPrintOpen] = useState(false);
  const [sessionModal, setSessionModal] = useState<NotepadSessionModalKind>(null);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [mapperOpen, setMapperOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [findStatus, setFindStatus] = useState<string | null>(null);
  const [searchingFiles, setSearchingFiles] = useState(false);
  const [tamperInfo, setTamperInfo] = useState<{ expectedHash: string; actualHash: string } | null>(null);
  const [pickerModal, setPickerModal] = useState<NotepadPickerDialog>(null);

  const backupMgr = useMemo(
    () =>
      new NotepadBackupManager((targetDocId, backupState) => {
        useNotepadStore.getState().patchDoc(targetDocId, {
          backupState,
          lastBackupAt: backupState === "saved" ? Date.now() : undefined,
        });
      }),
    [],
  );

  useEffect(() => () => backupMgr.dispose(), [backupMgr]);

  useEffect(() => {
    useNotepadStore.getState().ensureDoc(docKey, docState.titleHint);
  }, [docKey, docState.titleHint]);

  // Trigger debounced disk backup when text document is dirty
  useEffect(() => {
    if (!document.dirty) return;
    backupMgr.scheduleDebouncedBackup({
      docId: docKey,
      path: isUntitledKey(document.path) ? null : document.path,
      name: docState.titleHint || document.path.split(/[\\/]/).pop() || "Untitled",
      content: document.content,
      encoding: document.encoding,
      bom: document.bom,
      eol: document.eol,
      savedHash: document.savedHash,
      dirty: document.dirty,
    });
  }, [
    backupMgr,
    docKey,
    docState.titleHint,
    document.dirty,
    document.path,
    document.content,
    document.encoding,
    document.bom,
    document.eol,
    document.savedHash,
  ]);

  // Periodic backup interval aligned with user preferences
  useEffect(() => {
    return backupMgr.startPeriodicBackup(prefs.backupSec, () => {
      const all = Object.values(useDocumentStore.getState().documents);
      return all
        .filter((d) => d.dirty && d.kind === "text")
        .map((d) => ({
          docId: d.key,
          path: isUntitledKey(d.path) ? null : d.path,
          name: useNotepadStore.getState().docs[d.key]?.titleHint || d.path.split(/[\\/]/).pop() || "Untitled",
          content: d.content,
          encoding: d.encoding,
          bom: d.bom,
          eol: d.eol,
          savedHash: d.savedHash,
          dirty: d.dirty,
        }));
    });
  }, [backupMgr, prefs.backupSec]);

  // Validate macro integrity on first load
  useEffect(() => {
    if (store.macro.loaded) return;
    void loadValidatedMacros()
      .then((res) => {
        useNotepadStore.getState().patchMacro({
          loaded: true,
          hash: res.actualHash,
          tampered: res.tampered,
          saved: res.macros.map((m) => ({
            name: m.name,
            key: m.shortcut,
            steps: m.steps.map((s) => ({ commandId: s.commandId ?? "", args: s.args })),
          })),
        });
        if (res.tampered) {
          setTamperInfo({ expectedHash: res.expectedHash, actualHash: res.actualHash });
          setMacroModal("tamper");
        }
      })
      .catch(() => useNotepadStore.getState().patchMacro({ loaded: true }));
  }, [store.macro.loaded]);

  const actions = useNotepadActions({
    docKey,
    document,
    docState,
    hostCtx,
    backupMgr,
    effectiveReadOnly,
    getActiveView: () => viewsRef.current[docState.activePane] ?? viewsRef.current[0],
    onError,
    setFindStatus,
    setSearchingFiles,
    setLifecycleModal,
    setEditModal,
    setEncodingOpen,
    setToolboxKind,
    setMacroModal,
    setPrintOpen,
    setSessionModal,
    setPrefsOpen,
    setMapperOpen,
    setAboutOpen,
    setPickerModal,
  });

  // Record commands when macro recording is active
  useEffect(() => {
    return actions.registry.onRecordStep((step) => {
      const m = useNotepadStore.getState().macro;
      if (!m.recording || step.type !== "command" || !step.commandId) return;
      useNotepadStore.getState().patchMacro({
        buffer: [...m.buffer, { commandId: step.commandId, args: step.args }],
      });
    });
  }, [actions.registry]);

  const savedLines = useMemo(() => document.savedContent.split("\n"), [document.savedContent]);
  const eolLabel: "LF" | "CRLF" | "CR" = document.eol === "CRLF" || document.eol === "CR" ? document.eol : "LF";
  const symbolConfig = useMemo(
    () => ({
      ...store.symbols,
      eolLabel,
      showRuler: prefs.showRuler,
      rulerCol: prefs.rulerCol,
      tabSize: 4,
    }),
    [store.symbols, eolLabel, prefs.showRuler, prefs.rulerCol],
  );
  const zoomPct = Math.round(((13 + store.zoomDelta) / 13) * 100);
  const effectiveFontSize = Math.max(8, Math.min(32, prefs.fontSize + store.zoomDelta));
  const allSymbolsOn = Object.values(store.symbols).every(Boolean);

  const activeHostDoc = viewerTabHost.getActiveDoc(hostCtx);
  const menuDocuments = viewerTabHost.listOpenDocs(hostCtx).map((hostDoc) => ({
    docKey: hostDoc.docKey,
    title: hostDoc.title || hostDoc.path?.split(/[\\/]/).pop() || hostDoc.docKey,
    active: activeHostDoc?.docKey === hostDoc.docKey,
  }));
  const menuChecks: Record<string, boolean> = {
    "view.wordWrap": prefs.wrap,
    "view.showWhitespace": store.symbols.space,
    "view.showTab": store.symbols.tab,
    "view.showEol": store.symbols.eol,
    "view.showNonPrinting": store.symbols.nonprint,
    "view.indentGuide": store.symbols.indent,
    "view.showAllSymbols": allSymbolsOn,
    "view.toggleSplit": docState.split,
    "view.toggleSyncV": docState.syncScroll,
    "view.toggleDocMap": store.panels.minimap.open,
    "view.toggleDocList": store.panels.doclist.open,
    "view.toggleCharPanel": store.panels.chars.open,
    "view.toggleSearchResults": store.panels.results.open,
    "view.toggleLineNumbers": prefs.showLineNumbers,
    "view.toggleRuler": prefs.showRuler,
    "view.toggleMenubar": store.ui.menubar,
    "view.toggleToolbar": store.ui.toolbar,
    "view.toggleStatusbar": store.ui.statusbar,
    "view.fullscreen": store.viewMode === "fullscreen",
    "view.postIt": store.viewMode === "postit",
    "view.distractionFree": store.viewMode === "focus",
    "edit.toggleChangeHistory": prefs.showChangeHistory,
    "edit.toggleOverwrite": !store.insertMode,
    "edit.toggleVirtualSpace": store.virtualSpace,
    "file.toggleReadonly": effectiveReadOnly,
    "macro.toggleRecord": store.macro.recording,
  };

  const selectionText = useMemo(() => {
    const v = viewsRef.current[docState.activePane] ?? viewsRef.current[0];
    if (!v || metrics.to <= metrics.from) return "";
    return v.state.sliceDoc(metrics.from, metrics.to);
  }, [docState.activePane, metrics.from, metrics.to]);

  const handleFolderDrop = async (paths: string[]) => {
    for (const p of paths) {
      try {
        const listed = await notepadListDirTextFiles(p, 20);
        if (listed.totalCandidates > 20 || listed.truncated) {
          setLifecycleModal({
            kind: "folderDrop",
            folder: p,
            totalCandidates: listed.totalCandidates,
            skippedBinary: listed.skippedBinary,
            files: listed.files,
          });
        } else {
          for (const f of listed.files) await viewerTabHost.openFile(f, hostCtx);
        }
      } catch {
        await viewerTabHost.openFile(p, hostCtx);
      }
    }
  };

  return (
    <div
      className={`np-workbench ${store.viewMode ? `np-mode-${store.viewMode}` : ""}`}
      data-testid="notepad-workbench"
      onKeyDown={(e) => {
        if (e.defaultPrevented || isImeComposing(e.nativeEvent)) return;
        // Design §4.2: every Notepad dialog closes on Esc and returns to the editor.
        if (e.key === "Escape" && !e.ctrlKey && !e.metaKey && !e.altKey) {
          if (pickerModal) { e.preventDefault(); e.stopPropagation(); setPickerModal(null); return; }
          if (lifecycleModal) { e.preventDefault(); e.stopPropagation(); setLifecycleModal(null); return; }
          if (editModal) { e.preventDefault(); e.stopPropagation(); setEditModal(null); return; }
          if (encodingOpen) { e.preventDefault(); e.stopPropagation(); setEncodingOpen(false); return; }
          if (toolboxKind) { e.preventDefault(); e.stopPropagation(); setToolboxKind(null); return; }
          if (macroModal) { e.preventDefault(); e.stopPropagation(); setMacroModal(null); return; }
          if (printOpen) { e.preventDefault(); e.stopPropagation(); setPrintOpen(false); return; }
          if (sessionModal) { e.preventDefault(); e.stopPropagation(); setSessionModal(null); return; }
          if (prefsOpen) { e.preventDefault(); e.stopPropagation(); setPrefsOpen(false); return; }
          if (mapperOpen) { e.preventDefault(); e.stopPropagation(); setMapperOpen(false); return; }
          if (store.compare) { e.preventDefault(); e.stopPropagation(); store.setCompare(null); return; }
          if (aboutOpen) { e.preventDefault(); e.stopPropagation(); setAboutOpen(false); return; }
        }
        const target = e.target as HTMLElement | null;
        if (target?.closest(".np-modal, .np-find-bar") && target.tagName === "INPUT") return;
        const cmd = useNotepadKeymap.getState().findCommandByEvent(e.nativeEvent);
        // Delete is advertised as the Edit > Delete accelerator, but the plain
        // key must stay a native forward-delete inside the editor. The menu item
        // still works through the command registry.
        const plainDelete = e.key === "Delete" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
        if (cmd && !plainDelete) {
          e.preventDefault();
          e.stopPropagation();
          void actions.registry.execute(cmd);
        }
      }}
      onDrop={(e) => {
        const dropped = Array.from(e.dataTransfer?.files ?? []).map((f) => (f as File & { path?: string }).path).filter((p): p is string => Boolean(p));
        if (dropped.length > 0) {
          e.preventDefault();
          void handleFolderDrop(dropped);
        }
      }}
    >
      <FloatingPanels
        activeDocKey={docKey}
        content={document.content}
        primaryView={viewsRef.current[0]}
        onInsertChar={(ch) => void actions.sessionAndMacroHelpers.insertChar(ch)}
        onSelectDoc={(doc) => viewerTabHost.activateDoc(doc.docKey, { host: doc.host, workspaceId: doc.workspaceId })}
        onCloseDoc={(doc) => viewerTabHost.closeDoc(doc.docKey, { host: doc.host, workspaceId: doc.workspaceId })}
        onJumpHit={(hit) => {
          if (hit.docId === docKey || hit.filePath === document.path) actions.jumpToOffset(hit.from, hit.from + hit.matchLength);
          else if (hit.filePath) void viewerTabHost.openFile(hit.filePath, hostCtx);
          else if (hit.docId) viewerTabHost.activateDoc(hit.docId, hostCtx);
        }}
      />
      {store.ui.menubar && (
        <NotepadMenuBar
          dirty={document.dirty}
          readOnly={effectiveReadOnly}
          recordingMacro={store.macro.recording}
          recordedSteps={store.macro.buffer.length}
          hasRecordedBuffer={store.macro.buffer.length > 0}
          recentFiles={recentFiles.map((r) => r.path)}
          savedMacros={store.macro.saved.map((m) => ({ name: m.name, shortcut: m.key }))}
          documents={menuDocuments}
          checks={menuChecks}
          capabilities={{ pinTabs: true }}
          onCommand={(id) => void actions.registry.execute(id)}
          onOpenRecent={(path) => void viewerTabHost.openFile(path, hostCtx)}
          onOpenAllRecent={() => void actions.registry.execute("file.openAllRecentFiles")}
          onClearRecent={() => void actions.registry.execute("file.clearRecentFiles")}
          onOpenSavedMacro={(name) => {
            const macro = useNotepadStore.getState().macro.saved.find((m) => m.name === name);
            if (macro) void actions.sessionAndMacroHelpers.runMulti("times", 1);
          }}
          onValidateMacros={() => void actions.registry.execute("tools.validateMacros")}
          onActivateDocument={(docKey) => viewerTabHost.activateDoc(docKey, hostCtx)}
        />
      )}

      {store.ui.toolbar && (
        <NotepadToolbar
          dirty={document.dirty}
          readOnly={effectiveReadOnly}
          large={document.large}
          saving={document.saving}
          wrap={prefs.wrap}
          allSymbols={allSymbolsOn}
          split={docState.split}
          panels={{
            minimap: store.panels.minimap.open,
            doclist: store.panels.doclist.open,
            chars: store.panels.chars.open,
          }}
          recordingMacro={store.macro.recording}
          onCommand={(id) => void actions.registry.execute(id)}
        />
      )}

      {document.large && !docState.largeEditConfirmed && (
        <div className="fv-banner info" data-testid="viewer-large-file">
          <Lock size={14} />
          <span>
            {label(
              `大文件只读分段预览（${(document.size / 1024 / 1024).toFixed(1)} MB）`,
              `Large file read-only chunk preview (${(document.size / 1024 / 1024).toFixed(1)} MB)`,
            )}
          </span>
          <span className="fv-spacer" />
          <button
            type="button"
            className="fv-button outline"
            data-testid="viewer-chunk-prev"
            disabled={document.chunkOffset <= 0}
            onClick={() => void useDocumentStore.getState().readChunk(document.path, Math.max(0, document.chunkOffset - 256 * 1024))}
          >
            <ChevronLeft size={13} />
            {label("上一段", "Prev")}
          </button>
          <button
            type="button"
            className="fv-button outline"
            data-testid="viewer-chunk-next"
            disabled={document.eof}
            onClick={() => void useDocumentStore.getState().readChunk(document.path, document.nextOffset)}
          >
            {label("下一段", "Next")}
            <ChevronRight size={13} />
          </button>
        </div>
      )}

      <FindReplaceBar
        find={docState.find}
        statusText={findStatus}
        searchingFiles={searchingFiles}
        onPatch={(patch) => store.patchFind(docKey, patch)}
        onFindNext={actions.searchActions.findNext}
        onFindPrev={actions.searchActions.findPrev}
        onCount={actions.searchActions.count}
        onFindAllCurrent={actions.searchActions.findAllCurrent}
        onFindAllOpen={actions.searchActions.findAllOpen}
        onReplaceOne={actions.searchActions.replaceOne}
        onReplaceAll={actions.searchActions.replaceAll}
        onReplaceAllOpen={actions.searchActions.replaceAllOpen}
        onFindInFiles={() => void actions.searchActions.findInFiles()}
        onCancelFindInFiles={actions.searchActions.cancelFindInFiles}
        onReplaceInFiles={() => void actions.searchActions.replaceInFiles()}
        onMarkAll={actions.searchActions.markAll}
        onClearMarks={() => store.clearMarks(docKey)}
        onCopyMarked={() => {
          const txt = extractMarkedMatchesText(document.content, docState.marks);
          void navigator.clipboard?.writeText(txt).catch(() => undefined);
        }}
        onClose={() => store.patchFind(docKey, { open: false })}
      />

      <div className="np-main-area">
        <div className="np-editor-column">
          <NotepadSplitPanes
            split={docState.split}
            orient={docState.orient}
            syncScroll={docState.syncScroll}
            activePane={docState.activePane}
            content={document.content}
            savedLines={savedLines}
            readOnly={effectiveReadOnly}
            wrap={prefs.wrap}
            showLineNumbers={prefs.showLineNumbers}
            fontSizePx={effectiveFontSize}
            insertMode={store.insertMode}
            virtualSpace={store.virtualSpace}
            showChangeHistory={prefs.showChangeHistory}
            symbols={symbolConfig}
            bookmarks={docState.bookmarks}
            marks={docState.marks}
            activeMatch={docState.activeMatch}
            onChange={(nextText) => useDocumentStore.getState().edit(document.path, nextText)}
            onCursorMetrics={(_pane, nextMetrics) => {
              setMetrics(nextMetrics);
              onCursorChange({ line: nextMetrics.line, column: nextMetrics.column });
            }}
            onToggleBookmark={(ln0) => store.toggleBookmark(docKey, ln0)}
            onToggleInsertMode={(ins) => store.setInsertMode(ins)}
            onFocusPane={(pane) => store.patchDoc(docKey, { activePane: pane })}
            onViewsChanged={(views) => { viewsRef.current = views; }}
          />
          <PanelDockView
            side="bottom"
            activeDocKey={docKey}
            content={document.content}
            primaryView={viewsRef.current[0]}
            onInsertChar={(ch) => void actions.sessionAndMacroHelpers.insertChar(ch)}
            onSelectDoc={(doc) => viewerTabHost.activateDoc(doc.docKey, { host: doc.host, workspaceId: doc.workspaceId })}
            onCloseDoc={(doc) => viewerTabHost.closeDoc(doc.docKey, { host: doc.host, workspaceId: doc.workspaceId })}
            onJumpHit={(hit) => {
              if (hit.docId === docKey || hit.filePath === document.path) {
                actions.jumpToOffset(hit.from, hit.from + hit.matchLength);
              } else if (hit.filePath) {
                void viewerTabHost.openFile(hit.filePath, hostCtx);
              } else if (hit.docId) {
                viewerTabHost.activateDoc(hit.docId, hostCtx);
              }
            }}
          />
        </div>

        <PanelDockView
          side="right"
          activeDocKey={docKey}
          content={document.content}
          primaryView={viewsRef.current[0]}
          onInsertChar={(ch) => void actions.sessionAndMacroHelpers.insertChar(ch)}
          onSelectDoc={(doc) => viewerTabHost.activateDoc(doc.docKey, { host: doc.host, workspaceId: doc.workspaceId })}
          onCloseDoc={(doc) => viewerTabHost.closeDoc(doc.docKey, { host: doc.host, workspaceId: doc.workspaceId })}
          onJumpHit={(hit) => {
            if (hit.docId === docKey) actions.jumpToOffset(hit.from, hit.from + hit.matchLength);
          }}
        />
      </div>

      {store.ui.statusbar && (
        <NotepadStatusBar
          length={document.content.length}
          lines={document.content.split("\n").length}
          cursorLine={metrics.line}
          cursorColumn={metrics.column}
          selChars={metrics.selChars}
          selLines={metrics.selLines}
          eol={eolLabel}
          encoding={document.encoding}
          bom={document.bom}
          insertMode={store.insertMode}
          readOnly={effectiveReadOnly}
          remote={Boolean(document.readOnlyReason)}
          recording={store.macro.recording}
          backupIntervalSec={prefs.backupSec}
          lastBackupAt={docState.lastBackupAt}
          zoomPct={zoomPct}
          backupState={docState.backupState ?? "idle"}
          onCycleEol={() => void actions.sessionAndMacroHelpers.cycleEol()}
          onOpenEncoding={() => setEncodingOpen(true)}
          onToggleInsertMode={() => store.setInsertMode(!store.insertMode)}
          onToggleReadonly={() => void actions.registry.execute("file.toggleReadonly")}
          onResetZoom={() => store.setZoomDelta(0)}
        />
      )}

      <FileLifecycleDialogs
        modal={lifecycleModal}
        onClose={() => setLifecycleModal(null)}
        onSaveAs={actions.handleSaveAs}
        onRename={actions.handleRename}
        onTrash={actions.handleTrash}
        onElevatedSave={actions.handleElevatedSave}
        onOpenFolderFiles={async (files) => {
          for (const f of files) await viewerTabHost.openFile(f, hostCtx);
        }}
      />

      <EditToolDialogs
        kind={editModal}
        currentLine={metrics.line}
        totalLines={document.content.split("\n").length}
        currentOffset={metrics.offset}
        totalLength={document.content.length}
        onClose={() => setEditModal(null)}
        onGoTo={(mode, val) => {
          const v = viewsRef.current[docState.activePane] ?? viewsRef.current[0];
          if (!v) return;
          if (mode === "line") {
            const ln = Math.max(1, Math.min(val, v.state.doc.lines));
            actions.jumpToOffset(v.state.doc.line(ln).from);
          } else {
            actions.jumpToOffset(Math.max(0, Math.min(val, v.state.doc.length)));
          }
        }}
        onApplyColumn={actions.applyColumnSpec}
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
        onApplyText={(nextText, onlySel) => {
          if (!effectiveReadOnly) actions.replaceViewSelection(viewsRef.current[0], nextText, onlySel);
        }}
      />

      <MacroDialogs
        kind={macroModal}
        macros={store.macro.saved.map((m) => ({ name: m.name, shortcut: m.key, steps: m.steps.map((s) => ({ type: "command", commandId: s.commandId, args: s.args })) }))}
        tamperInfo={tamperInfo}
        onClose={() => setMacroModal(null)}
        onSaveNamed={actions.sessionAndMacroHelpers.saveNamedMacro}
        onRunMulti={actions.sessionAndMacroHelpers.runMulti}
        onDeleteMacro={actions.sessionAndMacroHelpers.deleteMacro}
        onRenameMacro={actions.sessionAndMacroHelpers.renameMacro}
        onRunSavedMacro={(m) =>
          runMacroOnce(m.steps, {
            executeCommand: async (id, args) => { await actions.registry.execute(id, args, { skipRecord: true }); },
            insertText: (txt) => actions.sessionAndMacroHelpers.insertChar(txt),
            getCursorAndLength: () => {
              const v = viewsRef.current[0];
              return v ? { pos: v.state.selection.main.head, length: v.state.doc.length } : { pos: 0, length: 0 };
            },
          })
        }
        onAcceptTampered={async () => {
          await acceptTamperedMacros();
          store.patchMacro({ tampered: false });
        }}
        onResetMacros={async () => {
          await saveMacrosList([]);
          store.patchMacro({ saved: [], tampered: false });
        }}
      />

      <CompareOverlay
        compare={store.compare}
        onPatch={(patch) => store.setCompare(store.compare ? { ...store.compare, ...patch } : null)}
        onClose={() => store.setCompare(null)}
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
        onSaveSession={actions.sessionAndMacroHelpers.saveSession}
        onLoadSession={actions.sessionAndMacroHelpers.loadSession}
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
          if (mode === "taoffice") return;
          void openFile({ path: document.path }, { context: "notepad", mode }).catch((error) => onError(String(error)));
        }}
        onRememberHandler={(mode) => rememberOpenWith(document.path, mode)}
        onPaste={(text, kind) => {
          if (!text || effectiveReadOnly) return;
          const view = viewsRef.current[docState.activePane] ?? viewsRef.current[0];
          if (!view) return;
          const sel = view.state.selection.main;
          const value = kind === "binary" ? text : text.replace(/\0/g, "");
          view.dispatch({ changes: { from: sel.from, to: sel.to, insert: value }, selection: { anchor: sel.from + value.length } });
        }}
        onInsertText={(text) => actions.sessionAndMacroHelpers.insertChar(text)}
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
        readClipboard={() => navigator.clipboard?.readText().catch(() => "") ?? Promise.resolve("")}
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
    </div>
  );
}
