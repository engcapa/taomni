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
    fontFamily: "var(--taomni-mono-font, ui-monospace, SFMono-Regular, Menlo, monospace)",
    fontSize: "12px",
    lineHeight: "1.5",
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
    <div className="h-full min-h-0 flex flex-col">
      <div className="h-9 shrink-0 flex items-center gap-1 px-2 border-b border-[var(--taomni-divider)] text-[12px]">
        <div className="inline-flex rounded overflow-hidden border border-[var(--taomni-divider)]">
          <button
            type="button"
            title="Side-by-side"
            className={`h-6 px-2 inline-flex items-center gap-1 ${view === "split" ? "bg-[var(--taomni-accent)] text-white" : "hover:bg-[var(--taomni-hover)]"}`}
            onClick={() => setView("split")}
          >
            <Columns2 className="w-3.5 h-3.5" /> Split
          </button>
          <button
            type="button"
            title="Unified"
            className={`h-6 px-2 inline-flex items-center gap-1 ${view === "unified" ? "bg-[var(--taomni-accent)] text-white" : "hover:bg-[var(--taomni-hover)]"}`}
            onClick={() => setView("unified")}
          >
            <Rows2 className="w-3.5 h-3.5" /> Unified
          </button>
        </div>
        <select
          className="taomni-input h-6 ml-1"
          value={whitespace}
          title="Whitespace"
          onChange={(e) => setWhitespace(e.target.value as WhitespaceMode)}
        >
          <option value="none">Do not ignore</option>
          <option value="trailing">Ignore trailing</option>
          <option value="all">Ignore whitespace</option>
        </select>
        <label className="inline-flex items-center gap-1 ml-1 select-none" title="Highlight changed words">
          <input type="checkbox" checked={highlightWords} onChange={(e) => setHighlightWords(e.target.checked)} />
          Words
        </label>
        <div className="flex-1" />
        <span className="text-[var(--taomni-text-muted)] mr-1">
          {diffCount === 0 ? "No differences" : `${diffCount} difference${diffCount === 1 ? "" : "s"}`}
        </span>
        <button className="taomni-btn h-6 px-1" type="button" title="Previous change" disabled={!diffCount} onClick={goPrev}>
          <ChevronUp className="w-3.5 h-3.5" />
        </button>
        <button className="taomni-btn h-6 px-1" type="button" title="Next change" disabled={!diffCount} onClick={goNext}>
          <ChevronDown className="w-3.5 h-3.5" />
        </button>
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



