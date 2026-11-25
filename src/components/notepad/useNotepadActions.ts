import { useMemo } from "react";
import type { EditorView } from "@codemirror/view";

import { NotepadCommandRegistry } from "../../lib/notepad/commands/registry";
import type { RecordedMacroStep } from "../../lib/notepad/commands/types";
import { viewerTabHost } from "../../lib/notepad/host/viewerTabHost";
import { viewerRename, viewerSaveAs, viewerTrash, viewerWriteTextElevated } from "../../lib/notepad/ipc";
import {
  normalizeMacroSteps,
  runMacroMultipleTimes,
  runMacroOnce,
  runMacroUntilEndOfFile,
  saveMacrosList,
  type MacroPlaybackHost,
  type SavedMacroEntry,
} from "../../lib/notepad/macro/macroManager";
import { loadSessionFromDisk, saveSessionToDisk, type SessionTabEntry } from "../../lib/notepad/persistence/sessionManager";
import { findAllMatches, findNextMatch, replaceAllInText, toSearchResultHits } from "../../lib/notepad/search/engine";
import { cancelActiveFindInFiles, replaceInDiskFiles, runFindInFiles } from "../../lib/notepad/search/findInFiles";
import { convertCaseRange, type NotepadCaseKind } from "../../lib/notepad/transforms/case";
import type { ColumnInsertSpec } from "../../lib/notepad/transforms/column";
import { sortLines, type SortOptions } from "../../lib/notepad/transforms/sort";
import { getLineStarts, lineIndexAt, type TextRange, type TextTransformResult } from "../../lib/notepad/transforms/lines";
import { documentPathKey, isUntitledKey } from "../../lib/openFile/pathIdentity";
import { parentPath } from "../../lib/sftp";
import type { ViewerEol } from "../../lib/viewer";
import { useRecentFilesStore } from "../../stores/app/recentFiles";
import { useDocumentStore } from "../../stores/documentStore";
import { setNotepadPreferences, useNotepadPreferences } from "../../stores/notepadPreferences";
import { applyColumnEditorToView } from "../../lib/notepad/cm6/columnSelection";
import { useNotepadStore, type NotepadMacroStep } from "../../stores/notepadStore";
import { createCoreCommandMap } from "./actions/coreCommands";
import { createExtraCommandMap } from "./actions/extraCommands";
import { resolveNotepadSaveAsDefaults } from "./actions/saveDefaults";
import type { NotepadActionContext, NotepadActionDeps } from "./actions/context";

export type { NotepadActionDeps, NotepadActionContext } from "./actions/context";

function activeSelection(view: EditorView | null): TextRange {
  if (!view) return { from: 0, to: 0 };
  const main = view.state.selection.main;
  return { from: main.from, to: main.to };
}

function applyTextResult(view: EditorView | null, fallbackDocPath: string, res: TextTransformResult): void {
  if (!res.changed) return;
  if (view) {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: res.text },
      selection: { anchor: res.selection.from, head: res.selection.to },
      scrollIntoView: true,
    });
  } else {
    useDocumentStore.getState().edit(fallbackDocPath, res.text);
  }
}

