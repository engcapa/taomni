import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import {
  MergeView,
  unifiedMergeView,
  getChunks,
  type Chunk,
} from "@codemirror/merge";
import { ChevronDown, ChevronUp, Columns2, Loader2, RefreshCw, Rows2 } from "lucide-react";
import type { GitBlobPair } from "../../lib/git";
import { buildDiffOverride, type WhitespaceMode } from "../../lib/diffWhitespace";
import { languageForPath } from "./diffLanguage";

type ViewMode = "split" | "unified";

interface DiffViewerProps {
  pair: GitBlobPair | null;
  loading?: boolean;
  emptyLabel?: string;
}

const VIEW_KEY = "taomni.git.diff.view";
const WS_KEY = "taomni.git.diff.ws";
const SYNC_SCROLL_KEY = "taomni.git.diff.syncScroll";
const MAX_AUTO_RENDER_CHARS = 300_000;
const MAX_AUTO_RENDER_LINES = 12_000;
const CONNECTOR_WIDTH = 36;

function readPref<T extends string>(key: string, fallback: T): T {
  try {
    return (localStorage.getItem(key) as T) || fallback;
  } catch {
    return fallback;
  }
}

function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

const diffTheme = EditorView.theme({
  "&": { backgroundColor: "transparent", color: "var(--taomni-text)", height: "100%" },
  ".cm-scroller": {
    fontFamily: '"JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    fontSize: "var(--taomni-git-diff-font-size)",
    lineHeight: "1.6",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--taomni-text-muted)",
    borderRight: "1px solid var(--taomni-divider)",
  },
  ".cm-content": { caretColor: "transparent" },
});

function baseExtensions(language: Extension | null): Extension[] {
  const ext: Extension[] = [
    lineNumbers(),
    EditorView.editable.of(false),
    EditorState.readOnly.of(true),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    diffTheme,
  ];
  if (language) ext.push(language);
  return ext;
}

