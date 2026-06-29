import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import {
  MergeView,
  unifiedMergeView,
  getChunks,
  goToNextChunk,
  goToPreviousChunk,
} from "@codemirror/merge";
import { ChevronDown, ChevronUp, Columns2, Loader2, Rows2 } from "lucide-react";
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
    fontSize: "13px",
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
    EditorView.lineWrapping,
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
.taomni-diff-host .cm-mergeView, .taomni-diff-host .cm-mergeViewEditors { height: 100%; }
.taomni-diff-host .cm-editor { height: 100%; }
.taomni-diff-host .cm-mergeView .cm-scroller { overflow: auto; }

/* Custom JetBrains-like fonts and editor defaults */
.taomni-diff-host .cm-editor,
.taomni-diff-host .cm-mergeView,
.taomni-diff-host .cm-deletedChunk {
  font-family: "JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace !important;
  font-size: 13px !important;
  line-height: 1.6 !important;
}

/* Light Theme Variables */
.taomni-diff-host {
  --intellij-diff-added-bg: rgba(46, 160, 67, 0.08);
  --intellij-diff-added-word: rgba(46, 160, 67, 0.2);
  --intellij-diff-deleted-bg: rgba(240, 82, 82, 0.06);
  --intellij-diff-deleted-word: rgba(240, 82, 82, 0.18);
  --intellij-diff-modified-bg: rgba(30, 144, 255, 0.07);
  --intellij-diff-modified-word: rgba(30, 144, 255, 0.18);
  --intellij-diff-spacer-bg: #f8fafc;
  --intellij-diff-gutter-color: #94a3b8;
  --intellij-diff-revert-hover: #e2e8f0;
  --intellij-diff-revert-color: #2563eb;
  --intellij-diff-divider: #e2e8f0;
}

/* Dark Theme Variables */
html[data-app-theme="dark"] .taomni-diff-host {
  --intellij-diff-added-bg: rgba(46, 160, 67, 0.15);
  --intellij-diff-added-word: rgba(46, 160, 67, 0.35);
  --intellij-diff-deleted-bg: rgba(240, 82, 82, 0.12);
  --intellij-diff-deleted-word: rgba(240, 82, 82, 0.3);
  --intellij-diff-modified-bg: rgba(59, 130, 246, 0.15);
  --intellij-diff-modified-word: rgba(59, 130, 246, 0.35);
  --intellij-diff-spacer-bg: #0f172a;
  --intellij-diff-gutter-color: #475569;
  --intellij-diff-revert-hover: #1e293b;
  --intellij-diff-revert-color: #60a5fa;
  --intellij-diff-divider: #1e293b;
}

/* Editor backgrounds and overall layout */
.taomni-diff-host .cm-editor {
  background-color: var(--taomni-input-bg, transparent) !important;
  color: var(--taomni-text) !important;
}

/* Gutters */
.taomni-diff-host .cm-gutters {
  background-color: var(--taomni-input-bg, transparent) !important;
  color: var(--intellij-diff-gutter-color) !important;
  border-right: 1px solid var(--intellij-diff-divider) !important;
}

/* Changed lines and word highlights in split view */
.taomni-diff-host .cm-merge-a .cm-changedLine {
  background-color: var(--intellij-diff-deleted-bg) !important;
}
.taomni-diff-host .cm-merge-a .cm-changedText {
  background-color: var(--intellij-diff-deleted-word) !important;
  background-image: none !important; /* Remove CodeMirror default underline */
  border-radius: 2px;
}

.taomni-diff-host .cm-merge-b .cm-changedLine {
  background-color: var(--intellij-diff-added-bg) !important;
}
.taomni-diff-host .cm-merge-b .cm-changedText {
  background-color: var(--intellij-diff-added-word) !important;
  background-image: none !important; /* Remove CodeMirror default underline */
  border-radius: 2px;
}

/* Changed lines and word highlights in unified view */
.taomni-diff-host .cm-deletedChunk {
  background-color: var(--intellij-diff-deleted-bg) !important;
  border-left: 3px solid #ef4444 !important;
  padding-left: 8px !important;
}
.taomni-diff-host .cm-deletedLine {
  background-color: transparent !important;
}
.taomni-diff-host .cm-deletedChunk .cm-deletedText {
  background-color: var(--intellij-diff-deleted-word) !important;
  background-image: none !important;
  border-radius: 2px;
}
.taomni-diff-host .cm-inlineChangedLine {
  background-color: var(--intellij-diff-modified-bg) !important;
}

/* Line number gutters of changed lines match the line background */
.taomni-diff-host .cm-merge-a .cm-changedLineGutter {
  background-color: var(--intellij-diff-deleted-bg) !important;
  color: var(--taomni-text) !important;
}
.taomni-diff-host .cm-merge-b .cm-changedLineGutter {
  background-color: var(--intellij-diff-added-bg) !important;
  color: var(--taomni-text) !important;
}
.taomni-diff-host .cm-deletedLineGutter {
  background-color: var(--intellij-diff-deleted-bg) !important;
  color: var(--taomni-text) !important;
}
.taomni-diff-host .cm-inlineChangedLineGutter {
  background-color: var(--intellij-diff-modified-bg) !important;
  color: var(--taomni-text) !important;
}

