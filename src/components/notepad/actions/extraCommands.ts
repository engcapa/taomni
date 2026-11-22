import type { EditorView } from "@codemirror/view";
import { openExplorer } from "../../../lib/explorer/openExplorer";
import { parentPath, sftpOpenPath } from "../../../lib/sftp";
import { openFile } from "../../../lib/openFile";
import { setFileOpenPreferences, useFileOpenPreferences } from "../../../lib/openFile/preferences";
import { isUntitledKey } from "../../../lib/openFile/pathIdentity";
import { getAppThemeMode, setAppThemeMode } from "../../../lib/appTheme";
import { loadValidatedMacros } from "../../../lib/notepad/macro/macroManager";
import { viewerTabHost } from "../../../lib/notepad/host/viewerTabHost";
import { viewerSetReadonlyAttr } from "../../../lib/notepad/ipc";
import { insertBlankLineAbove, insertBlankLineBelow, shuffleLines } from "../../../lib/notepad/transforms/lines";
import { spacesToTabsAll } from "../../../lib/notepad/transforms/whitespace";
import { useRecentFilesStore } from "../../../stores/app/recentFiles";
import { useDocumentStore } from "../../../stores/documentStore";
import { setNotepadPreferences, useNotepadPreferences } from "../../../stores/notepadPreferences";
import { useNotepadStore } from "../../../stores/notepadStore";
import type { NotepadCommandHandler } from "../../../lib/notepad/commands/types";
import type { NotepadActionContext } from "./context";
import { resolveNotepadSaveAsDefaults } from "./saveDefaults";

/**
 * Extended Notepad command handlers for the prototype-parity menu: file
 * lifecycle extras, editing helpers, selection-based search, change history,
 * view modes, text tools and compare entry points. The core editing and search
 * commands live in coreCommands.ts.
 */

const REDACT_BLOCK = "█";
const REDACT_DOT = "●";

function activeView(ctx: NotepadActionContext): EditorView | null {
  return ctx.getActiveView();
}

function selectionText(ctx: NotepadActionContext): string {
  const view = activeView(ctx);
  if (!view) return "";
  const sel = view.state.selection.main;
  return view.state.sliceDoc(sel.from, sel.to);
}

function replaceSelection(ctx: NotepadActionContext, text: string): void {
  const view = activeView(ctx);
  if (!view || ctx.effectiveReadOnly) return;
  ctx.replaceViewSelection(view, text, true);
}

function currentLineStartOffset(content: string, line0: number): number {
  const lines = content.split("\n");
  let offset = 0;
  for (let index = 0; index < Math.min(line0, lines.length); index += 1) offset += lines[index].length + 1;
  return offset;
}

/** Changed line indexes (0-based) between the saved baseline and the buffer. */
export function changedLineIndexes(content: string, savedContent: string): number[] {
  const current = content.split("\n");
  const saved = savedContent.split("\n");
  const changed: number[] = [];
  const max = Math.max(current.length, saved.length);
  for (let index = 0; index < max; index += 1) {
    if (current[index] !== saved[index]) changed.push(index);
  }
  return changed;
}

function effectiveSavedContent(ctx: NotepadActionContext): string {
  return ctx.docState.changeHistoryBaseline?.join("\n") ?? ctx.document.savedContent;
}

function moveToChangedLine(ctx: NotepadActionContext, direction: -1 | 1): void {
  const changed = changedLineIndexes(ctx.document.content, effectiveSavedContent(ctx));
  if (changed.length === 0) {
    ctx.onError("No changes to navigate.");
    return;
  }
  const view = activeView(ctx);
  const line0 = view ? view.state.doc.lineAt(view.state.selection.main.head).number - 1 : 0;
  const candidates = changed.filter((line) => (direction > 0 ? line > line0 : line < line0));
  const target = direction > 0
    ? (candidates.length > 0 ? candidates[0] : changed[0])
    : (candidates.length > 0 ? candidates[candidates.length - 1] : changed[changed.length - 1]);
  const start = currentLineStartOffset(ctx.document.content, target);
  const lineEnd = ctx.document.content.indexOf("\n", start);
  ctx.jumpToOffset(start, lineEnd === -1 ? ctx.document.content.length : lineEnd);
}