// Make the CodeMirror merge/unified editors fill the scroll host.
const STYLE_ID = "taomni-diff-style";
if (typeof document !== "undefined" && !document.getElementById(STYLE_ID)) {
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.taomni-diff-host {
  --taomni-git-diff-font-size: calc(var(--taomni-ui-font-size) + 1px);
  --taomni-diff-editor-bg: #fbfdff;
  --taomni-diff-gutter-bg: #f4f7fb;
  --taomni-diff-text: #142033;
  --taomni-diff-muted: #6b778c;
  --taomni-diff-border: #d9e2ef;
  --taomni-diff-scroll-track: #eef3f8;
  --taomni-diff-scroll-thumb: #bac6d6;
  --taomni-diff-added-bg: rgba(32, 135, 75, 0.14);
  --taomni-diff-added-word: rgba(32, 135, 75, 0.28);
  --taomni-diff-deleted-bg: rgba(210, 63, 79, 0.12);
  --taomni-diff-deleted-word: rgba(210, 63, 79, 0.26);
  --taomni-diff-modified-bg: rgba(42, 111, 201, 0.13);
  --taomni-diff-modified-word: rgba(42, 111, 201, 0.27);
  --taomni-diff-connector-added: rgba(32, 135, 75, 0.2);
  --taomni-diff-connector-deleted: rgba(210, 63, 79, 0.18);
  --taomni-diff-connector-modified: rgba(42, 111, 201, 0.19);
  --taomni-diff-connector-stroke: rgba(91, 111, 140, 0.26);
}

html[data-app-theme="dark"] .taomni-diff-host {
  --taomni-diff-editor-bg: #101720;
  --taomni-diff-gutter-bg: #0c121a;
  --taomni-diff-text: #dce6f3;
  --taomni-diff-muted: #8fa1b6;
  --taomni-diff-border: #243346;
  --taomni-diff-scroll-track: #0c121a;
  --taomni-diff-scroll-thumb: #405067;
  --taomni-diff-added-bg: rgba(48, 170, 102, 0.24);
  --taomni-diff-added-word: rgba(64, 205, 125, 0.4);
  --taomni-diff-deleted-bg: rgba(231, 86, 103, 0.2);
  --taomni-diff-deleted-word: rgba(255, 118, 132, 0.34);
  --taomni-diff-modified-bg: rgba(86, 156, 245, 0.22);
  --taomni-diff-modified-word: rgba(112, 178, 255, 0.36);
  --taomni-diff-connector-added: rgba(48, 170, 102, 0.28);
  --taomni-diff-connector-deleted: rgba(231, 86, 103, 0.24);
  --taomni-diff-connector-modified: rgba(86, 156, 245, 0.26);
  --taomni-diff-connector-stroke: rgba(143, 161, 182, 0.24);
}

.taomni-diff-host .cm-mergeView,
.taomni-diff-host .cm-mergeViewEditors,
.taomni-diff-host .cm-editor {
  height: 100% !important;
  min-height: 0;
}

.taomni-diff-host .cm-mergeView {
  overflow: hidden !important;
  background: var(--taomni-diff-editor-bg);
}

.taomni-diff-host .cm-mergeViewEditors {
  align-items: stretch;
}

.taomni-diff-host .cm-mergeViewEditor {
  min-width: 0;
  min-height: 0;
  background: var(--taomni-diff-editor-bg);
}

.taomni-diff-host .cm-mergeViewEditor + .cm-mergeViewEditor {
  border-left: 1px solid var(--taomni-diff-border);
}

.taomni-diff-host .cm-mergeView .cm-editor .cm-scroller,
.taomni-diff-host > .cm-editor .cm-scroller {
  height: 100% !important;
  overflow: auto !important;
}

.taomni-diff-host .cm-editor,
.taomni-diff-host .cm-mergeView,
.taomni-diff-host .cm-deletedChunk {
  font-family: "JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace !important;
  font-size: var(--taomni-git-diff-font-size) !important;
  line-height: 1.58 !important;
}

.taomni-diff-host .cm-editor {
  background: var(--taomni-diff-editor-bg) !important;
  color: var(--taomni-diff-text) !important;
}

.taomni-diff-host .cm-line {
  color: var(--taomni-diff-text);
}

.taomni-diff-host .cm-gutters {
  background: var(--taomni-diff-gutter-bg) !important;
  color: var(--taomni-diff-muted) !important;
  border-right: 1px solid var(--taomni-diff-border) !important;
}

.taomni-diff-host .cm-activeLine,
.taomni-diff-host .cm-activeLineGutter {
  background: color-mix(in srgb, var(--taomni-accent) 10%, transparent) !important;
}

.taomni-diff-host .cm-selectionBackground,
.taomni-diff-host .cm-focused .cm-selectionBackground {
  background: var(--taomni-editor-selection-bg) !important;
}

.taomni-diff-host .cm-merge-a .cm-changedLine {
  background-color: var(--taomni-diff-deleted-bg) !important;
}

.taomni-diff-host .cm-merge-a .cm-changedText {
  background: var(--taomni-diff-deleted-word) !important;
  border-radius: 2px;
}

.taomni-diff-host .cm-merge-b .cm-changedLine {
  background-color: var(--taomni-diff-added-bg) !important;
}

.taomni-diff-host .cm-merge-b .cm-changedText {
  background: var(--taomni-diff-added-word) !important;
  border-radius: 2px;
}

.taomni-diff-host .cm-deletedChunk {
  background: var(--taomni-diff-deleted-bg) !important;
  border-left: 3px solid #e04f5f !important;
  padding-left: 8px !important;
}

.taomni-diff-host .cm-deletedLine {
  background: transparent !important;
}

.taomni-diff-host .cm-deletedChunk .cm-deletedText {
  background: var(--taomni-diff-deleted-word) !important;
  border-radius: 2px;
}

.taomni-diff-host .cm-inlineChangedLine {
  background: var(--taomni-diff-modified-bg) !important;
}

.taomni-diff-host .cm-merge-a .cm-changedLineGutter,
.taomni-diff-host .cm-deletedLineGutter {
  background: var(--taomni-diff-deleted-bg) !important;
  color: var(--taomni-diff-text) !important;
}

.taomni-diff-host .cm-merge-b .cm-changedLineGutter {
  background: var(--taomni-diff-added-bg) !important;
  color: var(--taomni-diff-text) !important;
}

.taomni-diff-host .cm-inlineChangedLineGutter {
  background: var(--taomni-diff-modified-bg) !important;
  color: var(--taomni-diff-text) !important;
}

.taomni-diff-host .cm-mergeSpacer {
  background: color-mix(in srgb, var(--taomni-diff-border) 28%, transparent) !important;
  background-image: none !important;
}

.taomni-diff-host .taomni-diff-connector {
  position: relative;
  flex: 0 0 ${CONNECTOR_WIDTH}px;
  width: ${CONNECTOR_WIDTH}px;
  min-width: ${CONNECTOR_WIDTH}px;
  height: 100%;
  overflow: hidden;
  background:
    linear-gradient(to right, transparent 0, color-mix(in srgb, var(--taomni-diff-border) 55%, transparent) 50%, transparent 100%),
    var(--taomni-diff-gutter-bg);
  border-left: 1px solid var(--taomni-diff-border);
  border-right: 1px solid var(--taomni-diff-border);
  pointer-events: none;
}

.taomni-diff-host .taomni-diff-connector svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
}