export function useNotepadActions(deps: NotepadActionDeps) {
  const registry = useMemo(() => new NotepadCommandRegistry(), []);

  const replaceViewSelection = (view: EditorView | null, nextText: string, onlySelection: boolean) => {
    if (onlySelection && view) {
      const sel = view.state.selection.main;
      view.dispatch({ changes: { from: sel.from, to: sel.to, insert: nextText } });
    } else if (view) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: nextText } });
    } else {
      useDocumentStore.getState().edit(deps.document.path, nextText);
    }
  };

  const performSave = async (): Promise<void> => {
    const doc = deps.document;
    if (deps.effectiveReadOnly) return;
    // AC-13: a chunked large-file preview must never write the partial buffer
    // back over the full file; the user has to confirm full-file editing first.
    if (doc.large && !deps.docState.largeEditConfirmed) {
      deps.onError("Large file preview is read-only; open the full file for editing first.");
      return;
    }
    if (isUntitledKey(doc.path)) {
      // U2: untitled Save As opens at the last save directory (or $HOME) with an
      // absolute path instead of a bare file name.
      const defaults = await resolveNotepadSaveAsDefaults(doc.path, deps.docState.titleHint || "");
      deps.setLifecycleModal({ kind: "saveAs", ...defaults });
      return;
    }
    const prefs = useNotepadPreferences.getState();
    try {
      if (prefs.backupMode !== "none") {
        await deps.backupMgr.createSaveBackupCopy(doc.path, prefs.backupMode, prefs.backupDir).catch(() => undefined);
      }
      await useDocumentStore.getState().save(doc.path);
      await deps.backupMgr.pruneDoc(deps.docKey);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("permission:")) {
        deps.setLifecycleModal({ kind: "elevated", path: doc.path, error: msg });
        return;
      }
      deps.onError(msg);
    }
  };

  const applyTransform = (
    fn: (text: string, range: TextRange) => TextTransformResult,
    options?: { wholeDocLabel?: string },
  ) => {
    if (deps.effectiveReadOnly) return;
    const view = deps.getActiveView();
    const sel = activeSelection(view);
    const execute = () => {
      const currentView = deps.getActiveView();
      const latestText = useDocumentStore.getState().documents[deps.docKey]?.content ?? deps.document.content;
      const res = fn(latestText, activeSelection(currentView));
      applyTextResult(currentView, deps.document.path, res);
    };
    if (
      options?.wholeDocLabel &&
      sel.from === sel.to &&
      deps.document.content.includes("\n") &&
      useNotepadPreferences.getState().askWholeDocLineOp
    ) {
      deps.setLifecycleModal({
        kind: "wholeDocConfirm",
        actionLabel: options.wholeDocLabel,
        onConfirm: execute,
      });
      return;
    }
    execute();
  };

  const applySort = (opts: SortOptions, actionLabel = "Sort Lines") =>
    applyTransform((t, r) => sortLines(t, r, opts, true), { wholeDocLabel: actionLabel });

  const applyCaseOp = (kind: NotepadCaseKind) => {
    if (deps.effectiveReadOnly) return;
    const view = deps.getActiveView();
    const sel = activeSelection(view);
    if (sel.from === sel.to) return;
    const res = convertCaseRange(deps.document.content, sel, kind);
    applyTextResult(view, deps.document.path, res);
  };

  const toRecordedSteps = (steps: NotepadMacroStep[]): RecordedMacroStep[] => normalizeMacroSteps(steps);

  const macroHost: MacroPlaybackHost = {
    async executeCommand(id, args) {
      await registry.execute(id, args, { skipRecord: true });
    },
    insertText(txt) {
      const v = deps.getActiveView();
      if (!v || deps.effectiveReadOnly) return;
      v.dispatch(v.state.replaceSelection(txt));
    },
    getCursorAndLength() {
      const v = deps.getActiveView();
      return v ? { pos: v.state.selection.main.head, length: v.state.doc.length } : { pos: 0, length: 0 };
    },
  };

  const jumpToOffset = (from: number, to = from, options?: { preserveFocus?: boolean }) => {
    const view = deps.getActiveView();
    if (!view) return;
    const clampedFrom = Math.max(0, Math.min(from, view.state.doc.length));
    const clampedTo = Math.max(clampedFrom, Math.min(to, view.state.doc.length));
    view.dispatch({ selection: { anchor: clampedFrom, head: clampedTo }, scrollIntoView: true });
    useNotepadStore.getState().patchDoc(deps.docKey, {
      activeMatch: clampedTo > clampedFrom ? { from: clampedFrom, to: clampedTo } : null,
    });
    if (!options?.preserveFocus) view.focus();
  };

  const runFindDirection = (
    backward: boolean,
    overrideQuery?: string,
    options?: { preserveFocus?: boolean },
  ) => {
    const view = deps.getActiveView();
    const sel = activeSelection(view);
    const searchCursor = options?.preserveFocus ? { from: sel.from, to: sel.from } : sel;
    const q = deps.docState.find;
    const queryText = overrideQuery !== undefined ? overrideQuery : q.query;
    const res = findNextMatch(
      deps.document.content,
      { ...q, query: queryText, backward },
      searchCursor,
      sel.to > sel.from && overrideQuery === undefined ? sel : undefined,
    );
    if (res.error) {
      deps.setFindStatus(res.error);
      return;
    }
    if (!res.match) {
      deps.setFindStatus("No matches found.");
      return;
    }
    jumpToOffset(res.match.from, res.match.to, options);
    deps.setFindStatus(res.wrapped ? "Wrapped search." : null);
  };

  const editContent = (text: string) => {
    const view = deps.getActiveView();
    if (view) {
      const current = view.state.doc.toString();
      if (current !== text) {
        view.dispatch({ changes: { from: 0, to: current.length, insert: text } });
      }
      return;
    }
    useDocumentStore.getState().edit(deps.document.path, text);
  };

  const ctx: NotepadActionContext = {
    ...deps,
    registry,
    replaceViewSelection,
    applyTransform,
    applySort,
    applyCaseOp,
    jumpToOffset,
    runFindDirection,
    performSave,
    macroHost,
    toRecordedSteps,
    editContent,
  };

  registry.registerMany(createCoreCommandMap(ctx));
  registry.registerMany(createExtraCommandMap(ctx));

  return {
    registry,
    performSave,
    jumpToOffset,
    runFindDirection,
    applyColumnSpec: (spec: ColumnInsertSpec) => {
      const v = deps.getActiveView();
      if (v && !deps.effectiveReadOnly) applyColumnEditorToView(v, spec);
    },
    replaceViewSelection,
    async handleSaveAs(path: string, overwrite: boolean, copy = false) {
      const doc = deps.document;
      const res = await viewerSaveAs({
        path,
        content: doc.content,
        encoding: doc.encoding,
        bom: doc.bom,
        eol: doc.eol,
        overwrite,
      });
      // U2: remember where the user saved so the next untitled Save As and the
      // native browse picker reopen in that directory (also for Save a Copy).
      setNotepadPreferences({ lastSaveDir: parentPath(res.path) });
      if (copy) {
        // AC-01: Save a Copy writes a new file but the open document keeps
        // pointing at its original path and stays the active editable buffer.
        useRecentFilesStore.getState().recordRecent(res.path);
        return;
      }
      const oldKey = deps.docKey;
      useDocumentStore.getState().rekey(doc.path, res.path, {
        hash: res.hash,
        size: res.size,
        mtime: res.mtime,
      }, { encoding: doc.encoding, bom: doc.bom, eol: doc.eol, content: doc.content });
      viewerTabHost.rekeyDoc(oldKey, res.path);
      await deps.backupMgr.pruneDoc(oldKey);
      useRecentFilesStore.getState().recordRecent(res.path);
    },
    async handleRename(newName: string) {
      const doc = deps.document;
      const res = await viewerRename(doc.path, newName);
      useDocumentStore.getState().rekey(doc.path, res.newPath, {
        hash: doc.savedHash,
        size: doc.size,
        mtime: doc.mtime,
      }, { encoding: doc.encoding, bom: doc.bom, eol: doc.eol, content: doc.content });
      viewerTabHost.rekeyDoc(deps.docKey, res.newPath, res.name);
      useRecentFilesStore.getState().recordRecent(res.newPath, res.name);
    },
    async handleTrash() {
      await viewerTrash(deps.document.path);
      await deps.backupMgr.pruneDoc(deps.docKey);
      viewerTabHost.closeDoc(deps.document.path, deps.hostCtx);
    },
    async handleElevatedSave() {
      const doc = deps.document;
      const res = await viewerWriteTextElevated({
        path: doc.path,
        content: doc.content,
        encoding: doc.encoding,
        bom: doc.bom,
        eol: doc.eol,
      });
      useDocumentStore.getState().rekey(doc.path, res.path, {
        hash: res.hash,
        size: res.size,
        mtime: res.mtime,
      }, { encoding: doc.encoding, bom: doc.bom, eol: doc.eol, content: doc.content });
      await deps.backupMgr.pruneDoc(deps.docKey);
    },
    searchActions: {
      findNext: () => runFindDirection(false),
      findPrev: () => runFindDirection(true),
      incrementalSearch: (query: string) => runFindDirection(false, query, { preserveFocus: true }),
      count: () => {
        const res = findAllMatches(deps.document.content, deps.docState.find);
        deps.setFindStatus(res.error ?? `${res.matches.length} match(es).`);
      },
      findAllCurrent: () => {
        const res = findAllMatches(deps.document.content, deps.docState.find);
        if (res.error) return deps.setFindStatus(res.error);
        const hits = toSearchResultHits(
          { docId: deps.docKey, filePath: isUntitledKey(deps.document.path) ? undefined : deps.document.path, name: deps.docState.titleHint || deps.document.path.split(/[\\/]/).pop() || "Untitled" },
          deps.document.content,
          res.matches,
        );
        useNotepadStore.getState().setSearchResults(`Find "${deps.docState.find.query}"`, hits);
      },
      findAllOpen: () => {
        const openDocs = viewerTabHost.listOpenDocs();
        const docs = useDocumentStore.getState().documents;
        const hits = openDocs.flatMap((ref) => {
          const d = docs[ref.docKey];
          if (!d) return [];
          const res = findAllMatches(d.content, deps.docState.find);
          return toSearchResultHits({ docId: ref.docKey, filePath: ref.untitled ? undefined : ref.path, name: ref.title }, d.content, res.matches);
        });
        useNotepadStore.getState().setSearchResults(`Open Docs "${deps.docState.find.query}"`, hits);
      },
      replaceOne: () => {
        if (deps.effectiveReadOnly) return;
        const v = deps.getActiveView();
        if (!v) return;
        const sel = v.state.selection.main;
        const curText = v.state.sliceDoc(sel.from, sel.to);
        const q = deps.docState.find;
        const check = findAllMatches(curText, q);
        if (check.matches.length === 1 && check.matches[0].from === 0 && check.matches[0].to === curText.length) {
          const replaced = replaceAllInText(curText, q);
          v.dispatch({ changes: { from: sel.from, to: sel.to, insert: replaced.text } });
        }
        runFindDirection(false);
      },
      replaceAll: () => {
        if (deps.effectiveReadOnly) return;
        const v = deps.getActiveView();
        const sel = activeSelection(v);
        const res = replaceAllInText(deps.document.content, deps.docState.find, sel.to > sel.from ? sel : undefined);
        if (res.error) return deps.setFindStatus(res.error);
        replaceViewSelection(v, res.text, false);
        deps.setFindStatus(`Replaced ${res.count} occurrence(s).`);
      },
      replaceAllOpen: () => {
        const openDocs = viewerTabHost.listOpenDocs();
        const docs = useDocumentStore.getState().documents;
        let count = 0;
        for (const ref of openDocs) {
          const d = docs[ref.docKey];
          if (!d || d.readOnly || d.large) continue;
          const res = replaceAllInText(d.content, deps.docState.find);
          if (res.count > 0) {
            if (ref.docKey === deps.docKey) editContent(res.text);
            else useDocumentStore.getState().edit(d.path, res.text);
            count += res.count;
          }
        }
        deps.setFindStatus(`Replaced ${count} occurrence(s) across open documents.`);
      },
      async findInFiles() {
        deps.setSearchingFiles(true);
        const q = deps.docState.find;
        const res = await runFindInFiles(
          {
            directory: q.filesDir,
            query: q.query,
            filter: q.filesFilter,
            mode: q.mode,
            caseSensitive: q.caseSensitive,
            wholeWord: q.wholeWord,
            dotAll: q.dotAll,
          },
          (hits) => useNotepadStore.getState().setSearchResults(`Files "${q.query}"`, hits),
        );
        deps.setSearchingFiles(false);
        if (res.error) deps.setFindStatus(res.error);
        else useNotepadStore.getState().setSearchResults(`Files "${q.query}"`, res.hits);
      },
      cancelFindInFiles: () => {
        void cancelActiveFindInFiles();
        deps.setSearchingFiles(false);
      },
      async replaceInFiles() {
        const hits = useNotepadStore.getState().results;
        const paths = hits.map((h) => h.filePath).filter((p): p is string => Boolean(p));
        const q = deps.docState.find;
        const res = await replaceInDiskFiles(paths, {
          query: q.query,
          replace: q.replace,
          mode: q.mode,
          caseSensitive: q.caseSensitive,
          wholeWord: q.wholeWord,
          dotAll: q.dotAll,
        });
        deps.setFindStatus(`Updated ${res.updatedFiles} file(s), ${res.totalReplacements} replacement(s).`);
      },
      markAll: (bookmarkLines: boolean, purgePrev: boolean) => {
        const q = deps.docState.find;
        if (purgePrev) useNotepadStore.getState().clearMarks(deps.docKey, q.markStyle);
        useNotepadStore.getState().addMark(deps.docKey, {
          id: `mark-${Date.now()}`,
          style: q.markStyle,
          query: q.query,
          mode: q.mode,
          caseSensitive: q.caseSensitive,
          wholeWord: q.wholeWord,
        });
        const all = findAllMatches(deps.document.content, q);
        if (bookmarkLines && all.matches.length > 0) {
          const hits = toSearchResultHits({ name: "" }, deps.document.content, all.matches);
          const merged = [...deps.docState.bookmarks, ...hits.map((h) => h.line)];
          useNotepadStore.getState().setBookmarks(deps.docKey, merged);
        }
        deps.setFindStatus(`Marked ${all.matches.length} occurrence(s).`);
      },
    },
    sessionAndMacroHelpers: {
      async saveSession(filePath?: string | null) {
        const openDocs = viewerTabHost.listOpenDocs();
        const docs = useDocumentStore.getState().documents;
        const npDocs = useNotepadStore.getState().docs;
        const activeView = deps.getActiveView();
        const tabs: SessionTabEntry[] = openDocs.map((ref) => {
          const d = docs[ref.docKey];
          const nd = npDocs[ref.docKey];
          const content = d?.content ?? "";
          let cursorLine = 1;
          let cursorCol = 1;
          let scrollTop = nd?.paneScrolls[nd?.activePane ?? 0]?.top ?? 0;
          if (ref.docKey === deps.docKey && activeView) {
            const head = activeView.state.selection.main.head;
            const ln = activeView.state.doc.lineAt(head);
            cursorLine = ln.number;
            cursorCol = head - ln.from + 1;
            scrollTop = Math.round(activeView.scrollDOM.scrollTop);
          } else if (nd) {
            const sel = nd.paneSelections[nd.activePane];
            const pos = Math.max(0, Math.min(sel.to, content.length));
            const lnIdx = lineIndexAt(content, pos);
            const starts = getLineStarts(content);
            cursorLine = lnIdx + 1;
            cursorCol = pos - (starts[lnIdx] ?? 0) + 1;
          }
          return {
            docKey: ref.docKey,
            path: ref.untitled ? null : ref.path,
            untitled: ref.untitled,
            name: ref.title,
            pinned: ref.pinned,
            encoding: d?.encoding ?? "UTF-8",
            bom: d?.bom ?? false,
            eol: d?.eol === "CRLF" || d?.eol === "CR" ? d.eol : "LF",
            cursorLine,
            cursorCol,
            scrollTop,
            bookmarks: nd?.bookmarks ?? [],
            wrap: useNotepadPreferences.getState().wrap,
            readOnly: Boolean(d?.readOnly),
            split: Boolean(nd?.split),
            untitledContent: ref.untitled ? content : undefined,
          };
        });
        return saveSessionToDisk(tabs, deps.docKey, filePath);
      },
      async loadSession(filePath?: string | null) {
        const loaded = await loadSessionFromDisk(filePath);
        if (!loaded) return;
        const keyMap = new Map<string, string>();
        for (const tab of loaded.tabs) {
          let targetKey: string | null = null;
          if (tab.untitled) {
            targetKey = viewerTabHost.openUntitled(deps.hostCtx, tab.untitledContent ?? "", {
              title: tab.name,
              encoding: tab.encoding,
              bom: tab.bom,
              eol: tab.eol,
            });
          } else if (tab.path) {
            await viewerTabHost.openFile(tab.path, deps.hostCtx);
            targetKey = documentPathKey(tab.path);
          }
          if (!targetKey) continue;
          keyMap.set(tab.docKey, targetKey);
          const docStore = useDocumentStore.getState();
          const openedDoc = docStore.documents[targetKey];
          if (openedDoc) {
            const formatDiffers =
              openedDoc.encoding !== tab.encoding ||
              openedDoc.bom !== tab.bom ||
              openedDoc.eol !== tab.eol;
            if (formatDiffers) {
              docStore.configure(openedDoc.path, {
                encoding: tab.encoding,
                bom: tab.bom,
                eol: tab.eol,
              });
            }
            if (tab.readOnly) docStore.setEditorReadOnly(openedDoc.path, true);
          }
          if (tab.pinned) viewerTabHost.pinDoc(targetKey, true);
          const np = useNotepadStore.getState();
          np.setBookmarks(targetKey, tab.bookmarks);
          const restoredText = docStore.documents[targetKey]?.content ?? tab.untitledContent ?? "";
          const starts = getLineStarts(restoredText);
          const line0 = Math.max(0, Math.min(tab.cursorLine - 1, starts.length - 1));
          const lineEnd = restoredText.indexOf("\n", starts[line0]);
          const lineLen = (lineEnd === -1 ? restoredText.length : lineEnd) - starts[line0];
          const offset = starts[line0] + Math.max(0, Math.min(tab.cursorCol - 1, lineLen));
          np.patchDoc(targetKey, {
            split: tab.split,
            paneSelections: [{ from: offset, to: offset }, { from: offset, to: offset }],
            paneScrolls: [{ top: tab.scrollTop, left: 0 }, { top: tab.scrollTop, left: 0 }],
          });
          if (loaded.activeDocKey === tab.docKey) {
            setNotepadPreferences({ wrap: tab.wrap });
          }
        }
        if (loaded.activeDocKey) {
          const activeTarget = keyMap.get(loaded.activeDocKey) ?? loaded.activeDocKey;
          viewerTabHost.activateDoc(activeTarget, deps.hostCtx);
        }
      },
      async runMulti(mode: "times" | "eof", count: number) {
        const steps = toRecordedSteps(useNotepadStore.getState().macro.buffer);
        if (mode === "eof") await runMacroUntilEndOfFile(steps, macroHost);
        else await runMacroMultipleTimes(steps, count, macroHost);
      },
      async runSavedMacro(macro: SavedMacroEntry | { steps: NotepadMacroStep[] }) {
        const steps = toRecordedSteps(macro.steps);
        await runMacroOnce(steps, macroHost);
      },
      async saveNamedMacro(name: string, shortcut?: string) {
        const macro = useNotepadStore.getState().macro;
        const normalizedSteps = normalizeMacroSteps(macro.buffer);
        const next = [...macro.saved.filter((m) => m.name !== name), { name, key: shortcut, steps: normalizedSteps }];
        const res = await saveMacrosList(next.map((m) => ({ name: m.name, shortcut: m.key, steps: normalizeMacroSteps(m.steps) })));
        useNotepadStore.getState().patchMacro({ saved: next, hash: res.actualHash, tampered: false });
      },
      async deleteMacro(name: string) {
        const next = useNotepadStore.getState().macro.saved.filter((m) => m.name !== name);
        const res = await saveMacrosList(next.map((m) => ({ name: m.name, shortcut: m.key, steps: normalizeMacroSteps(m.steps) })));
        useNotepadStore.getState().patchMacro({ saved: next, hash: res.actualHash });
      },
      async renameMacro(oldName: string, newName: string) {
        const next = useNotepadStore.getState().macro.saved.map((m) => (m.name === oldName ? { ...m, name: newName } : m));
        const res = await saveMacrosList(next.map((m) => ({ name: m.name, shortcut: m.key, steps: normalizeMacroSteps(m.steps) })));
        useNotepadStore.getState().patchMacro({ saved: next, hash: res.actualHash });
      },
      async insertChar(ch: string) {
        macroHost.insertText(ch);
      },
      async cycleEol() {
        const order: ViewerEol[] = ["LF", "CRLF", "CR"];
        const next = order[(order.indexOf(deps.document.eol) + 1) % order.length];
        useDocumentStore.getState().configure(deps.document.path, { eol: next });
      },
    },
  };
}