function applyCaseKind(ctx: NotepadActionContext, kind: Parameters<NotepadActionContext["applyCaseOp"]>[0]): void {
  const view = activeView(ctx);
  const sel = view?.state.selection.main;
  if (!view || !sel || sel.from === sel.to) {
    ctx.onError("Select text to convert case.");
    return;
  }
  ctx.applyCaseOp(kind);
}

async function copySelectionOr(_ctx: NotepadActionContext, compute: () => string): Promise<void> {
  const text = compute();
  if (!text) return;
  await navigator.clipboard?.writeText(text).catch(() => undefined);
  useNotepadStore.getState().pushClipboardHistory(text);
}

export function createExtraCommandMap(ctx: NotepadActionContext): Record<string, NotepadCommandHandler> {
  return {
    // ── File lifecycle extras ────────────────────────────────────────────────
    "file.saveCopy": async () => {
      const defaults = await resolveNotepadSaveAsDefaults(ctx.document.path, ctx.docState.titleHint || "");
      ctx.setLifecycleModal({ kind: "saveAs", ...defaults, copy: true });
    },
    "file.openWith": () => ctx.setPickerModal({ kind: "openWith", path: ctx.document.path }),
    "file.openExternalDefault": async () => {
      if (isUntitledKey(ctx.document.path)) return;
      await sftpOpenPath(ctx.document.path).catch((error) => ctx.onError(String(error)));
    },
    "file.showInFileManager": async () => {
      if (isUntitledKey(ctx.document.path)) {
        ctx.onError("Save the document before revealing it in Explorer.");
        return;
      }
      await openExplorer(parentPath(ctx.document.path)).catch((error) => ctx.onError(String(error)));
    },
    "file.printNow": () => {
      void import("../../../lib/notepad/print/printDocument")
        .then(({ printNotepadDocument }) => printNotepadDocument({
          title: ctx.docState.titleHint || ctx.document.path,
          content: ctx.document.content,
          settings: { ...useNotepadPreferences.getState().printDefaults, lineNumbers: useNotepadPreferences.getState().showLineNumbers },
          fontSizePx: useNotepadPreferences.getState().fontSize,
        }))
        .catch((error) => ctx.onError(String(error)));
    },
    "file.closeUnpinned": () => {
      const open = viewerTabHost.listOpenDocs(ctx.hostCtx).filter((doc) => !doc.pinned).map((doc) => doc.docKey);
      viewerTabHost.closeMany(open, { keepPinned: true, host: ctx.hostCtx.host, workspaceId: ctx.hostCtx.workspaceId });
    },
    "file.closeLeft": () => closeSideTabs(ctx, "left"),
    "file.closeRight": () => closeSideTabs(ctx, "right"),
    "file.closeUnmodified": () => {
      const docs = useDocumentStore.getState().documents;
      const open = viewerTabHost.listOpenDocs(ctx.hostCtx).filter((doc) => !docs[doc.docKey]?.dirty).map((doc) => doc.docKey);
      viewerTabHost.closeMany(open, { keepPinned: true, host: ctx.hostCtx.host, workspaceId: ctx.hostCtx.workspaceId });
    },
    "file.toggleAllReadonly": () => {
      for (const doc of Object.values(useDocumentStore.getState().documents)) {
        if (doc.kind !== "text" || isUntitledKey(doc.path)) continue;
        useDocumentStore.getState().setEditorReadOnly(doc.path, !doc.readOnly);
      }
    },
    "file.toggleReadonlyAttr": async () => {
      if (isUntitledKey(ctx.document.path)) {
        ctx.onError("Save the document to disk before changing its read-only file attribute.");
        return;
      }
      const liveDoc = useDocumentStore.getState().documents[ctx.docKey] ?? ctx.document;
      const next = !liveDoc.readOnly;
      try {
        await viewerSetReadonlyAttr(ctx.document.path, next);
        useDocumentStore.getState().setEditorReadOnly(ctx.document.path, next);
      } catch (error) {
        ctx.onError(String(error));
      }
    },
    "file.openAllRecentFiles": async () => {
      const recent = useRecentFilesStore.getState().recentFiles.slice(0, 5);
      for (const entry of recent) await viewerTabHost.openFile(entry.path, ctx.hostCtx).catch(() => undefined);
    },
    "file.clearRecentFiles": () => useRecentFilesStore.getState().clearRecent(),

    // ── Editing helpers ──────────────────────────────────────────────────────
    "edit.delete": () => {
      const view = activeView(ctx);
      if (!view || ctx.effectiveReadOnly) return;
      const sel = view.state.selection.main;
      // Delete removes the selection only; with an empty selection the editor's
      // native forward-delete must keep working, so this command is a no-op.
      if (!sel.empty) view.dispatch({ changes: { from: sel.from, to: sel.to } });
    },
    "edit.pasteSpecial": () => ctx.setPickerModal({ kind: "pasteSpecial" }),
    "edit.clipboardHistory": () => ctx.setPickerModal({ kind: "clipboardHistory" }),
    "edit.beginEndSelect": () => {
      const view = activeView(ctx);
      if (!view) return;
      const store = useNotepadStore.getState();
      const anchor = ctx.docState.beginSelectAnchor;
      if (anchor) {
        view.dispatch({ selection: { anchor: anchor.pos, head: view.state.selection.main.head } });
        store.patchDoc(ctx.docKey, { beginSelectAnchor: null });
      } else {
        store.patchDoc(ctx.docKey, { beginSelectAnchor: { pos: view.state.selection.main.head, columnMode: false } });
        ctx.setFindStatus("Selection start set.");
      }
    },
    "edit.selectNextOccurrence": () => {
      const view = activeView(ctx);
      if (!view) return;
      const sel = view.state.selection.main;
      const query = view.state.sliceDoc(sel.from, sel.to);
      if (!query) return;
      const content = view.state.doc.toString();
      const from = content.indexOf(query, sel.to);
      if (from === -1) return;
      view.dispatch({ selection: { anchor: from, head: from + query.length }, scrollIntoView: true });
    },
    "edit.insertDateTimeCustom": () => ctx.setPickerModal({ kind: "insertDate" }),
    "edit.insertBlankLineAbove": () => ctx.applyTransform((text, range) => insertBlankLineAbove(text, range)),
    "edit.insertBlankLineBelow": () => ctx.applyTransform((text, range) => insertBlankLineBelow(text, range)),
    "edit.shuffleLines": () => ctx.applyTransform((text, range) => shuffleLines(text, range, true), { wholeDocLabel: "Randomize Line Order" }),
    "edit.sortCiDesc": () => ctx.applySort({ kind: "ci", descending: true }, "Sort Lines Ignoring Case Descending"),
    "edit.sortLocaleAsc": () => ctx.applySort({ kind: "loc", descending: false }, "Sort Lines Locale Ascending"),
    "edit.sortLocaleDesc": () => ctx.applySort({ kind: "loc", descending: true }, "Sort Lines Locale Descending"),
    "edit.sortNumDesc": () => ctx.applySort({ kind: "int", descending: true }, "Sort Lines as Integers Descending"),
    "edit.sortDecimalCommaAsc": () => ctx.applySort({ kind: "dc", descending: false }, "Sort Lines as Decimal Ascending"),
    "edit.sortDecimalCommaDesc": () => ctx.applySort({ kind: "dc", descending: true }, "Sort Lines as Decimal Descending"),
    "edit.sortDecimalDotAsc": () => ctx.applySort({ kind: "dd", descending: false }, "Sort Lines as Decimal Ascending"),
    "edit.sortDecimalDotDesc": () => ctx.applySort({ kind: "dd", descending: true }, "Sort Lines as Decimal Descending"),
    "edit.sortLenDesc": () => ctx.applySort({ kind: "len", descending: true }, "Sort Lines by Length Descending"),
    "edit.toTitleCaseKeep": () => applyCaseKind(ctx, "properBlend"),
    "edit.toSentenceCase": () => applyCaseKind(ctx, "sentence"),
    "edit.toSentenceCaseKeep": () => applyCaseKind(ctx, "sentenceBlend"),
    "edit.toRandomCase": () => applyCaseKind(ctx, "random"),
    "edit.spacesToTabsAll": () => ctx.applyTransform((text, range) => spacesToTabsAll(text, range, 4, true), { wholeDocLabel: "Space to TAB (All)" }),
    "edit.toggleVirtualSpace": () => useNotepadStore.getState().setVirtualSpace(!useNotepadStore.getState().virtualSpace),
    "edit.toggleChangeHistory": () => setNotepadPreferences({ showChangeHistory: !useNotepadPreferences.getState().showChangeHistory }),
    "edit.pasteReplaceBookmarkedLines": async () => {
      if (ctx.effectiveReadOnly) return;
      const text = await navigator.clipboard?.readText().catch(() => "");
      if (!text) return;
      const lines = text.split(/\r?\n/);
      const bookmarks = [...ctx.docState.bookmarks].sort((a, b) => a - b);
      const content = ctx.document.content.split("\n");
      bookmarks.forEach((line0, index) => {
        if (line0 < content.length) content[line0] = lines[index] ?? lines[lines.length - 1] ?? "";
      });
      ctx.editContent(content.join("\n"));
    },
    "edit.copyDirectoryPath": () => copySelectionOr(ctx, () => parentPath(ctx.document.path)),
    "edit.copyAllOpenPaths": () => copySelectionOr(ctx, () => viewerTabHost.listOpenDocs(ctx.hostCtx).map((doc) => doc.path).filter(Boolean).join("\n")),

    // ── Selection-aware search & change history ──────────────────────────────
    "search.selectAndFind": () => {
      const query = selectionText(ctx);
      if (!query) return;
      useNotepadStore.getState().patchFind(ctx.docKey, { open: true, query });
      ctx.runFindDirection(false);
    },
    "search.selectAndFindVolatile": () => {
      const query = selectionText(ctx);
      if (!query) return;
      ctx.runFindDirection(false, query);
    },
    "search.findAllCurrent": () => {
      const query = ctx.docState.find;
      void import("../../../lib/notepad/search/engine").then(({ findAllMatches, toSearchResultHits }) => {
        const res = findAllMatches(ctx.document.content, query);
        if (res.error) {
          ctx.setFindStatus(res.error);
          return;
        }
        const hits = toSearchResultHits(
          { docId: ctx.docKey, filePath: isUntitledKey(ctx.document.path) ? undefined : ctx.document.path, name: ctx.docState.titleHint || ctx.document.path.split(/[\\/]/).pop() || "Untitled" },
          ctx.document.content,
          res.matches,
        );
        useNotepadStore.getState().setSearchResults(`Find "${query.query}"`, hits);
        useNotepadStore.getState().setPanelPos("results", "bottom");
        useNotepadStore.setState((state) => ({ panels: { ...state.panels, results: { ...state.panels.results, open: true } } }));
      });
    },
    "search.findAllOpen": () => {
      void import("../../../lib/notepad/search/engine").then(({ findAllMatches, toSearchResultHits }) => {
        const query = ctx.docState.find;
        const docs = useDocumentStore.getState().documents;
        const hits = viewerTabHost.listOpenDocs(ctx.hostCtx).flatMap((ref) => {
          const doc = docs[ref.docKey];
          if (!doc) return [];
          const res = findAllMatches(doc.content, query);
          return toSearchResultHits({ docId: ref.docKey, filePath: ref.untitled ? undefined : ref.path, name: ref.title }, doc.content, res.matches);
        });
        useNotepadStore.getState().setSearchResults(`Open Docs "${query.query}"`, hits);
        useNotepadStore.setState((state) => ({ panels: { ...state.panels, results: { ...state.panels.results, open: true } } }));
      });
    },
    "search.replaceAllOpen": () => {
      void import("../../../lib/notepad/search/engine").then(({ replaceAllInText }) => {
        const query = ctx.docState.find;
        const docs = useDocumentStore.getState().documents;
        let count = 0;
        for (const ref of viewerTabHost.listOpenDocs(ctx.hostCtx)) {
          const doc = docs[ref.docKey];
          if (!doc || doc.readOnly || doc.large) continue;
          const res = replaceAllInText(doc.content, query);
          if (res.count > 0) {
            useDocumentStore.getState().edit(doc.path, res.text);
            count += res.count;
          }
        }
        ctx.setFindStatus(`Replaced ${count} occurrence(s) across open documents.`);
      });
    },
    ...([1, 2, 3, 4, 5] as const).reduce<Record<string, NotepadCommandHandler>>((acc, style) => {
      acc[`search.styleTokenClear${style}`] = () => useNotepadStore.getState().clearMarks(ctx.docKey, style);
      return acc;
    }, {}),
    "search.nextChange": () => moveToChangedLine(ctx, 1),
    "search.prevChange": () => moveToChangedLine(ctx, -1),
    "search.clearChangeHistory": () => {
      useNotepadStore.getState().patchDoc(ctx.docKey, {
        activeMatch: null,
        changeHistoryBaseline: ctx.document.content.split("\n"),
        changeHistoryResetNonce: ctx.docState.changeHistoryResetNonce + 1,
      });
      ctx.setFindStatus("Change history cleared.");
    },

    // ── View modes ───────────────────────────────────────────────────────────
    "view.clonePane": () => {
      const store = useNotepadStore.getState();
      store.patchDoc(ctx.docKey, { split: true, activePane: ctx.docState.activePane === 0 ? 1 : 0 });
    },
    "view.rotateSplit": () => {
      useNotepadStore.getState().patchDoc(ctx.docKey, { orient: ctx.docState.orient === "v" ? "h" : "v" });
    },
    "view.toggleLineNumbers": () => setNotepadPreferences({ showLineNumbers: !useNotepadPreferences.getState().showLineNumbers }),
    "view.toggleRuler": () => setNotepadPreferences({ showRuler: !useNotepadPreferences.getState().showRuler }),
    "view.toggleMenubar": () => toggleUiFlag("menubar"),
    "view.toggleToolbar": () => toggleUiFlag("toolbar"),
    "view.toggleStatusbar": () => toggleUiFlag("statusbar"),
    "view.toggleTheme": () => setAppThemeMode(getAppThemeMode() === "dark" ? "light" : "dark"),
    "view.fullscreen": () => toggleViewMode("fullscreen"),
    "view.postIt": () => toggleViewMode("postit"),
    "view.showTab": () => useNotepadStore.getState().toggleSymbol("tab"),

    // ── Text tools ───────────────────────────────────────────────────────────
    "tools.redactBlock": () => {
      const text = selectionText(ctx) || ctx.document.content;
      const redacted = text.replace(/[^\n]/gu, REDACT_BLOCK);
      if (selectionText(ctx)) replaceSelection(ctx, redacted);
      else if (!ctx.effectiveReadOnly) ctx.editContent(redacted);
    },
    "tools.redactDot": () => {
      const text = selectionText(ctx) || ctx.document.content;
      const redacted = text.replace(/[^\n]/gu, REDACT_DOT);
      if (selectionText(ctx)) replaceSelection(ctx, redacted);
      else if (!ctx.effectiveReadOnly) ctx.editContent(redacted);
    },
    "tools.openSelectionPath": async () => {
      const target = selectionText(ctx).trim();
      if (!target) return;
      await openFile({ path: target }, { context: "notepad" }).catch((error) => ctx.onError(String(error)));
    },
    "tools.openSelectionFolder": async () => {
      const target = selectionText(ctx).trim();
      if (!target) return;
      await openExplorer(target.includes("/") || target.includes("\\") ? target : parentPath(target)).catch((error) => ctx.onError(String(error)));
    },
    "tools.searchSelection": () => {
      const query = selectionText(ctx).trim();
      if (!query) return;
      const engine = useNotepadPreferences.getState().searchEngine || "https://www.bing.com/search?q=";
      const url = /%s/.test(engine) ? engine.replace("%s", encodeURIComponent(query)) : `${engine}${encodeURIComponent(query)}`;
      window.open(url, "_blank", "noopener,noreferrer");
    },
    "tools.validateMacros": async () => {
      const result = await loadValidatedMacros().catch(() => null);
      if (!result) {
        ctx.onError("Unable to validate macros file.");
        return;
      }
      ctx.setFindStatus(result.tampered ? "macros.json was modified externally." : "Macros file is valid.");
      useNotepadStore.getState().patchMacro({ tampered: result.tampered, hash: result.expectedHash });
    },
    "tools.compareDisk": () => {
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
    "tools.compareClipboard": async () => {
      const text = await navigator.clipboard?.readText().catch(() => "");
      useNotepadStore.getState().setCompare({
        open: true,
        leftTitle: "Clipboard",
        leftContent: text ?? "",
        rightTitle: ctx.docState.titleHint || ctx.document.path,
        rightContent: ctx.document.content,
        ignoreWhitespace: false,
        ignoreCase: false,
      });
    },
    "tools.compareOther": async () => {
      const text = await navigator.clipboard?.readText().catch(() => "");
      ctx.setPickerModal({
        kind: "comparePick",
        clipboardText: text ?? "",
        savedContent: ctx.document.savedContent,
        savedTitle: ctx.docState.titleHint || ctx.document.path.split(/[\\/]/).pop() || "Untitled",
      });
    },

    // ── Macro ────────────────────────────────────────────────────────────────
    "macro.stopRecord": () => {
      const store = useNotepadStore.getState();
      if (store.macro.recording) store.patchMacro({ recording: false, recordingDocId: null });
    },
  } satisfies Record<string, NotepadCommandHandler>;
}

function toggleUiFlag(key: "menubar" | "toolbar" | "statusbar"): void {
  const store = useNotepadStore.getState();
  store.setUiFlag(key, !store.ui[key]);
}

function toggleViewMode(mode: "fullscreen" | "postit"): void {
  const store = useNotepadStore.getState();
  store.setViewMode(store.viewMode === mode ? "" : mode);
}

function closeSideTabs(ctx: NotepadActionContext, side: "left" | "right"): void {
  const open = viewerTabHost.listOpenDocs(ctx.hostCtx);
  const index = open.findIndex((doc) => doc.docKey === ctx.docKey);
  if (index < 0) return;
  const slice = side === "left" ? open.slice(0, index) : open.slice(index + 1);
  viewerTabHost.closeMany(slice.map((doc) => doc.docKey), { keepPinned: true, host: ctx.hostCtx.host, workspaceId: ctx.hostCtx.workspaceId });
}

// Keep the file preferences module referenced for the Open With remember flow
// that NotepadEditor wires through PickerDialogs.
export function rememberOpenWith(path: string, handler: "system" | "workspace" | "notepad" | "taomni" | "taoffice"): void {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  if (!extension) return;
  const prefs = useFileOpenPreferences.getState();
  setFileOpenPreferences({ associations: { ...prefs.associations, [extension]: handler } });
}
