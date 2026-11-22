import { useEffect, useMemo, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, highlightActiveLineGutter, lineNumbers } from "@codemirror/view";
import { indentUnit } from "@codemirror/language";
import {
  buildNotepadExtensions,
  buildNotepadTheme,
  createNotepadCompartments,
} from "../../lib/notepad/cm6/extensions";
import {
  clearChangeHistoryEffect,
  markHistoryBaselineEffect,
  setBookmarksEffect,
  setShowChangeHistoryEffect,
} from "../../lib/notepad/cm6/bookmarksAndHistory";
import { setMarkHighlightsEffect, type FindHighlightSpec } from "../../lib/notepad/cm6/marksAndTokens";
import {
  setOverwriteModeEffect,
  setVirtualSpaceEffect,
} from "../../lib/notepad/cm6/overwriteAndVirtualSpace";
import { syncViewDocumentText } from "../../lib/notepad/cm6/splitSync";
import { setSymbolConfigEffect, type SymbolRenderConfig } from "../../lib/notepad/cm6/symbols";
import type { NotepadMarkRule } from "../../stores/notepadStore";

export interface CursorMetrics {
  line: number;
  column: number;
  offset: number;
  selChars: number;
  selLines: number;
  from: number;
  to: number;
}

export function NotepadCodeMirrorPane({
  paneIndex,
  testId,
  content,
  savedLines,
  readOnly,
  wrap,
  showLineNumbers,
  fontSizePx,
  insertMode,
  virtualSpace,
  showChangeHistory,
  symbols,
  bookmarks,
  marks,
  activeMatch,
  findHighlight = null,
  historyResetNonce = 0,
  initialSelection,
  initialScroll,
  onChange,
  onUserTextInsert,
  onScrollPosition,
  onCursorMetrics,
  onToggleBookmark,
  onToggleInsertMode,
  onViewReady,
  onFocusPane,
  onContextMenuRequest,
}: {
  paneIndex: 0 | 1;
  testId: string;
  content: string;
  savedLines: string[];
  readOnly: boolean;
  wrap: boolean;
  showLineNumbers: boolean;
  fontSizePx: number;
  insertMode: boolean;
  virtualSpace: boolean;
  showChangeHistory: boolean;
  symbols: SymbolRenderConfig;
  bookmarks: number[];
  marks: NotepadMarkRule[];
  activeMatch: { from: number; to: number } | null;
  findHighlight?: FindHighlightSpec | null;
  historyResetNonce?: number;
  initialSelection?: { from: number; to: number };
  initialScroll?: { top: number; left: number };
  onChange: (nextText: string) => void;
  onUserTextInsert?: (text: string) => void;
  onScrollPosition?: (top: number, left: number) => void;
  onCursorMetrics: (metrics: CursorMetrics) => void;
  onToggleBookmark: (lineZeroBased: number) => void;
  onToggleInsertMode: (insertMode: boolean) => void;
  onViewReady: (paneIndex: 0 | 1, view: EditorView | null) => void;
  onFocusPane: (paneIndex: 0 | 1) => void;
  /** U3: open the app-style Notepad context menu instead of the WebView menu. */
  onContextMenuRequest?: (request: { x: number; y: number; paneIndex: 0 | 1 }) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const isSyncingFromPropRef = useRef(false);
  const lastMetricsRef = useRef<CursorMetrics | null>(null);
  const lastResetNonceRef = useRef(historyResetNonce);
  const compartments = useMemo(() => createNotepadCompartments(), []);
  const latest = useRef({
    onChange,
    onUserTextInsert,
    onScrollPosition,
    onCursorMetrics,
    onToggleBookmark,
    onToggleInsertMode,
    onFocusPane,
  });
  latest.current = {
    onChange,
    onUserTextInsert,
    onScrollPosition,
    onCursorMetrics,
    onToggleBookmark,
    onToggleInsertMode,
    onFocusPane,
  };

  useEffect(() => {
    const parent = hostRef.current;
    if (!parent) return;

    const emitMetrics = (view: EditorView) => {
      const sel = view.state.selection.main;
      const headLine = view.state.doc.lineAt(sel.head);
      const fromLine = view.state.doc.lineAt(sel.from).number;
      const toLine = view.state.doc.lineAt(sel.to).number;
      const next: CursorMetrics = {
        line: headLine.number,
        column: sel.head - headLine.from + 1,
        offset: sel.head,
        selChars: Math.abs(sel.to - sel.from),
        selLines: sel.empty ? 0 : toLine - fromLine + 1,
        from: sel.from,
        to: sel.to,
      };
      const prev = lastMetricsRef.current;
      if (
        prev &&
        prev.line === next.line &&
        prev.column === next.column &&
        prev.offset === next.offset &&
        prev.selChars === next.selChars &&
        prev.selLines === next.selLines &&
        prev.from === next.from &&
        prev.to === next.to
      ) {
        return;
      }
      lastMetricsRef.current = next;
      latest.current.onCursorMetrics(next);
    };

    const clampedAnchor = initialSelection ? Math.max(0, Math.min(initialSelection.from, content.length)) : 0;
    const clampedHead = initialSelection ? Math.max(0, Math.min(initialSelection.to, content.length)) : 0;
    const view = new EditorView({
      state: EditorState.create({
        doc: content,
        selection: { anchor: clampedAnchor, head: clampedHead },
        extensions: buildNotepadExtensions({
          compartments,
          readOnly,
          wrap,
          showLineNumbers,
          fontSizePx,
          tabSize: symbols.tabSize,
          symbols,
          bookmarks,
          baselineLines: savedLines,
          showChangeHistory,
          marks,
          onToggleBookmark: (ln0) => latest.current.onToggleBookmark(ln0),
          onToggleInsertMode: (ins) => latest.current.onToggleInsertMode(ins),
          onUpdate: (v) => {
            if (v.hasFocus) latest.current.onFocusPane(paneIndex);
            emitMetrics(v);
          },
        }).concat(
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              if (!isSyncingFromPropRef.current && !update.view.composing) {
                for (const tr of update.transactions) {
                  if (tr.isUserEvent("input")) {
                    let inserted = "";
                    tr.changes.iterChanges((_fromA, _toA, _fromB, _toB, text) => {
                      inserted += text.toString();
                    });
                    if (inserted) latest.current.onUserTextInsert?.(inserted);
                  }
                }
              }
              latest.current.onChange(update.state.doc.toString());
            }
          }),
        ),
      }),
      parent,
    });

    const handleScroll = () => {
      latest.current.onScrollPosition?.(view.scrollDOM.scrollTop, view.scrollDOM.scrollLeft);
    };
    view.scrollDOM.addEventListener("scroll", handleScroll, { passive: true });

    viewRef.current = view;
    onViewReady(paneIndex, view);
    emitMetrics(view);
    if (initialScroll && (initialScroll.top > 0 || initialScroll.left > 0)) {
      requestAnimationFrame(() => {
        if (viewRef.current === view) {
          view.scrollDOM.scrollTop = initialScroll.top;
          view.scrollDOM.scrollLeft = initialScroll.left;
        }
      });
    }

    return () => {
      view.scrollDOM.removeEventListener("scroll", handleScroll);
      onViewReady(paneIndex, null);
      view.destroy();
      viewRef.current = null;
    };
    // Mount per pane lifecycle; configuration updates flow through Effects/Compartments below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneIndex, compartments]);

  useEffect(() => {
    // Fast native/WebDriver key streams can update CodeMirror between React
    // renders: the `content` prop arriving here may still be the previous
    // document, and rebuilding the view from it would reorder or duplicate the
    // user's text. Defer the external-sync check to the next animation frame so
    // an in-flight local edit can finish rendering; if the view already holds
    // the latest content the diff is a no-op.
    const frame = requestAnimationFrame(() => {
      const view = viewRef.current;
      if (!view) return;
      if (view.state.doc.toString() === content) return;
      isSyncingFromPropRef.current = true;
      try {
        syncViewDocumentText(view, content);
      } finally {
        isSyncingFromPropRef.current = false;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [content]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: [
        compartments.readOnly.reconfigure(EditorState.readOnly.of(readOnly)),
        compartments.editable.reconfigure(EditorView.editable.of(!readOnly)),
        compartments.wrap.reconfigure(wrap ? EditorView.lineWrapping : []),
        compartments.lineNumbers.reconfigure(
          showLineNumbers ? [lineNumbers(), highlightActiveLineGutter()] : [],
        ),
        compartments.theme.reconfigure(buildNotepadTheme(fontSizePx)),
        compartments.tabSize.reconfigure([
          EditorState.tabSize.of(symbols.tabSize),
          indentUnit.of(" ".repeat(symbols.tabSize)),
        ]),
      ],
    });
  }, [compartments, readOnly, wrap, showLineNumbers, fontSizePx, symbols.tabSize]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: [
        setOverwriteModeEffect.of(!insertMode),
        setVirtualSpaceEffect.of(virtualSpace),
        setSymbolConfigEffect.of(symbols),
        setBookmarksEffect.of(bookmarks),
        setMarkHighlightsEffect.of({ rules: marks, activeMatch, findHighlight }),
        setShowChangeHistoryEffect.of(showChangeHistory),
      ],
    });
  }, [insertMode, virtualSpace, symbols, bookmarks, marks, activeMatch, findHighlight, showChangeHistory]);

  useEffect(() => {
    if (historyResetNonce !== lastResetNonceRef.current) {
      lastResetNonceRef.current = historyResetNonce;
      viewRef.current?.dispatch({
        effects: clearChangeHistoryEffect.of(savedLines),
      });
      return;
    }
    viewRef.current?.dispatch({
      effects: markHistoryBaselineEffect.of(savedLines),
    });
  }, [savedLines, historyResetNonce]);

  return (
    <div
      ref={hostRef}
      data-testid={testId}
      className="np-pane-host"
      onMouseDown={() => onFocusPane(paneIndex)}
      onContextMenu={(event) => {
        if (!onContextMenuRequest) return;
        // U3: suppress the WebView/browser default menu and let the workbench
        // render its Notepad command menu (read-only still opens it; write rows
        // are disabled there).
        event.preventDefault();
        event.stopPropagation();
        onContextMenuRequest({ x: event.clientX, y: event.clientY, paneIndex });
      }}
    />
  );
}