/* Spacers (empty line fillers) */
.taomni-diff-host .cm-mergeSpacer {
  background-color: var(--intellij-diff-spacer-bg) !important;
  background-image: none !important; /* Remove default hatch pattern */
}

/* Revert column / middle gutter - Make it seamless and transparent like IntelliJ */
.taomni-diff-host .cm-merge-revert {
  background-color: transparent !important;
  border: none !important;
  width: 20px !important;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.taomni-diff-host .cm-merge-revert button {
  color: var(--intellij-diff-revert-color) !important;
  font-weight: bold !important;
  font-size: 14px !important;
  line-height: 1 !important;
  height: 18px !important;
  width: 18px !important;
  border-radius: 4px !important;
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  transition: var(--taomni-transition) !important;
  opacity: 0; /* Hidden by default, show on hover like IntelliJ */
  background-color: transparent !important;
}

/* Show the revert button when hovering over the revert column or the button itself */
.taomni-diff-host .cm-merge-revert:hover button,
.taomni-diff-host .cm-merge-revert button:hover {
  opacity: 1;
}

.taomni-diff-host .cm-merge-revert button:hover {
  background-color: var(--intellij-diff-revert-hover) !important;
}

/* Collapsed lines widget */
.taomni-diff-host .cm-collapsedLines {
  font-size: 11px !important;
  font-family: var(--taomni-ui-font-family) !important;
  border: 1px solid var(--intellij-diff-divider) !important;
  border-radius: 4px !important;
  margin: 4px 8px !important;
  text-align: center !important;
  padding: 4px !important;
  transition: var(--taomni-transition) !important;
}

.taomni-diff-host .cm-collapsedLines:hover {
  background-color: var(--taomni-hover) !important;
  border-color: var(--taomni-accent) !important;
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function DiffViewer({ pair, loading, emptyLabel }: DiffViewerProps) {
  const [view, setView] = useState<ViewMode>(() => readPref<ViewMode>(VIEW_KEY, "split"));
  const [whitespace, setWhitespace] = useState<WhitespaceMode>(() => readPref<WhitespaceMode>(WS_KEY, "none"));
  const [highlightWords, setHighlightWords] = useState(true);
  const [diffCount, setDiffCount] = useState(0);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const mergeRef = useRef<MergeView | null>(null);
  const unifiedRef = useRef<EditorView | null>(null);
  const navRef = useRef<EditorView | null>(null);

  const renderable = useMemo(
    () =>
      !!pair &&
      !pair.binary &&
      !pair.image &&
      !pair.oversize &&
      (pair.oldText != null || pair.newText != null),
    [pair],
  );

  useEffect(() => writePref(VIEW_KEY, view), [view]);
  useEffect(() => writePref(WS_KEY, whitespace), [whitespace]);

  // BUILD_EFFECT
  useEffect(() => {
    let cancelled = false;
    const teardown = () => {
      mergeRef.current?.destroy();
      mergeRef.current = null;
      unifiedRef.current?.destroy();
      unifiedRef.current = null;
      navRef.current = null;
    };
    teardown();
    setDiffCount(0);
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
            collapseUnchanged: { margin: 6, minSize: 8 },
            diffConfig,
          });
          mergeRef.current = mv;
          navRef.current = mv.b;
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
                collapseUnchanged: { margin: 6, minSize: 8 },
                diffConfig,
              }),
            ],
          });
          unifiedRef.current = uv;
          navRef.current = uv;
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

  const goNext = useCallback(() => {
    const v = navRef.current;
    if (v) {
      goToNextChunk(v);
      v.focus();
    }
  }, []);
  const goPrev = useCallback(() => {
    const v = navRef.current;
    if (v) {
      goToPreviousChunk(v);
      v.focus();
    }
  }, []);

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
  if (pair.image) {
    return <ImageDiff pair={pair} />;
  }
  if (pair.oversize) {
    return (
      <DiffNotice
        text={`File too large to display a diff (${formatBytes(pair.oldSize)} → ${formatBytes(pair.newSize)}).`}
      />
    );
  }
  if (pair.binary) {
    return (
      <DiffNotice
        text={`Binary file — no text diff available (${formatBytes(pair.oldSize)} → ${formatBytes(pair.newSize)}).`}
      />
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
      <div ref={hostRef} className="taomni-diff-host flex-1 min-h-0 overflow-hidden" />
    </div>
  );
}

function DiffNotice({ text }: { text: string }) {
  return (
    <div className="h-full min-h-24 flex items-center justify-center px-4 text-center text-[12px] text-[var(--taomni-text-muted)]">
      {text}
    </div>
  );
}

function ImageDiff({ pair }: { pair: GitBlobPair }) {
  const oldUrl = imageDataUrl(pair.oldPath ?? pair.path, pair.oldImageB64);
  const newUrl = imageDataUrl(pair.path, pair.newImageB64);
  return (
    <div className="h-full min-h-0 grid grid-cols-2 gap-2 p-3 overflow-auto bg-[var(--taomni-terminal-bg,#111827)]">
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