.taomni-diff-host .taomni-diff-connector-path {
  stroke: var(--taomni-diff-connector-stroke);
  stroke-width: 1;
}

.taomni-diff-host .taomni-diff-connector-path.is-added {
  fill: var(--taomni-diff-connector-added);
}

.taomni-diff-host .taomni-diff-connector-path.is-deleted {
  fill: var(--taomni-diff-connector-deleted);
}

.taomni-diff-host .taomni-diff-connector-path.is-modified {
  fill: var(--taomni-diff-connector-modified);
}

.taomni-diff-host .cm-scroller {
  scrollbar-color: var(--taomni-diff-scroll-thumb) var(--taomni-diff-scroll-track);
  scrollbar-width: thin;
}

.taomni-diff-host .cm-scroller::-webkit-scrollbar {
  width: 12px;
  height: 12px;
}

.taomni-diff-host .cm-scroller::-webkit-scrollbar-track {
  background: var(--taomni-diff-scroll-track);
}

.taomni-diff-host .cm-scroller::-webkit-scrollbar-thumb {
  background: var(--taomni-diff-scroll-thumb);
  border: 3px solid var(--taomni-diff-scroll-track);
  border-radius: 6px;
}

.taomni-diff-host .cm-scroller::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--taomni-diff-scroll-thumb) 78%, var(--taomni-diff-text));
}
`;
  document.head.appendChild(style);
}

function imageDataUrl(path: string, b64: string | null): string | null {
  if (!b64) return null;
  const ext = path.toLowerCase().split(".").pop() ?? "";
  const mime =
    ext === "svg" ? "image/svg+xml" : ext === "ico" ? "image/x-icon" : `image/${ext === "jpg" ? "jpeg" : ext}`;
  return `data:${mime};base64,${b64}`;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function chunkKind(chunk: Chunk): "added" | "deleted" | "modified" {
  if (chunk.fromA === chunk.toA) return "added";
  if (chunk.fromB === chunk.toB) return "deleted";
  return "modified";
}

function sideRange(view: EditorView, chunk: Chunk, side: "a" | "b"): { top: number; bottom: number } {
  const docLength = view.state.doc.length;
  const from = side === "a" ? chunk.fromA : chunk.fromB;
  const to = side === "a" ? chunk.toA : chunk.toB;
  const end = side === "a" ? chunk.endA : chunk.endB;
  const empty = from === to;
  const startPos = clampNumber(from, 0, docLength);
  const startBlock = view.lineBlockAt(startPos);
  const top = startBlock.top - view.scrollDOM.scrollTop;
  if (empty) {
    const markerHeight = clampNumber(startBlock.height * 0.25, 4, 8);
    return { top, bottom: top + markerHeight };
  }
  const endPos = clampNumber(Math.max(startPos, end - 1), 0, docLength);
  const endBlock = view.lineBlockAt(endPos);
  return { top, bottom: endBlock.bottom - view.scrollDOM.scrollTop };
}

function connectorPath(left: { top: number; bottom: number }, right: { top: number; bottom: number }, width: number): string {
  const leftTop = Math.round(left.top * 10) / 10;
  const rightTop = Math.round(right.top * 10) / 10;
  const leftBottom = Math.max(leftTop + 3, Math.round(left.bottom * 10) / 10);
  const rightBottom = Math.max(rightTop + 3, Math.round(right.bottom * 10) / 10);
  const c1 = Math.round(width * 0.42);
  const c2 = Math.round(width * 0.58);
  return [
    `M 0 ${leftTop}`,
    `C ${c1} ${leftTop}, ${c2} ${rightTop}, ${width} ${rightTop}`,
    `L ${width} ${rightBottom}`,
    `C ${c2} ${rightBottom}, ${c1} ${leftBottom}, 0 ${leftBottom}`,
    "Z",
  ].join(" ");
}

function mappedScrollTop(source: HTMLElement, target: HTMLElement): number {
  const sourceMax = Math.max(0, source.scrollHeight - source.clientHeight);
  const targetMax = Math.max(0, target.scrollHeight - target.clientHeight);
  if (sourceMax === 0 || targetMax === 0) return 0;
  return (source.scrollTop / sourceMax) * targetMax;
}

function setupSplitDiffInteractions(mv: MergeView, isSyncEnabled: () => boolean): () => void {
  const editorDom = mv.dom.querySelector<HTMLElement>(".cm-mergeViewEditors");
  const editorWraps = editorDom
    ? Array.from(editorDom.children).filter((child): child is HTMLElement =>
        child instanceof HTMLElement && child.classList.contains("cm-mergeViewEditor"),
      )
    : [];
  const leftWrap = editorWraps[0];
  const rightWrap = editorWraps[1];
  if (!editorDom || !leftWrap || !rightWrap) return () => {};

  const connector = document.createElement("div");
  connector.className = "taomni-diff-connector";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("aria-hidden", "true");
  const pathLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
  svg.appendChild(pathLayer);
  connector.appendChild(svg);
  editorDom.insertBefore(connector, rightWrap);

  const aScroll = mv.a.scrollDOM;
  const bScroll = mv.b.scrollDOM;
  let ignoreNextScroll: HTMLElement | null = null;
  let renderFrame = 0;
  let deferredRender = 0;

  const renderConnectors = () => {
    renderFrame = 0;
    if (!connector.isConnected) return;
    const width = connector.clientWidth || CONNECTOR_WIDTH;
    const height = connector.clientHeight;
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));

    const fragment = document.createDocumentFragment();
    for (const chunk of mv.chunks) {
      const left = sideRange(mv.a, chunk, "a");
      const right = sideRange(mv.b, chunk, "b");
      if (Math.max(left.bottom, right.bottom) < -24 || Math.min(left.top, right.top) > height + 24) {
        continue;
      }
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("class", `taomni-diff-connector-path is-${chunkKind(chunk)}`);
      path.setAttribute("d", connectorPath(left, right, width));
      fragment.appendChild(path);
    }
    pathLayer.replaceChildren(fragment);
  };

  const queueRender = () => {
    if (renderFrame === 0) {
      renderFrame = window.requestAnimationFrame(renderConnectors);
    }
  };

  const handleScroll = (source: HTMLElement, target: HTMLElement) => {
    if (ignoreNextScroll === source) {
      ignoreNextScroll = null;
      queueRender();
      return;
    }
    if (isSyncEnabled()) {
      ignoreNextScroll = target;
      target.scrollTop = mappedScrollTop(source, target);
    }
    queueRender();
  };

  const onAScroll = () => handleScroll(aScroll, bScroll);
  const onBScroll = () => handleScroll(bScroll, aScroll);
  aScroll.addEventListener("scroll", onAScroll, { passive: true });
  bScroll.addEventListener("scroll", onBScroll, { passive: true });

  const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(queueRender) : null;
  resizeObserver?.observe(connector);
  resizeObserver?.observe(aScroll);
  resizeObserver?.observe(bScroll);
  window.addEventListener("resize", queueRender);

  queueRender();
  deferredRender = window.setTimeout(queueRender, 80);

  return () => {
    aScroll.removeEventListener("scroll", onAScroll);
    bScroll.removeEventListener("scroll", onBScroll);
    window.removeEventListener("resize", queueRender);
    resizeObserver?.disconnect();
    if (renderFrame !== 0) window.cancelAnimationFrame(renderFrame);
    if (deferredRender !== 0) window.clearTimeout(deferredRender);
    connector.remove();
  };
}

function scrollChunkIntoView(view: EditorView, chunk: Chunk, side: "a" | "b") {
  const docLength = view.state.doc.length;
  const from = side === "a" ? chunk.fromA : chunk.fromB;
  const end = side === "a" ? chunk.endA : chunk.endB;
  const anchor = clampNumber(from, 0, docLength);
  const scrollPos = clampNumber(Math.max(anchor, end - 1), 0, docLength);
  view.dispatch({
    selection: { anchor },
    effects: EditorView.scrollIntoView(scrollPos, { y: "center", x: "nearest" }),
  });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function DiffViewer({ pair, loading, emptyLabel }: DiffViewerProps) {
  const [view, setView] = useState<ViewMode>(() => readPref<ViewMode>(VIEW_KEY, "split"));
  const [whitespace, setWhitespace] = useState<WhitespaceMode>(() => readPref<WhitespaceMode>(WS_KEY, "none"));
  const [syncScrolling, setSyncScrolling] = useState(
    () => readPref<"true" | "false">(SYNC_SCROLL_KEY, "true") !== "false",
  );
  const [highlightWords, setHighlightWords] = useState(true);
  const [diffCount, setDiffCount] = useState(0);
  const [forceRenderLargeDiffKey, setForceRenderLargeDiffKey] = useState("");

  const hostRef = useRef<HTMLDivElement | null>(null);
  const mergeRef = useRef<MergeView | null>(null);
  const unifiedRef = useRef<EditorView | null>(null);
  const scrollCleanupRef = useRef<(() => void) | null>(null);
  const syncScrollingRef = useRef(syncScrolling);
  const activeChunkIndexRef = useRef(-1);
  const pairKey = pair
    ? `${pair.path}\0${pair.oldPath ?? ""}\0${pair.oldSize}\0${pair.newSize}\0${pair.oldText?.length ?? -1}\0${pair.newText?.length ?? -1}`
    : "";
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

  // BUILD_EFFECT
  useEffect(() => {
    let cancelled = false;
    const teardown = () => {
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
    if (!host || !renderable || !pair) {
      return () => {
        cancelled = true;
        teardown();
      };
    }
    host.innerHTML = "";
    const oldText = pair.oldText ?? "";
    const newText = pair.newText ?? "";
    const override = buildDiffOverride(whitespace);
    const diffConfig = override ? { override } : undefined;

    void languageForPath(pair.path)
      .then((language) => {
        if (cancelled || hostRef.current !== host) return;
        if (view === "split") {
          const mv = new MergeView({
            a: { doc: oldText, extensions: baseExtensions(language) },
            b: { doc: newText, extensions: baseExtensions(language) },
            parent: host,
            orientation: "a-b",
            highlightChanges: highlightWords,
            gutter: true,
            diffConfig,
          });
          mergeRef.current = mv;
          scrollCleanupRef.current = setupSplitDiffInteractions(mv, () => syncScrollingRef.current);
          setDiffCount(mv.chunks.length);
        } else {
          const uv = new EditorView({
            doc: newText,
            parent: host,
            extensions: [
              ...baseExtensions(language),
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
          setDiffCount(getChunks(uv.state)?.chunks.length ?? 0);
        }
      })
      .catch(() => {
        /* language load failure: leave host empty */
      });

    return () => {
      cancelled = true;
      teardown();
    };
  }, [pair, renderable, view, whitespace, highlightWords]);

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
      return;
    }

    if (uv) {
      scrollChunkIntoView(uv, chunk, "b");
      uv.focus();
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
        text={`Large text diff skipped (${formatBytes(pair.oldSize)} to ${formatBytes(pair.newSize)}, ${formatLines(complexity.maxLines)}).`}
      >
        <button className="taomni-btn h-7 px-2 mt-3" type="button" onClick={() => setForceRenderLargeDiffKey(pairKey)}>
          Render anyway
        </button>
      </DiffNotice>
    );
  }

  return (
    <div className="h-full min-h-0 flex flex-col bg-[var(--taomni-panel-bg)]">
      <div className="h-10 shrink-0 flex items-center gap-2 px-3 border-b border-[var(--taomni-divider)] text-[12px] bg-[var(--taomni-chrome-bg)]">
        <div className="inline-flex rounded-md p-0.5 bg-[var(--taomni-hover)] border border-[var(--taomni-divider)]">
          <button
            type="button"
            title="Side-by-side (Split)"
            className={`h-6 px-2.5 rounded text-[11px] font-medium inline-flex items-center gap-1.5 transition-all duration-150 ${view === "split" ? "bg-[var(--taomni-card-bg)] text-[var(--taomni-text)] shadow-sm" : "text-[var(--taomni-text-muted)] hover:text-[var(--taomni-text)]"}`}
            onClick={() => setView("split")}
          >
            <Columns2 className="w-3.5 h-3.5" /> Split
          </button>
          <button
            type="button"
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
            title={syncScrolling ? "Synchronize scrolling: on" : "Synchronize scrolling: off"}
            aria-pressed={syncScrolling}
            className={`h-7 w-7 rounded-md inline-flex items-center justify-center border transition-all duration-150 cursor-pointer ${
              syncScrolling
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

        <span className="text-[11px] font-medium text-[var(--taomni-text-muted)] bg-[var(--taomni-hover)] px-2.5 py-0.5 rounded-full border border-[var(--taomni-divider)]">
          {diffCount === 0 ? "No differences" : `${diffCount} difference${diffCount === 1 ? "" : "s"}`}
        </span>

        <div className="flex items-center gap-1">
          <button
            className="h-7 w-7 rounded-md inline-flex items-center justify-center border border-[var(--taomni-divider)] bg-[var(--taomni-card-bg)] text-[var(--taomni-text)] hover:bg-[var(--taomni-hover)] disabled:opacity-40 disabled:hover:bg-[var(--taomni-card-bg)] transition-all duration-150 cursor-pointer"
            type="button"
            title="Previous change"
            disabled={!diffCount}
            onClick={goPrev}
          >
            <ChevronUp className="w-4 h-4" />
          </button>
          <button
            className="h-7 w-7 rounded-md inline-flex items-center justify-center border border-[var(--taomni-divider)] bg-[var(--taomni-card-bg)] text-[var(--taomni-text)] hover:bg-[var(--taomni-hover)] disabled:opacity-40 disabled:hover:bg-[var(--taomni-card-bg)] transition-all duration-150 cursor-pointer"
            type="button"
            title="Next change"
            disabled={!diffCount}
            onClick={goNext}
          >
            <ChevronDown className="w-4 h-4" />
          </button>
        </div>
      </div>
      <div ref={hostRef} data-testid="git-diff-viewer" className="taomni-diff-host flex-1 min-h-0 overflow-hidden" />
    </div>
  );
}

