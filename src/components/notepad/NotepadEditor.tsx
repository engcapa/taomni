import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { ChevronLeft, ChevronRight, Lock } from "lucide-react";
import { extractMarkedMatchesText, type FindHighlightSpec } from "../../lib/notepad/cm6/marksAndTokens";
import { isImeComposing, useNotepadKeymap } from "../../lib/notepad/commands/keymap";
import { createHostContext, viewerTabHost } from "../../lib/notepad/host/viewerTabHost";
import { notepadListDirTextFiles } from "../../lib/notepad/ipc";
import { loadValidatedMacros, normalizeMacroSteps } from "../../lib/notepad/macro/macroManager";
import { NotepadBackupManager } from "../../lib/notepad/persistence/backupManager";
import { documentPathKey, isUntitledKey } from "../../lib/openFile/pathIdentity";
import { writeText } from "../../lib/clipboard";
import { VIEWER_TEXT_HARD_LIMIT, type ViewerDocument } from "../../lib/viewer";
import { useRecentFilesStore } from "../../stores/app/recentFiles";
import { useDocumentStore } from "../../stores/documentStore";
import { useNotepadPreferences } from "../../stores/notepadPreferences";
import { createDefaultDocState, useNotepadStore, type NotepadSearchResultHit } from "../../stores/notepadStore";
import { useViewerLabels } from "../viewer/viewerLabels";
import type { NotepadEditModalKind } from "./dialogs/EditToolDialogs";
import type { NotepadLifecycleModal } from "./dialogs/FileLifecycleDialogs";
import type { NotepadMacroModalKind } from "./dialogs/MacroDialogs";
import type { NotepadPickerDialog } from "./dialogs/PickerDialogs";
import type { NotepadSessionModalKind } from "./dialogs/SessionBackupDialogs";
import type { NotepadToolboxKind } from "./dialogs/ToolboxDialogs";
import { FindReplaceBar } from "./FindReplaceBar";
import { type CursorMetrics } from "./NotepadCodeMirrorPane";
import { NotepadContextMenu, type NotepadContextMenuRequest } from "./NotepadContextMenu";
import { NotepadDialogsHost } from "./NotepadDialogsHost";
import { NotepadMenuBar } from "./NotepadMenuBar";
import { NotepadSplitPanes } from "./NotepadSplitPanes";
import { NotepadStatusBar } from "./NotepadStatusBar";
import { NotepadToolbar } from "./NotepadToolbar";
import { FloatingPanels, PanelDockView } from "./panels/PanelHost";
import { useNotepadActions } from "./useNotepadActions";
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
  const [contextMenuRequest, setContextMenuRequest] = useState<NotepadContextMenuRequest | null>(null);

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
            steps: normalizeMacroSteps(m.steps),
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

  // Record commands and user text inserts when macro recording is active
  useEffect(() => {
    return actions.registry.onRecordStep((step) => {
      const m = useNotepadStore.getState().macro;
      if (!m.recording) return;
      if (step.type === "insertText" && step.text) {
        const prev = m.buffer[m.buffer.length - 1];
        if (prev && prev.type === "insertText") {
          const updated = [...m.buffer];
          updated[updated.length - 1] = { type: "insertText", text: `${prev.text ?? ""}${step.text}` };
          useNotepadStore.getState().patchMacro({ buffer: updated });
        } else {
          useNotepadStore.getState().patchMacro({
            buffer: [...m.buffer, { type: "insertText", text: step.text }],
          });
        }
        return;
      }
      if (step.type === "command" && step.commandId) {
        useNotepadStore.getState().patchMacro({
          buffer: [...m.buffer, { type: "command", commandId: step.commandId, args: step.args }],
        });
      }
    });
  }, [actions.registry]);

  // Reset cleared change-history baseline whenever disk saved content updates (save / reload / keepMine)
  const prevSavedContentRef = useRef(document.savedContent);
  useEffect(() => {
    if (prevSavedContentRef.current !== document.savedContent) {
      prevSavedContentRef.current = document.savedContent;
      if (useNotepadStore.getState().docs[docKey]?.changeHistoryBaseline !== null) {
        useNotepadStore.getState().patchDoc(docKey, { changeHistoryBaseline: null });
      }
    }
  }, [docKey, document.savedContent]);

  // Apply external activeMatch jump when a panel activates/targets this document
  useEffect(() => {
    const match = docState.activeMatch;
    if (!match) return;
    const v = viewsRef.current[docState.activePane] ?? viewsRef.current[0];
    if (!v) return;
    const sel = v.state.selection.main;
    const from = Math.max(0, Math.min(match.from, v.state.doc.length));
    const to = Math.max(from, Math.min(match.to, v.state.doc.length));
    if (sel.from !== from || sel.to !== to) {
      v.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
    }
  }, [docState.activeMatch, docState.activePane]);

  const savedLines = useMemo(
    () => docState.changeHistoryBaseline ?? document.savedContent.split("\n"),
    [docState.changeHistoryBaseline, document.savedContent],
  );
  const findHighlight: FindHighlightSpec | null = useMemo(
    () =>
      docState.find.open && docState.find.highlightAll && docState.find.query
        ? {
            query: docState.find.query,
            mode: docState.find.mode,
            caseSensitive: docState.find.caseSensitive,
            wholeWord: docState.find.wholeWord,
            dotAll: docState.find.dotAll,
          }
        : null,
    [
      docState.find.open,
      docState.find.highlightAll,
      docState.find.query,
      docState.find.mode,
      docState.find.caseSensitive,
      docState.find.wholeWord,
      docState.find.dotAll,
    ],
  );
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
    "view.toggleSyncV": docState.syncScrollV,
    "view.toggleSyncH": docState.syncScrollH,
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

  const focusActiveEditor = useCallback(() => {
    const active = viewsRef.current[useNotepadStore.getState().docs[docKey]?.activePane ?? 0] ?? viewsRef.current[0];
    active?.focus();
  }, [docKey]);

  const handleJumpSearchHit = (hit: NotepadSearchResultHit) => {
    if (hit.docId === docKey || hit.filePath === document.path) {
      actions.jumpToOffset(hit.from, hit.from + hit.matchLength);
      return;
    }
    const targetKey = hit.docId || (hit.filePath ? documentPathKey(hit.filePath) : "");
    if (targetKey) {
      const span = { from: hit.from, to: hit.from + hit.matchLength };
      useNotepadStore.getState().patchDoc(targetKey, {
        activeMatch: span,
        paneSelections: [span, { from: 0, to: 0 }],
      });
    }
    if (hit.filePath) {
      void viewerTabHost.openFile(hit.filePath, hostCtx);
    } else if (hit.docId) {
      viewerTabHost.activateDoc(hit.docId, hostCtx);
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
          if (store.viewMode) {
            e.preventDefault();
            e.stopPropagation();
            store.setViewMode("");
            queueMicrotask(focusActiveEditor);
            return;
          }
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
      onDragOver={(e) => {
        if (e.dataTransfer?.types?.includes("Files")) {
          e.preventDefault();
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
      {store.viewMode && (
        <button
          type="button"
          className="np-exit-view-mode"
          data-testid="notepad-exit-view-mode"
          onClick={() => {
            store.setViewMode("");
            queueMicrotask(focusActiveEditor);
          }}
        >
          {label("退出当前视图 (Esc)", "Exit View Mode (Esc)")}
        </button>
      )}
      <FloatingPanels
        activeDocKey={docKey}
        content={document.content}
        primaryView={viewsRef.current[0]}
        onInsertChar={(ch) => void actions.sessionAndMacroHelpers.insertChar(ch)}
        onSelectDoc={(doc) => viewerTabHost.activateDoc(doc.docKey, { host: doc.host, workspaceId: doc.workspaceId })}
        onCloseDoc={(doc) => viewerTabHost.closeDoc(doc.docKey, { host: doc.host, workspaceId: doc.workspaceId })}
        onJumpHit={handleJumpSearchHit}
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
          capabilities={{ pinTabs: hostCtx.host !== "workspace" }}
          onCommand={(id) => void actions.registry.execute(id)}
          onOpenRecent={(path) => void viewerTabHost.openFile(path, hostCtx)}
          onOpenAllRecent={() => void actions.registry.execute("file.openAllRecentFiles")}
          onClearRecent={() => void actions.registry.execute("file.clearRecentFiles")}
          onOpenSavedMacro={(name) => {
            const macro = useNotepadStore.getState().macro.saved.find((m) => m.name === name);
            if (macro) void actions.sessionAndMacroHelpers.runSavedMacro(macro);
          }}
          onValidateMacros={() => void actions.registry.execute("tools.validateMacros")}
          onActivateDocument={(targetDocKey) => viewerTabHost.activateDoc(targetDocKey, hostCtx)}
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
          syncScroll={docState.syncScrollV || docState.syncScrollH}
          hasRecordedBuffer={store.macro.buffer.length > 0}
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
            {document.size <= VIEWER_TEXT_HARD_LIMIT
              ? label(
                  `大文件只读分段预览（${(document.size / 1024 / 1024).toFixed(1)} MB）`,
                  `Large file read-only chunk preview (${(document.size / 1024 / 1024).toFixed(1)} MB)`,
                )
              : label(
                  `超大文件仅支持只读分段预览（${(document.size / 1024 / 1024).toFixed(1)} MB，超过 20 MB 编辑上限）`,
                  `Oversized file read-only preview (${(document.size / 1024 / 1024).toFixed(1)} MB, exceeds 20 MB edit limit)`,
                )}
          </span>
          <span className="fv-spacer" />
          {document.size <= VIEWER_TEXT_HARD_LIMIT && (
            <button
              type="button"
              className="fv-button outline"
              data-testid="notepad-large-force-edit"
              onClick={async () => {
                try {
                  await useDocumentStore.getState().open(document.path, undefined, true);
                  useNotepadStore.getState().patchDoc(docKey, { largeEditConfirmed: true });
                } catch (err) {
                  onError(err instanceof Error ? err.message : String(err));
                }
              }}
            >
              {label("加载全文并编辑", "Open Full File for Editing")}
            </button>
          )}
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
        onIncrementalSearch={actions.searchActions.incrementalSearch}
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
          void writeText(txt).catch((error: unknown) => onError(String(error)));
          setFindStatus(
            txt
              ? label(`已复制 ${txt.split("\n").length} 条标记文本。`, `Copied ${txt.split("\n").length} marked match(es).`)
              : label("暂无标记匹配可复制。", "No marked text to copy."),
          );
        }}
        onClose={() => {
          store.patchFind(docKey, { open: false });
          queueMicrotask(focusActiveEditor);
        }}
      />

      <div className="np-main-area">
        <div className="np-editor-column">
          <NotepadSplitPanes
            split={docState.split}
            orient={docState.orient}
            syncScroll={docState.syncScrollV || docState.syncScrollH}
            syncScrollV={docState.syncScrollV}
            syncScrollH={docState.syncScrollH}
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
            findHighlight={findHighlight}
            historyResetNonce={docState.changeHistoryResetNonce}
            paneSelections={docState.paneSelections}
            paneScrolls={docState.paneScrolls}
            onChange={(nextText) => useDocumentStore.getState().edit(document.path, nextText)}
            onUserTextInsert={(text) => {
              if (useNotepadStore.getState().macro.recording) {
                actions.registry.recordTextInsert(text);
              }
            }}
            onScrollPosition={(pane, top, left) => {
              const cur = useNotepadStore.getState().docs[docKey];
              if (!cur) return;
              const prev = cur.paneScrolls[pane];
              const roundedTop = Math.round(top);
              const roundedLeft = Math.round(left);
              if (prev.top === roundedTop && prev.left === roundedLeft) return;
              const nextScrolls: [{ top: number; left: number }, { top: number; left: number }] = [
                cur.paneScrolls[0],
                cur.paneScrolls[1],
              ];
              nextScrolls[pane] = { top: roundedTop, left: roundedLeft };
              useNotepadStore.getState().patchDoc(docKey, { paneScrolls: nextScrolls });
            }}
            onCursorMetrics={(pane, nextMetrics) => {
              setMetrics(nextMetrics);
              onCursorChange({ line: nextMetrics.line, column: nextMetrics.column });
              const cur = useNotepadStore.getState().docs[docKey];
              if (cur) {
                const prev = cur.paneSelections[pane];
                if (prev.from !== nextMetrics.from || prev.to !== nextMetrics.to) {
                  const nextSels: [{ from: number; to: number }, { from: number; to: number }] = [
                    cur.paneSelections[0],
                    cur.paneSelections[1],
                  ];
                  nextSels[pane] = { from: nextMetrics.from, to: nextMetrics.to };
                  useNotepadStore.getState().patchDoc(docKey, { paneSelections: nextSels });
                }
              }
            }}
            onToggleBookmark={(ln0) => store.toggleBookmark(docKey, ln0)}
            onToggleInsertMode={(ins) => store.setInsertMode(ins)}
            onFocusPane={(pane) => store.patchDoc(docKey, { activePane: pane })}
            onViewsChanged={(views) => { viewsRef.current = views; }}
            onContextMenuRequest={(request) => {
              if (request.paneIndex !== docState.activePane) {
                store.patchDoc(docKey, { activePane: request.paneIndex });
              }
              setContextMenuRequest(request);
            }}
          />
          <PanelDockView
            side="bottom"
            activeDocKey={docKey}
            content={document.content}
            primaryView={viewsRef.current[0]}
            onInsertChar={(ch) => void actions.sessionAndMacroHelpers.insertChar(ch)}
            onSelectDoc={(doc) => viewerTabHost.activateDoc(doc.docKey, { host: doc.host, workspaceId: doc.workspaceId })}
            onCloseDoc={(doc) => viewerTabHost.closeDoc(doc.docKey, { host: doc.host, workspaceId: doc.workspaceId })}
            onJumpHit={handleJumpSearchHit}
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
          onJumpHit={handleJumpSearchHit}
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
          readOnlyLocked={Boolean(document.readOnlyReason) || (document.large && !docState.largeEditConfirmed)}
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

      <NotepadDialogsHost
        document={document}
        docState={docState}
        hostCtx={hostCtx}
        effectiveReadOnly={effectiveReadOnly}
        selectionText={selectionText}
        currentLine={metrics.line}
        currentOffset={metrics.offset}
        lifecycleModal={lifecycleModal}
        setLifecycleModal={setLifecycleModal}
        editModal={editModal}
        setEditModal={setEditModal}
        encodingOpen={encodingOpen}
        setEncodingOpen={setEncodingOpen}
        toolboxKind={toolboxKind}
        setToolboxKind={setToolboxKind}
        macroModal={macroModal}
        setMacroModal={setMacroModal}
        printOpen={printOpen}
        setPrintOpen={setPrintOpen}
        sessionModal={sessionModal}
        setSessionModal={setSessionModal}
        prefsOpen={prefsOpen}
        setPrefsOpen={setPrefsOpen}
        mapperOpen={mapperOpen}
        setMapperOpen={setMapperOpen}
        pickerModal={pickerModal}
        setPickerModal={setPickerModal}
        aboutOpen={aboutOpen}
        setAboutOpen={setAboutOpen}
        compare={store.compare}
        tamperInfo={tamperInfo}
        savedMacros={store.macro.saved}
        onError={onError}
        onSaveAs={actions.handleSaveAs}
        onRename={actions.handleRename}
        onTrash={actions.handleTrash}
        onElevatedSave={actions.handleElevatedSave}
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
        onApplyToolboxText={(nextText, onlySel) => {
          if (!effectiveReadOnly) actions.replaceViewSelection(viewsRef.current[0], nextText, onlySel);
        }}
        onSaveNamedMacro={actions.sessionAndMacroHelpers.saveNamedMacro}
        onRunMultiMacro={actions.sessionAndMacroHelpers.runMulti}
        onDeleteMacro={actions.sessionAndMacroHelpers.deleteMacro}
        onRenameMacro={actions.sessionAndMacroHelpers.renameMacro}
        onRunSavedMacro={actions.sessionAndMacroHelpers.runSavedMacro}
        onSaveSession={actions.sessionAndMacroHelpers.saveSession}
        onLoadSession={actions.sessionAndMacroHelpers.loadSession}
        onPasteSpecial={(text, kind) => {
          const view = viewsRef.current[docState.activePane] ?? viewsRef.current[0];
          if (!view) return;
          const sel = view.state.selection.main;
          const value = kind === "binary" ? text : text.replace(/\0/g, "");
          view.dispatch({ changes: { from: sel.from, to: sel.to, insert: value }, selection: { anchor: sel.from + value.length } });
        }}
        onInsertText={actions.sessionAndMacroHelpers.insertChar}
        onReturnFocus={focusActiveEditor}
      />

      <NotepadContextMenu
        request={contextMenuRequest}
        readOnly={effectiveReadOnly}
        hasSelection={metrics.to > metrics.from}
        onCommand={(commandId) => void actions.registry.execute(commandId)}
        onClose={() => setContextMenuRequest(null)}
      />
    </div>
  );
}
