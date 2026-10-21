import "./diff/styles";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { EditorView } from "@codemirror/view";
import { MergeView, unifiedMergeView, getChunks } from "@codemirror/merge";
import { ChevronDown, ChevronUp, Columns2, Loader2, RefreshCw, Rows2 } from "lucide-react";
import { buildDiffOverride, eolOnlyDiffLabel, isEolOnlyDiff, type WhitespaceMode } from "../../lib/diffWhitespace";
import { languageForPath } from "./diffLanguage";
import { elementWidth, clampNumber, applyEditorViewportLayout } from "./diff/layout";
import { type DiffViewerProps, type ViewMode, readPref, VIEW_KEY, WS_KEY, SYNC_SCROLL_KEY, writePref } from "./diff/preferences";
import { diffComplexity, formatBytes, formatLines } from "./diff/complexity";
import { baseExtensions } from "./diff/extensions";
import { setupSplitDiffInteractions, scrollChunkIntoView } from "./diff/interactions";
import { DiffNotice, ImageDiff } from "./diff/notices";

export function DiffViewer({
  pair,
  loading,
  emptyLabel,
  onNormalizeLineEndings,
  normalizeLineEndingsBusy = false,
  worktreeEditable = false,
  onSaveWorktree,
  repoRoot,
}: DiffViewerProps) {
  const instanceId = useId().replace(/:/g, "");
  const leftPaneId = `git-diff-left-pane-${instanceId}`;
  const rightPaneId = `git-diff-right-pane-${instanceId}`;
  const [view, setView] = useState<ViewMode>(() => readPref<ViewMode>(VIEW_KEY, "split"));
  const [whitespace, setWhitespace] = useState<WhitespaceMode>(() => readPref<WhitespaceMode>(WS_KEY, "none"));
  const [syncScrolling, setSyncScrolling] = useState(
    () => readPref<"true" | "false">(SYNC_SCROLL_KEY, "true") !== "false",
  );
  const [highlightWords, setHighlightWords] = useState(true);
  const [diffCount, setDiffCount] = useState(0);
  const [forceRenderLargeDiffKey, setForceRenderLargeDiffKey] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const mergeRef = useRef<MergeView | null>(null);
  const unifiedRef = useRef<EditorView | null>(null);
  const scrollCleanupRef = useRef<(() => void) | null>(null);
  const scrollZeroRef = useRef<((views: EditorView[]) => void) | null>(null);
  const cancelScrollZeroRef = useRef<(() => void) | null>(null);
  const preferredRatioRef = useRef(0.5);
  const syncScrollingRef = useRef(syncScrolling);
  const activeChunkIndexRef = useRef(-1);
  const baselineNewTextRef = useRef("");
  const canEditWorktree = worktreeEditable
    && !!onSaveWorktree
    && !!pair
    && !pair.binary
    && !pair.image
    && !pair.oversize
    && pair.newExists
    && pair.newText != null;
  const pairKey = useMemo(
    () => pair
      ? `${pair.path}\0${pair.oldPath ?? ""}\0${pair.oldSize}\0${pair.newSize}\0${pair.oldText ?? ""}\0${pair.newText ?? ""}`
      : "",
    [pair],
  );
  const complexity = useMemo(() => (pair ? diffComplexity(pair) : null), [pairKey, pair]);
  const largeTextDiff = !!complexity?.tooLarge && forceRenderLargeDiffKey !== pairKey;

  const renderable = useMemo(
    () =>
      !!pair &&
      !pair.binary &&
      !pair.image &&
      !pair.oversize &&
      !largeTextDiff &&
      (pair.oldText != null || pair.newText != null),
    [largeTextDiff, pair],
  );

  useEffect(() => writePref(VIEW_KEY, view), [view]);
  useEffect(() => writePref(WS_KEY, whitespace), [whitespace]);
  useEffect(() => writePref(SYNC_SCROLL_KEY, String(syncScrolling)), [syncScrolling]);
  useEffect(() => {
    syncScrollingRef.current = syncScrolling;
  }, [syncScrolling]);

  useEffect(() => {
    setDirty(false);
    baselineNewTextRef.current = pair?.newText ?? "";
  }, [pair]);

  const readWorktreeText = useCallback((): string | null => {
    if (mergeRef.current) return mergeRef.current.b.state.doc.toString();
    if (unifiedRef.current) return unifiedRef.current.state.doc.toString();
    return null;
  }, []);

  const handleSave = useCallback(async () => {
    if (!onSaveWorktree || !canEditWorktree) return;
    const text = readWorktreeText();
    if (text == null) return;
    setSaving(true);
    try {
      await onSaveWorktree(text);
      baselineNewTextRef.current = text;
      setDirty(false);
    } finally {
      setSaving(false);
    }
  }, [canEditWorktree, onSaveWorktree, readWorktreeText]);

  // BUILD_EFFECT
  useEffect(() => {
    let cancelled = false;
    let correctionFrame = 0;
    let correctionGeneration = 0;
    let viewportCleanup: (() => void) | null = null;

    const cancelPendingScrollCorrection = () => {
      correctionGeneration += 1;
      if (correctionFrame !== 0) {
        window.cancelAnimationFrame(correctionFrame);
        correctionFrame = 0;
      }
    };

    const scheduleScrollZero = (views: EditorView[]) => {
      cancelPendingScrollCorrection();
      const generation = correctionGeneration;
      correctionFrame = window.requestAnimationFrame(() => {
        correctionFrame = 0;
        if (cancelled || generation !== correctionGeneration) return;
        for (const editorView of views) {
          editorView.requestMeasure({
            read: () => true,
            write: () => {
              if (
                cancelled
                || generation !== correctionGeneration
                || !editorView.dom.isConnected
                || elementWidth(editorView.dom) <= 0
              ) return;
              editorView.scrollDOM.scrollLeft = 0;
            },
          });
        }
      });
    };

    scrollZeroRef.current = scheduleScrollZero;
    cancelScrollZeroRef.current = cancelPendingScrollCorrection;
    const teardown = () => {
      cancelPendingScrollCorrection();
      viewportCleanup?.();
      viewportCleanup = null;
      scrollCleanupRef.current?.();
      scrollCleanupRef.current = null;
      mergeRef.current?.destroy();
      mergeRef.current = null;
      unifiedRef.current?.destroy();
      unifiedRef.current = null;
    };
    teardown();
    setDiffCount(0);
    activeChunkIndexRef.current = -1;
    const host = hostRef.current;
    if (loading || !host || !renderable || !pair) {
      return () => {
        cancelled = true;
        teardown();
        if (scrollZeroRef.current === scheduleScrollZero) scrollZeroRef.current = null;
        if (cancelScrollZeroRef.current === cancelPendingScrollCorrection) cancelScrollZeroRef.current = null;
      };
    }
    host.innerHTML = "";
    const oldText = pair.oldText ?? "";
    const newText = pair.newText ?? "";
    baselineNewTextRef.current = newText;
    const override = buildDiffOverride(whitespace);
    const diffConfig = override ? { override } : undefined;
    const editable = canEditWorktree;
    const updateListener = editable
      ? EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        cancelPendingScrollCorrection();
        const text = update.state.doc.toString();
        setDirty(text !== baselineNewTextRef.current);
      })
      : null;

    void languageForPath(pair.path)
      .then((language) => {
        if (cancelled || hostRef.current !== host) return;
        if (view === "split") {
          const bExtensions = [
            ...baseExtensions(language, editable),
            ...(updateListener ? [updateListener] : []),
          ];
          const mv = new MergeView({
            a: { doc: oldText, extensions: baseExtensions(language, false) },
            b: { doc: newText, extensions: bExtensions },
            parent: host,
            orientation: "a-b",
            highlightChanges: highlightWords,
            gutter: true,
            diffConfig,
          });
          mergeRef.current = mv;
          scrollCleanupRef.current = setupSplitDiffInteractions(mv, {
            isSyncEnabled: () => syncScrollingRef.current,
            readPreferredRatio: () => preferredRatioRef.current,
            commitPreferredRatio: (ratio) => {
              preferredRatioRef.current = clampNumber(ratio, 0, 1);
            },
            leftPaneId,
            rightPaneId,
            cancelPendingScrollCorrection,
            onLayoutReady: () => scheduleScrollZero([mv.a, mv.b]),
          });
          setDiffCount(mv.chunks.length);
        } else {
          const uv = new EditorView({
            doc: newText,
            parent: host,
            extensions: [
              ...baseExtensions(language, editable),
              ...(updateListener ? [updateListener] : []),
              unifiedMergeView({
                original: oldText,
                mergeControls: false,
                highlightChanges: highlightWords,
                gutter: true,
                diffConfig,
              }),
            ],
          });
          unifiedRef.current = uv;
          uv.scrollDOM.dataset.testid = "git-diff-right-scroll";
          applyEditorViewportLayout(uv);
          const cancelUnifiedCorrection = () => cancelPendingScrollCorrection();
          for (const target of [uv.scrollDOM, uv.dom]) {
            target.addEventListener("wheel", cancelUnifiedCorrection, { passive: true });
            target.addEventListener("pointerdown", cancelUnifiedCorrection, { passive: true });
            target.addEventListener("touchstart", cancelUnifiedCorrection, { passive: true });
            target.addEventListener("beforeinput", cancelUnifiedCorrection);
            target.addEventListener("input", cancelUnifiedCorrection);
          }
          let wasUsable = elementWidth(uv.dom) > 0;
          const unifiedResizeObserver = typeof ResizeObserver !== "undefined"
            ? new ResizeObserver(() => {
              const usable = elementWidth(uv.dom) > 0;
              if (usable && !wasUsable) scheduleScrollZero([uv]);
              wasUsable = usable;
            })
            : null;
          unifiedResizeObserver?.observe(uv.dom);
          viewportCleanup = () => {
            unifiedResizeObserver?.disconnect();
            for (const target of [uv.scrollDOM, uv.dom]) {
              target.removeEventListener("wheel", cancelUnifiedCorrection);
              target.removeEventListener("pointerdown", cancelUnifiedCorrection);
              target.removeEventListener("touchstart", cancelUnifiedCorrection);
              target.removeEventListener("beforeinput", cancelUnifiedCorrection);
              target.removeEventListener("input", cancelUnifiedCorrection);
            }
          };
          uv.requestMeasure();
          scheduleScrollZero([uv]);
          setDiffCount(getChunks(uv.state)?.chunks.length ?? 0);
        }
      })
      .catch(() => {
        /* language load failure: leave host empty */
      });

    return () => {
      cancelled = true;
      teardown();
      if (scrollZeroRef.current === scheduleScrollZero) scrollZeroRef.current = null;
      if (cancelScrollZeroRef.current === cancelPendingScrollCorrection) cancelScrollZeroRef.current = null;
    };
  }, [canEditWorktree, highlightWords, leftPaneId, loading, pair, renderable, rightPaneId, view, whitespace]);

  const goToChunk = useCallback((direction: 1 | -1) => {
    const mv = mergeRef.current;
    const uv = unifiedRef.current;
    const chunks = mv?.chunks ?? (uv ? getChunks(uv.state)?.chunks : null) ?? [];
    if (chunks.length === 0) return;

    const current = activeChunkIndexRef.current;
    const next =
      current < 0 || current >= chunks.length
        ? direction < 0
          ? chunks.length - 1
          : 0
        : (current + direction + chunks.length) % chunks.length;
    activeChunkIndexRef.current = next;
    const chunk = chunks[next];

    if (mv) {
      scrollChunkIntoView(mv.a, chunk, "a");
      scrollChunkIntoView(mv.b, chunk, "b");
      mv.b.focus();
      scrollZeroRef.current?.([mv.a, mv.b]);
      return;
    }

    if (uv) {
      scrollChunkIntoView(uv, chunk, "b");
      uv.focus();
      scrollZeroRef.current?.([uv]);
    }
  }, []);
  const goNext = useCallback(() => goToChunk(1), [goToChunk]);
  const goPrev = useCallback(() => goToChunk(-1), [goToChunk]);

  // RENDER
  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-[var(--taomni-text-muted)]">
        <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading diff
      </div>
    );
  }
  if (!pair) {
    return <DiffNotice text={emptyLabel ?? "Select an item to preview its diff"} />;
  }
  if (pair.oversize) {
    return (
      <DiffNotice
        text={`File too large to display a diff (${formatBytes(pair.oldSize)} → ${formatBytes(pair.newSize)}).`}
      />
    );
  }
  if (pair.image) {
    return <ImageDiff pair={pair} />;
  }
  if (pair.binary) {
    return (
      <DiffNotice
        text={`Binary file — no text diff available (${formatBytes(pair.oldSize)} → ${formatBytes(pair.newSize)}).`}
      />
    );
  }
  if (largeTextDiff && complexity) {
    return (
      <DiffNotice
        path={pair.path}
        text={`Large text diff skipped (${formatBytes(pair.oldSize)} to ${formatBytes(pair.newSize)}, ${formatLines(complexity.maxLines)}).`}
      >
        <button
          className="taomni-btn h-7 px-2 mt-3"
          type="button"
          data-testid="git-diff-render-anyway"
          onClick={() => setForceRenderLargeDiffKey(pairKey)}
        >
          Render anyway
        </button>
      </DiffNotice>
    );
  }

  const eolOnly = isEolOnlyDiff(pair.oldText, pair.newText);
  const eolLabel = eolOnly && pair.oldText != null && pair.newText != null
    ? eolOnlyDiffLabel(pair.oldText, pair.newText)
    : null;

  return (
    <div
      data-testid="git-diff-viewer"
      data-path={pair.path}
      data-repo-root={repoRoot ?? undefined}
      className="h-full min-h-0 min-w-0 w-full flex flex-col bg-[var(--taomni-panel-bg)]"
    >
      {eolOnly && eolLabel ? (
        <div
          data-testid="git-diff-eol-only-banner"
          className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-amber-500/40 bg-amber-500/10 text-[11px] text-amber-700 dark:text-amber-300"
        >
          <span className="min-w-0 flex-1">{eolLabel}</span>
          {onNormalizeLineEndings ? (
            <button
              type="button"
              className="taomni-btn h-6 px-2 shrink-0"
              data-testid="git-diff-normalize-eol"
              disabled={normalizeLineEndingsBusy}
              onClick={onNormalizeLineEndings}
            >
              {normalizeLineEndingsBusy ? "Normalizing…" : "Normalize line endings"}
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="h-10 shrink-0 flex items-center gap-2 px-3 border-b border-[var(--taomni-divider)] text-[12px] bg-[var(--taomni-chrome-bg)]">
        <div className="inline-flex rounded-md p-0.5 bg-[var(--taomni-hover)] border border-[var(--taomni-divider)]">
          <button
            type="button"
            data-testid="git-diff-mode-split"
            title="Side-by-side (Split)"
            className={`h-6 px-2.5 rounded text-[11px] font-medium inline-flex items-center gap-1.5 transition-all duration-150 ${view === "split" ? "bg-[var(--taomni-card-bg)] text-[var(--taomni-text)] shadow-sm" : "text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)]"}`}
            onClick={() => setView("split")}
          >
            <Columns2 className="w-3.5 h-3.5" /> Split
          </button>
          <button
            type="button"
            data-testid="git-diff-mode-unified"
            title="Unified"
            className={`h-6 px-2.5 rounded text-[11px] font-medium inline-flex items-center gap-1.5 transition-all duration-150 ${view === "unified" ? "bg-[var(--taomni-card-bg)] text-[var(--taomni-text)] shadow-sm" : "text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)]"}`}
            onClick={() => setView("unified")}
          >
            <Rows2 className="w-3.5 h-3.5" /> Unified
          </button>
        </div>

        <div className="h-4 w-[1px] bg-[var(--taomni-divider)] mx-1" />

        {view === "split" && (
          <button
            type="button"
            data-testid="git-diff-sync-scroll"
            title={syncScrolling ? "Synchronize scrolling: on" : "Synchronize scrolling: off"}
            aria-pressed={syncScrolling}
            className={`h-7 w-7 rounded-md inline-flex items-center justify-center border transition-all duration-150 cursor-pointer ${syncScrolling
                ? "border-[var(--taomni-accent-soft)] bg-[color-mix(in_srgb,var(--taomni-accent)_15%,transparent)] text-[var(--taomni-accent)]"
                : "border-[var(--taomni-divider)] bg-[var(--taomni-card-bg)] text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)] hover:bg-[var(--taomni-hover)]"
              }`}
            onClick={() => setSyncScrolling((current) => !current)}
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span className="sr-only">Synchronize scrolling</span>
          </button>
        )}

        <select
          className="h-7 bg-[var(--taomni-input-bg)] border border-[var(--taomni-input-border)] rounded-md px-2 text-[11px] text-[var(--taomni-text)] hover:border-[var(--taomni-accent-soft)] focus:outline-none transition-all duration-150 cursor-pointer"
          value={whitespace}
          title="Whitespace"
          onChange={(e) => setWhitespace(e.target.value as WhitespaceMode)}
        >
          <option value="none">Do not ignore whitespace</option>
          <option value="trailing">Ignore trailing whitespace</option>
          <option value="all">Ignore all whitespace</option>
        </select>

        <label className="inline-flex items-center gap-1.5 select-none text-[11px] font-medium text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)] cursor-pointer transition-all duration-150" title="Highlight changed words">
          <input
            type="checkbox"
            className="rounded border-[var(--taomni-input-border)] text-[var(--taomni-accent)] focus:ring-[var(--taomni-accent-soft)] w-3.5 h-3.5 cursor-pointer bg-[var(--taomni-input-bg)]"
            checked={highlightWords}
            onChange={(e) => setHighlightWords(e.target.checked)}
          />
          <span>Highlight words</span>
        </label>

        <div className="flex-1" />

        {canEditWorktree ? (
          <button
            type="button"
            className="taomni-btn h-7 px-2"
            data-testid="git-diff-save-worktree"
            disabled={!dirty || saving}
            onClick={() => void handleSave()}
            title="Save worktree file"
          >
            {saving ? "Saving…" : dirty ? "Save" : "Saved"}
          </button>
        ) : null}

        <span className="text-[11px] font-medium text-[var(--taomni-text-muted)] bg-[var(--taomni-hover)] px-2.5 py-0.5 rounded-full border border-[var(--taomni-divider)]">
          {diffCount === 0 ? "No differences" : `${diffCount} difference${diffCount === 1 ? "" : "s"}`}
        </span>

        <div className="flex items-center gap-1">
          <button
            className="h-7 w-7 rounded-md inline-flex items-center justify-center border border-[var(--taomni-divider)] bg-[var(--taomni-card-bg)] text-[var(--taomni-text)] hover:bg-[var(--taomni-hover)] disabled:opacity-40 disabled:hover:bg-[var(--taomni-card-bg)] transition-all duration-150 cursor-pointer"
            type="button"
            data-testid="git-diff-prev"
            title="Previous change"
            disabled={!diffCount}
            onClick={goPrev}
          >
            <ChevronUp className="w-4 h-4" />
          </button>
          <button
            className="h-7 w-7 rounded-md inline-flex items-center justify-center border border-[var(--taomni-divider)] bg-[var(--taomni-card-bg)] text-[var(--taomni-text)] hover:bg-[var(--taomni-hover)] disabled:opacity-40 disabled:hover:bg-[var(--taomni-card-bg)] transition-all duration-150 cursor-pointer"
            type="button"
            data-testid="git-diff-next"
            title="Next change"
            disabled={!diffCount}
            onClick={goNext}
          >
            <ChevronDown className="w-4 h-4" />
          </button>
        </div>
      </div>
      <div ref={hostRef} className="taomni-diff-host flex-1 min-h-0 min-w-0 w-full overflow-hidden" />
    </div>
  );
}
