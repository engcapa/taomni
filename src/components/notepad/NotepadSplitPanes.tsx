import { useEffect, useMemo, useRef } from "react";
import type { EditorView } from "@codemirror/view";
import { createSplitScrollCoordinator } from "../../lib/notepad/cm6/splitSync";
import type { SymbolRenderConfig } from "../../lib/notepad/cm6/symbols";
import type { NotepadMarkRule, NotepadSplitOrient } from "../../stores/notepadStore";
import { NotepadCodeMirrorPane, type CursorMetrics } from "./NotepadCodeMirrorPane";

export function NotepadSplitPanes({
  split,
  orient,
  syncScroll,
  activePane,
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
  onChange,
  onCursorMetrics,
  onToggleBookmark,
  onToggleInsertMode,
  onFocusPane,
  onViewsChanged,
}: {
  split: boolean;
  orient: NotepadSplitOrient;
  syncScroll: boolean;
  activePane: 0 | 1;
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
  onChange: (nextText: string) => void;
  onCursorMetrics: (paneIndex: 0 | 1, metrics: CursorMetrics) => void;
  onToggleBookmark: (lineZeroBased: number) => void;
  onToggleInsertMode: (insertMode: boolean) => void;
  onFocusPane: (paneIndex: 0 | 1) => void;
  onViewsChanged: (views: [EditorView | null, EditorView | null]) => void;
}) {
  const viewsRef = useRef<[EditorView | null, EditorView | null]>([null, null]);
  const coord = useMemo(() => createSplitScrollCoordinator(), []);

  const handleViewReady = (idx: 0 | 1, view: EditorView | null) => {
    viewsRef.current[idx] = view;
    onViewsChanged([viewsRef.current[0], viewsRef.current[1]]);
  };

  useEffect(() => {
    if (!split || !syncScroll) return;
    const scroller0 = viewsRef.current[0]?.scrollDOM ?? null;
    const scroller1 = viewsRef.current[1]?.scrollDOM ?? null;
    if (!scroller0 || !scroller1) return;

    const onScroll0 = () => coord.sync(scroller0, scroller1, true, true);
    const onScroll1 = () => coord.sync(scroller1, scroller0, true, true);
    scroller0.addEventListener("scroll", onScroll0, { passive: true });
    scroller1.addEventListener("scroll", onScroll1, { passive: true });
    return () => {
      scroller0.removeEventListener("scroll", onScroll0);
      scroller1.removeEventListener("scroll", onScroll1);
    };
  }, [split, syncScroll, coord]);

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
          fontSizePx={fontSizePx}
          insertMode={insertMode}
          virtualSpace={virtualSpace}
          showChangeHistory={showChangeHistory}
          symbols={symbols}
          bookmarks={bookmarks}
          marks={marks}
          activeMatch={activeMatch}
          onChange={onChange}
          onCursorMetrics={(m) => onCursorMetrics(0, m)}
          onToggleBookmark={onToggleBookmark}
          onToggleInsertMode={onToggleInsertMode}
          onViewReady={handleViewReady}
          onFocusPane={onFocusPane}
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
              fontSizePx={fontSizePx}
              insertMode={insertMode}
              virtualSpace={virtualSpace}
              showChangeHistory={showChangeHistory}
              symbols={symbols}
              bookmarks={bookmarks}
              marks={marks}
              activeMatch={activeMatch}
              onChange={onChange}
              onCursorMetrics={(m) => onCursorMetrics(1, m)}
              onToggleBookmark={onToggleBookmark}
              onToggleInsertMode={onToggleInsertMode}
              onViewReady={handleViewReady}
              onFocusPane={onFocusPane}
            />
          </div>
        </>
      )}
    </div>
  );
}
