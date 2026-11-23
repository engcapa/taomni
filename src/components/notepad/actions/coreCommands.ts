import { redo, selectAll, undo } from "@codemirror/commands";
import { applyBookmarkLinesOp, nextBookmarkPos } from "../../../lib/notepad/cm6/bookmarksAndHistory";
import { viewerTabHost } from "../../../lib/notepad/host/viewerTabHost";
import { parentPath } from "../../../lib/sftp";
import { notepadOpenTerminalDir } from "../../../lib/notepad/ipc";
import { runMacroOnce } from "../../../lib/notepad/macro/macroManager";
import { dedupeAdjacentLines, dedupeLines, duplicateLine, joinLines, moveSelectedLines, removeBlankLines, removeEmptyLines, resolveLineSpan, reverseLines, splitLinesAtColumn } from "../../../lib/notepad/transforms/lines";
import { runMimeTransform } from "../../../lib/notepad/transforms/mime";
import { eolToSpace, spacesToTabsLeading, tabsToSpaces, trimBothSpaces, trimLeadingSpaces, trimTrailingSpaces } from "../../../lib/notepad/transforms/whitespace";
import { isUntitledKey } from "../../../lib/openFile/pathIdentity";
import { selectFilePath } from "../../../lib/ipc/files";
import { readPasteText, writeText } from "../../../lib/clipboard";
import { useRecentFilesStore } from "../../../stores/app/recentFiles";
import { useDocumentStore } from "../../../stores/documentStore";
import { setNotepadPreferences, useNotepadPreferences } from "../../../stores/notepadPreferences";
import { useNotepadStore, type NotepadPanelId } from "../../../stores/notepadStore";
import type { NotepadCommandHandler } from "../../../lib/notepad/commands/types";
import type { NotepadActionContext } from "./context";
import { resolveNotepadSaveAsDefaults } from "./saveDefaults";

/**
 * Core Notepad command handlers (file lifecycle, editing, transforms, search,
 * view, encoding, macro, tools and window). Dialog and picker state lives in
 * the owning component and is reached through ctx.
 */
