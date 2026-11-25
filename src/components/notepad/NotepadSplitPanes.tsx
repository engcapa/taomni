import { useEffect, useMemo, useRef } from "react";
import type { EditorView } from "@codemirror/view";
import type { FindHighlightSpec } from "../../lib/notepad/cm6/marksAndTokens";
import { createSplitScrollCoordinator } from "../../lib/notepad/cm6/splitSync";
import type { SymbolRenderConfig } from "../../lib/notepad/cm6/symbols";
import type { NotepadMarkRule, NotepadSplitOrient } from "../../stores/notepadStore";
import { NotepadCodeMirrorPane, type CursorMetrics } from "./NotepadCodeMirrorPane";

export function NotepadSplitPanes({
  split,
  orient,
  syncScroll,
  syncScrollV,
  syncScrollH,
  activePane,
  content,
  savedLines,
  readOnly,
  wrap,
  showLineNumbers,
  fontSizes,
  insertMode,
  virtualSpace,
  showChangeHistory,
  symbols,
  bookmarks,
  marks,
  activeMatch,
  findHighlight = null,
  historyResetNonce = 0,
  paneSelections,
  paneScrolls,
  onChange,
  onUserTextInsert,
  onScrollPosition,
  onCursorMetrics,
  onToggleBookmark,
  onToggleInsertMode,
  onFocusPane,
  onViewsChanged,
  onContextMenuRequest,
}: {
  split: boolean;
  orient: NotepadSplitOrient;
  syncScroll: boolean;
  syncScrollV?: boolean;
  syncScrollH?: boolean;
  activePane: 0 | 1;
  content: string;
  savedLines: string[];
  readOnly: boolean;
  wrap: boolean;
  showLineNumbers: boolean;
  fontSizes: [number, number];
  insertMode: boolean;
  virtualSpace: boolean;
  showChangeHistory: boolean;
  symbols: SymbolRenderConfig;
  bookmarks: number[];
  marks: NotepadMarkRule[];
  activeMatch: { from: number; to: number } | null;
  findHighlight?: FindHighlightSpec | null;
  historyResetNonce?: number;
  paneSelections?: [{ from: number; to: number }, { from: number; to: number }];
  paneScrolls?: [{ top: number; left: number }, { top: number; left: number }];
  onChange: (nextText: string) => void;
  onUserTextInsert?: (text: string) => void;
  onScrollPosition?: (paneIndex: 0 | 1, top: number, left: number) => void;
  onCursorMetrics: (paneIndex: 0 | 1, metrics: CursorMetrics) => void;
  onToggleBookmark: (lineZeroBased: number) => void;
  onToggleInsertMode: (insertMode: boolean) => void;
  onFocusPane: (paneIndex: 0 | 1) => void;
  onViewsChanged: (views: [EditorView | null, EditorView | null]) => void;
  onContextMenuRequest?: (request: { x: number; y: number; paneIndex: 0 | 1 }) => void;
}) {
  const viewsRef = useRef<[EditorView | null, EditorView | null]>([null, null]);
  const coord = useMemo(() => createSplitScrollCoordinator(), []);
  const vSync = syncScrollV ?? syncScroll;
  const hSync = syncScrollH ?? syncScroll;

  const handleViewReady = (idx: 0 | 1, view: EditorView | null) => {
    viewsRef.current[idx] = view;
    onViewsChanged([viewsRef.current[0], viewsRef.current[1]]);
  };

  useEffect(() => {
    if (!split || (!vSync && !hSync)) return;
    const scroller0 = viewsRef.current[0]?.scrollDOM ?? null;
    const scroller1 = viewsRef.current[1]?.scrollDOM ?? null;
    if (!scroller0 || !scroller1) return;

    const onScroll0 = () => coord.sync(scroller0, scroller1, vSync, hSync);
    const onScroll1 = () => coord.sync(scroller1, scroller0, vSync, hSync);
    scroller0.addEventListener("scroll", onScroll0, { passive: true });
    scroller1.addEventListener("scroll", onScroll1, { passive: true });
    return () => {
      scroller0.removeEventListener("scroll", onScroll0);
      scroller1.removeEventListener("scroll", onScroll1);
    };
  }, [split, vSync, hSync, coord]);

  return (
    <div className={`np-panes ${orient === "h" ? "orient-h" : "orient-v"}`}>
      <div className={`np-pane ${activePane === 0 ? "active-pane" : ""}`}>
        <NotepadCodeMirrorPane
          paneIndex={0}
          testId="viewer-editor"
          content={content}
          savedLines={savedLines}
          readOnly={readOnly}
          wrap={wrap}
          showLineNumbers={showLineNumbers}
          fontSizePx={fontSizes[0]}
          insertMode={insertMode}
          virtualSpace={virtualSpace}
          showChangeHistory={showChangeHistory}
          symbols={symbols}
          bookmarks={bookmarks}
          marks={marks}
          activeMatch={activeMatch}
          findHighlight={findHighlight}
          historyResetNonce={historyResetNonce}
          initialSelection={paneSelections?.[0]}
          initialScroll={paneScrolls?.[0]}
          onChange={onChange}
          onUserTextInsert={onUserTextInsert}
          onScrollPosition={(top, left) => onScrollPosition?.(0, top, left)}
          onCursorMetrics={(m) => onCursorMetrics(0, m)}
          onToggleBookmark={onToggleBookmark}
          onToggleInsertMode={onToggleInsertMode}
          onViewReady={handleViewReady}
          onFocusPane={onFocusPane}
          onContextMenuRequest={onContextMenuRequest}
        />
      </div>
      {split && (
        <>
          <div className="np-split-divider" />
          <div className={`np-pane ${activePane === 1 ? "active-pane" : ""}`}>
            <NotepadCodeMirrorPane
              paneIndex={1}
              testId="notepad-editor-secondary"
              content={content}
              savedLines={savedLines}
              readOnly={readOnly}
              wrap={wrap}
              showLineNumbers={showLineNumbers}
              fontSizePx={fontSizes[1]}
              insertMode={insertMode}
              virtualSpace={virtualSpace}
              showChangeHistory={showChangeHistory}
              symbols={symbols}
              bookmarks={bookmarks}
              marks={marks}
              activeMatch={activeMatch}
              findHighlight={findHighlight}
              historyResetNonce={historyResetNonce}
              initialSelection={paneSelections?.[1]}
              initialScroll={paneScrolls?.[1]}
              onChange={onChange}
              onUserTextInsert={onUserTextInsert}
              onScrollPosition={(top, left) => onScrollPosition?.(1, top, left)}
              onCursorMetrics={(m) => onCursorMetrics(1, m)}
              onToggleBookmark={onToggleBookmark}
              onToggleInsertMode={onToggleInsertMode}
              onViewReady={handleViewReady}
              onFocusPane={onFocusPane}
              onContextMenuRequest={onContextMenuRequest}
            />
          </div>
        </>
      )}
    </div>
  );
}