function DiffNotice({ text, children }: { text: string; children?: ReactNode }) {
  return (
    <div className="h-full min-h-24 flex flex-col items-center justify-center px-4 text-center text-[12px] text-[var(--taomni-text-muted)]">
      <div>{text}</div>
      {children}
    </div>
  );
}

function diffComplexity(pair: GitBlobPair): { tooLarge: boolean; maxLines: number } {
  const oldText = pair.oldText ?? "";
  const newText = pair.newText ?? "";
  const maxChars = Math.max(oldText.length, newText.length);
  const maxLines = Math.max(countLines(oldText), countLines(newText));
  return {
    tooLarge: maxChars > MAX_AUTO_RENDER_CHARS || maxLines > MAX_AUTO_RENDER_LINES,
    maxLines,
  };
}

function countLines(text: string): number {
  if (!text) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) lines += 1;
  }
  return lines;
}

function formatLines(n: number): string {
  return `${n.toLocaleString()} line${n === 1 ? "" : "s"}`;
}

function ImageDiff({ pair }: { pair: GitBlobPair }) {
  const oldUrl = imageDataUrl(pair.oldPath ?? pair.path, pair.oldImageB64);
  const newUrl = imageDataUrl(pair.path, pair.newImageB64);
  return (
    <div className="h-full min-h-0 grid grid-cols-2 gap-2 p-3 overflow-auto bg-[var(--taomni-term-bg,#111827)]">
      <ImageSide label={`Before · ${formatBytes(pair.oldSize)}`} url={oldUrl} missing="Not present" />
      <ImageSide label={`After · ${formatBytes(pair.newSize)}`} url={newUrl} missing="Deleted" />
    </div>
  );
}

function ImageSide({ label, url, missing }: { label: string; url: string | null; missing: string }) {
  return (
    <div className="min-w-0 flex flex-col items-center gap-2">
      <div className="text-[11px] text-slate-300">{label}</div>
      {url ? (
        <img src={url} alt={label} className="max-w-full object-contain border border-[var(--taomni-divider)]" />
      ) : (
        <div className="flex-1 flex items-center justify-center text-[12px] text-slate-400">{missing}</div>
      )}
    </div>
  );
}