export function createCoreCommandMap(ctx: NotepadActionContext): Record<string, NotepadCommandHandler> {
  return {
    "file.new": () => {
      viewerTabHost.openUntitled(ctx.hostCtx);
    },
    "file.open": async () => {
      const picked = await selectFilePath();
      if (picked) await viewerTabHost.openFile(picked, ctx.hostCtx);
    },
    "file.save": () => ctx.performSave(),
    "file.saveAs": async () => {
      // U2: untitled documents default to the absolute last-save-dir/$HOME path;
      // saved documents keep their current path prefilled for in-place editing.
      const defaults = await resolveNotepadSaveAsDefaults(ctx.document.path, ctx.docState.titleHint || "");
      ctx.setLifecycleModal({ kind: "saveAs", ...defaults });
    },
    "file.saveAll": async () => {
      const allDocs = Object.values(useDocumentStore.getState().documents);
      for (const d of allDocs) {
        if (d.dirty && !d.readOnly && !d.large && !isUntitledKey(d.key)) {
          await useDocumentStore.getState().save(d.path);
          await ctx.backupMgr.pruneDoc(d.key);
        }
      }
    },
    "file.rename": () => {
      if (isUntitledKey(ctx.document.path)) return;
      ctx.setLifecycleModal({
        kind: "rename",
        currentName: ctx.document.path.split(/[\\/]/).pop() || ctx.document.path,
      });
    },
    "file.reload": async () => {
      if (!isUntitledKey(ctx.document.path)) await useDocumentStore.getState().reload(ctx.document.path);
    },
    "file.close": () => {
      viewerTabHost.closeDoc(ctx.document.path, ctx.hostCtx);
    },
    "file.closeAll": () => {
      const open = viewerTabHost.listOpenDocs(ctx.hostCtx).map((d) => d.docKey);
      viewerTabHost.closeMany(open, { keepPinned: true, host: ctx.hostCtx.host, workspaceId: ctx.hostCtx.workspaceId });
    },
    "file.closeOthers": () => {
      const open = viewerTabHost.listOpenDocs(ctx.hostCtx).filter((d) => d.docKey !== ctx.docKey).map((d) => d.docKey);
      viewerTabHost.closeMany(open, { keepPinned: true, host: ctx.hostCtx.host, workspaceId: ctx.hostCtx.workspaceId });
    },
    "file.moveToTrash": () => {
      if (isUntitledKey(ctx.document.path)) return;
      ctx.setLifecycleModal({
        kind: "trash",
        path: ctx.document.path,
        name: ctx.document.path.split(/[\\/]/).pop() || ctx.document.path,
      });
    },
    "file.toggleReadonly": () => {
      const liveDoc = useDocumentStore.getState().documents[ctx.docKey] ?? ctx.document;
      useDocumentStore.getState().setEditorReadOnly(ctx.document.path, !liveDoc.readOnly);
    },
    "file.openTerminalDir": async () => {
      if (isUntitledKey(ctx.document.path)) return;
      await notepadOpenTerminalDir(ctx.document.path, useNotepadPreferences.getState().windowsTerminalApp).catch((e) =>
        ctx.onError(String(e)),
      );
    },
    "file.sessionSave": () => ctx.setSessionModal("sessionSave"),
    "file.sessionLoad": () => ctx.setSessionModal("sessionLoad"),
    "file.backupBrowser": () => ctx.setSessionModal("backups"),
    "file.print": () => ctx.setPrintOpen(true),
    "file.summary": () => {
      ctx.setLifecycleModal({
        kind: "summary",
        name: ctx.docState.titleHint || ctx.document.path.split(/[\\/]/).pop() || "Untitled",
        path: isUntitledKey(ctx.document.path) ? null : ctx.document.path,
        encoding: ctx.document.encoding,
        eol: ctx.document.eol,
        content: ctx.document.content,
        bytes: ctx.document.size || new TextEncoder().encode(ctx.document.content).byteLength,
      });
    },

    // Edit
    "edit.undo": () => { const v = ctx.getActiveView(); if (v && !ctx.effectiveReadOnly) undo(v); },
    "edit.redo": () => { const v = ctx.getActiveView(); if (v && !ctx.effectiveReadOnly) redo(v); },
    "edit.cut": async () => {
      const v = ctx.getActiveView();
      if (!v) return;
      const sel = v.state.selection.main;
      if (sel.empty) return;
      const txt = v.state.sliceDoc(sel.from, sel.to);
      useNotepadStore.getState().pushClipboardHistory(txt);
      // Write through the shared helper: the native owner is tried first and the
      // WebView Clipboard API remains the fallback (and dev/browser stub path).
      await writeText(txt).catch((error: unknown) => ctx.onError(String(error)));
      if (!ctx.effectiveReadOnly) v.dispatch({ changes: { from: sel.from, to: sel.to, insert: "" } });
    },
    "edit.copy": async () => {
      const v = ctx.getActiveView();
      if (!v) return;
      const sel = v.state.selection.main;
      if (sel.empty) return;
      const txt = v.state.sliceDoc(sel.from, sel.to);
      useNotepadStore.getState().pushClipboardHistory(txt);
      await writeText(txt).catch((error: unknown) => ctx.onError(String(error)));
    },
    "edit.paste": async () => {
      const v = ctx.getActiveView();
      if (!v || ctx.effectiveReadOnly) return;
      // WebView2 can deny/focus-gate navigator.clipboard.readText and the old
      // single-path read swallowed the rejection, so the paste silently did
      // nothing. Ask the native clipboard owner too and report a real failure
      // instead of pretending the clipboard was empty.
      const txt = await readPasteText().catch((error: unknown) => {
        ctx.onError(String(error));
        return "";
      });
      if (txt) {
        const sel = v.state.selection.main;
        v.dispatch({ changes: { from: sel.from, to: sel.to, insert: txt }, selection: { anchor: sel.from + txt.length } });
      }
    },
    "edit.selectAll": () => { const v = ctx.getActiveView(); if (v) selectAll(v); },
    "edit.duplicateLine": () => ctx.applyTransform(duplicateLine),
    "edit.deleteLine": () => ctx.applyTransform((t, r) => {
      const span = resolveLineSpan(t, r, false);
      const cutEnd = span.to < t.length ? span.to + 1 : span.to;
      const cutStart = span.to === t.length && span.from > 0 ? span.from - 1 : span.from;
      const nextText = t.slice(0, cutStart) + t.slice(cutEnd);
      const caret = Math.min(cutStart, nextText.length);
      return { text: nextText, selection: { from: caret, to: caret }, changed: nextText !== t, beforeLines: span.lines.length, afterLines: 0 };
    }),
    "edit.splitLines": () => ctx.applyTransform((t, r) => splitLinesAtColumn(t, r, useNotepadPreferences.getState().rulerCol, true)),
    "edit.joinLines": () => ctx.applyTransform(joinLines),
    "edit.moveLineUp": () => ctx.applyTransform((t, r) => moveSelectedLines(t, r, -1)),
    "edit.moveLineDown": () => ctx.applyTransform((t, r) => moveSelectedLines(t, r, 1)),
    "edit.removeEmptyLines": () => ctx.applyTransform((t, r) => removeEmptyLines(t, r, true), { wholeDocLabel: "Remove Empty Lines" }),
    "edit.removeBlankLines": () => ctx.applyTransform((t, r) => removeBlankLines(t, r, true), { wholeDocLabel: "Remove Blank Lines" }),
    "edit.removeDuplicateLines": () => ctx.applyTransform((t, r) => dedupeLines(t, r, true), { wholeDocLabel: "Remove Duplicate Lines" }),
    "edit.removeConsecutiveDuplicates": () => ctx.applyTransform((t, r) => dedupeAdjacentLines(t, r, true), { wholeDocLabel: "Remove Consecutive Duplicate Lines" }),
    "edit.reverseLines": () => ctx.applyTransform((t, r) => reverseLines(t, r, true), { wholeDocLabel: "Reverse Line Order" }),
    "edit.sortAsc": () => ctx.applySort({ kind: "lex", descending: false }, "Sort Lines Ascending"),
    "edit.sortDesc": () => ctx.applySort({ kind: "lex", descending: true }, "Sort Lines Descending"),
    "edit.sortCaseInsensitiveAsc": () => ctx.applySort({ kind: "ci", descending: false }, "Sort Lines Ignoring Case Ascending"),
    "edit.sortNumAsc": () => ctx.applySort({ kind: "int", descending: false }, "Sort Lines as Integers Ascending"),
    "edit.sortLenAsc": () => ctx.applySort({ kind: "len", descending: false }, "Sort Lines by Length Ascending"),
    "edit.toUpperCase": () => ctx.applyCaseOp("upper"),
    "edit.toLowerCase": () => ctx.applyCaseOp("lower"),
    "edit.toTitleCase": () => ctx.applyCaseOp("proper"),
    "edit.invertCase": () => ctx.applyCaseOp("invert"),
    "edit.trimTrailing": () => ctx.applyTransform((t, r) => trimTrailingSpaces(t, r, true), { wholeDocLabel: "Trim Trailing Space" }),
    "edit.trimLeading": () => ctx.applyTransform((t, r) => trimLeadingSpaces(t, r, true), { wholeDocLabel: "Trim Leading Space" }),
    "edit.trimBoth": () => ctx.applyTransform((t, r) => trimBothSpaces(t, r, true), { wholeDocLabel: "Trim Leading and Trailing Space" }),
    "edit.tabsToSpaces": () => ctx.applyTransform((t, r) => tabsToSpaces(t, r, 4, true), { wholeDocLabel: "TAB to Space" }),
    "edit.spacesToLeadingTabs": () => ctx.applyTransform((t, r) => spacesToTabsLeading(t, r, 4, true), { wholeDocLabel: "Space to TAB (Leading)" }),
    "edit.eolCollapseToSpace": () => ctx.applyTransform((t, r) => eolToSpace(t, r, true), { wholeDocLabel: "EOL to Space" }),
    "edit.columnEditor": () => ctx.setEditModal("columnEditor"),
    "edit.insertDateTimeShort": () => ctx.replaceViewSelection(ctx.getActiveView(), new Date().toLocaleString(), true),
    "edit.insertDateTimeLong": () => ctx.replaceViewSelection(ctx.getActiveView(), new Date().toISOString(), true),
    "edit.convertEolLf": () => useDocumentStore.getState().configure(ctx.document.path, { eol: "LF" }),
    "edit.convertEolCrlf": () => useDocumentStore.getState().configure(ctx.document.path, { eol: "CRLF" }),
    "edit.convertEolCr": () => useDocumentStore.getState().configure(ctx.document.path, { eol: "CR" }),
    "edit.copyCurrentFilePath": async () => { await writeText(ctx.document.path).catch((error: unknown) => ctx.onError(String(error))); },
    "edit.copyCurrentFileName": async () => { await writeText(ctx.document.path.split(/[\\/]/).pop() || ctx.docState.titleHint || "").catch((error: unknown) => ctx.onError(String(error))); },
    "edit.toggleOverwrite": () => {
      const store = useNotepadStore.getState();
      store.setInsertMode(!store.insertMode);
    },

    // Search & Bookmarks & Marks
    "search.find": () => useNotepadStore.getState().patchFind(ctx.docKey, { open: true, tab: "find" }),
    "search.replace": () => useNotepadStore.getState().patchFind(ctx.docKey, { open: true, tab: "replace" }),
    "search.findInFiles": () => {
      const current = useNotepadStore.getState().docs[ctx.docKey]?.find;
      const dir = current?.filesDir || (isUntitledKey(ctx.document.path) ? "" : parentPath(ctx.document.path));
      useNotepadStore.getState().patchFind(ctx.docKey, { open: true, tab: "files", filesDir: dir });
    },
    "search.findNext": () => ctx.runFindDirection(false),
    "search.findPrev": () => ctx.runFindDirection(true),
    "search.incremental": () => useNotepadStore.getState().patchFind(ctx.docKey, { open: true, tab: "find", incremental: true }),
    "search.goToLine": () => ctx.setEditModal("goto"),
    "search.markDialog": () => useNotepadStore.getState().patchFind(ctx.docKey, { open: true, tab: "mark" }),
    ...[1, 2, 3, 4, 5].reduce<Record<string, NotepadCommandHandler>>((acc, idx) => {
      acc[`search.styleToken${idx}`] = () => {
        const v = ctx.getActiveView();
        if (!v) return;
        const sel = v.state.selection.main;
        const query = v.state.sliceDoc(sel.from, sel.to).trim();
        if (!query) return;
        useNotepadStore.getState().addMark(ctx.docKey, {
          id: `style-${idx}-${Date.now()}`,
          style: idx,
          query,
          mode: "normal",
          caseSensitive: true,
          wholeWord: false,
        });
      };
      return acc;
    }, {}),
    "search.clearAllStyles": () => useNotepadStore.getState().clearMarks(ctx.docKey),
    "search.toggleBookmark": () => {
      const v = ctx.getActiveView();
      if (!v) return;
      const ln0 = v.state.doc.lineAt(v.state.selection.main.head).number - 1;
      useNotepadStore.getState().toggleBookmark(ctx.docKey, ln0);
    },
    "search.nextBookmark": () => {
      const v = ctx.getActiveView();
      if (!v) return;
      const ln0 = v.state.doc.lineAt(v.state.selection.main.head).number - 1;
      const pos = nextBookmarkPos(v.state.doc, ctx.docState.bookmarks, ln0, false);
      if (pos !== null) ctx.jumpToOffset(pos);
    },
    "search.prevBookmark": () => {
      const v = ctx.getActiveView();
      if (!v) return;
      const ln0 = v.state.doc.lineAt(v.state.selection.main.head).number - 1;
      const pos = nextBookmarkPos(v.state.doc, ctx.docState.bookmarks, ln0, true);
      if (pos !== null) ctx.jumpToOffset(pos);
    },
    "search.clearBookmarks": () => useNotepadStore.getState().setBookmarks(ctx.docKey, []),
    "search.cutBookmarkedLines": async () => {
      const res = applyBookmarkLinesOp(ctx.document.content, ctx.docState.bookmarks, "cut");
      await writeText(res.extractedText).catch((error: unknown) => ctx.onError(String(error)));
      if (!ctx.effectiveReadOnly) {
        ctx.replaceViewSelection(ctx.getActiveView(), res.nextText, false);
        useNotepadStore.getState().setBookmarks(ctx.docKey, res.nextBookmarks);
      }
    },
    "search.copyBookmarkedLines": async () => {
      const res = applyBookmarkLinesOp(ctx.document.content, ctx.docState.bookmarks, "copy");
      await writeText(res.extractedText).catch((error: unknown) => ctx.onError(String(error)));
    },
    "search.removeBookmarkedLines": () => {
      if (ctx.effectiveReadOnly) return;
      const res = applyBookmarkLinesOp(ctx.document.content, ctx.docState.bookmarks, "removeBookmarked");
      ctx.replaceViewSelection(ctx.getActiveView(), res.nextText, false);
      useNotepadStore.getState().setBookmarks(ctx.docKey, res.nextBookmarks);
    },
    "search.removeUnmarkedLines": () => {
      if (ctx.effectiveReadOnly) return;
      const res = applyBookmarkLinesOp(ctx.document.content, ctx.docState.bookmarks, "removeUnmarked");
      ctx.replaceViewSelection(ctx.getActiveView(), res.nextText, false);
      useNotepadStore.getState().setBookmarks(ctx.docKey, res.nextBookmarks);
    },
    "search.inverseBookmarks": () => {
      const res = applyBookmarkLinesOp(ctx.document.content, ctx.docState.bookmarks, "inverse");
      useNotepadStore.getState().setBookmarks(ctx.docKey, res.nextBookmarks);
    },

    // View
    "view.wordWrap": () => setNotepadPreferences({ wrap: !useNotepadPreferences.getState().wrap }),
    "view.showWhitespace": () => useNotepadStore.getState().toggleSymbol("space"),
    "view.showEol": () => useNotepadStore.getState().toggleSymbol("eol"),
    "view.showNonPrinting": () => useNotepadStore.getState().toggleSymbol("nonprint"),
    "view.showAllSymbols": () => useNotepadStore.getState().toggleAllSymbols(),
    "view.indentGuide": () => useNotepadStore.getState().toggleSymbol("indent"),
    "view.zoomIn": () => { const s = useNotepadStore.getState(); s.setZoomDelta(s.zoomDelta + 1); },
    "view.zoomOut": () => { const s = useNotepadStore.getState(); s.setZoomDelta(s.zoomDelta - 1); },
    "view.zoomReset": () => useNotepadStore.getState().setZoomDelta(0),
    "view.toggleSplit": () => useNotepadStore.getState().patchDoc(ctx.docKey, { split: !ctx.docState.split }),
    "view.toggleSyncV": () => useNotepadStore.getState().patchDoc(ctx.docKey, { syncScrollV: !ctx.docState.syncScrollV }),
    "view.toggleSyncH": () => useNotepadStore.getState().patchDoc(ctx.docKey, { syncScrollH: !ctx.docState.syncScrollH }),
    ...([
      ["view.toggleDocMap", "minimap"],
      ["view.toggleDocList", "doclist"],
      ["view.toggleCharPanel", "chars"],
      ["view.toggleSearchResults", "results"],
    ] as Array<[string, NotepadPanelId]>).reduce<Record<string, NotepadCommandHandler>>((acc, [id, panel]) => {
      acc[id] = () => useNotepadStore.getState().togglePanel(panel);
      return acc;
    }, {}),
    "view.distractionFree": () => {
      const s = useNotepadStore.getState();
      s.setViewMode(s.viewMode === "focus" ? "" : "focus");
    },

    // Encoding, Macro, Tools, Window, Help
    "encoding.openPicker": () => ctx.setEncodingOpen(true),
    "macro.toggleRecord": () => {
      const st = useNotepadStore.getState();
      if (st.macro.recording) {
        st.patchMacro({ recording: false, recordingDocId: null });
      } else {
        st.patchMacro({ recording: true, recordingDocId: ctx.docKey, buffer: [] });
      }
    },
    "macro.playbackOnce": () => {
      const steps = ctx.toRecordedSteps(useNotepadStore.getState().macro.buffer);
      void runMacroOnce(steps, ctx.macroHost);
    },
    "macro.runMultiple": () => ctx.setMacroModal("runMulti"),
    "macro.saveCurrent": () => ctx.setMacroModal("save"),
    "macro.manage": () => ctx.setMacroModal("manage"),
    "tools.hashDialog": () => ctx.setToolboxKind("hash"),
    "tools.mimeBase64Encode": () => {
      if (ctx.effectiveReadOnly) return;
      const v = ctx.getActiveView();
      if (!v) return;
      const sel = v.state.selection.main;
      const src = sel.empty ? ctx.document.content : v.state.sliceDoc(sel.from, sel.to);
      ctx.replaceViewSelection(v, runMimeTransform("b64e", src), !sel.empty);
    },
    "tools.mimeBase64Decode": () => {
      if (ctx.effectiveReadOnly) return;
      const v = ctx.getActiveView();
      if (!v) return;
      const sel = v.state.selection.main;
      const src = sel.empty ? ctx.document.content : v.state.sliceDoc(sel.from, sel.to);
      try { ctx.replaceViewSelection(v, runMimeTransform("b64d", src), !sel.empty); } catch (e) { ctx.onError(String(e)); }
    },
    "tools.mimeUrlEncode": () => {
      if (ctx.effectiveReadOnly) return;
      const v = ctx.getActiveView();
      if (!v) return;
      const sel = v.state.selection.main;
      const src = sel.empty ? ctx.document.content : v.state.sliceDoc(sel.from, sel.to);
      ctx.replaceViewSelection(v, runMimeTransform("urle", src), !sel.empty);
    },
    "tools.mimeUrlDecode": () => {
      if (ctx.effectiveReadOnly) return;
      const v = ctx.getActiveView();
      if (!v) return;
      const sel = v.state.selection.main;
      const src = sel.empty ? ctx.document.content : v.state.sliceDoc(sel.from, sel.to);
      try { ctx.replaceViewSelection(v, runMimeTransform("urld", src), !sel.empty); } catch (e) { ctx.onError(String(e)); }
    },
    "tools.jsonFormat": () => ctx.setToolboxKind("mime"),
    "tools.compareDiff": () => {
      useNotepadStore.getState().setCompare({
        open: true,
        leftTitle: `${ctx.docState.titleHint || ctx.document.path} (Saved)`,
        leftContent: ctx.document.savedContent,
        rightTitle: `${ctx.docState.titleHint || ctx.document.path} (Current)`,
        rightContent: ctx.document.content,
        ignoreWhitespace: false,
        ignoreCase: false,
      });
    },
    "tools.preferences": () => ctx.setPrefsOpen(true),
    "tools.shortcutMapper": () => ctx.setMapperOpen(true),
    "window.togglePinTab": () => viewerTabHost.pinDoc(ctx.docKey),
    "window.reopenClosedTab": async () => {
      const closed = useRecentFilesStore.getState().popClosed();
      if (closed) await viewerTabHost.openFile(closed.path, ctx.hostCtx);
    },
    "help.about": () => ctx.setAboutOpen(true),
  };
}
