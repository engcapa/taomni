import { useEffect, useMemo, useRef, useState } from "react";
import { Check, CheckSquare, Copy, Database, Send, Square } from "lucide-react";
import { ConfirmDialog } from "../sidebar/ConfirmDialog";
import {
  getTerminal,
  listTerminals,
  type TerminalRegistryEntry,
} from "../../lib/terminal/terminalRegistry";
import {
  getQueryTab,
  listQueryTabs,
  type QueryRegistryEntry,
} from "../../lib/queryRegistry";
import { useAppStore } from "../../stores/appStore";
import { useT, type TranslateFn } from "../../lib/i18n";

interface CodeBlockToolbarProps {
  /** Plain-text contents of the code block. */
  code: string;
  /** Optional language hint shown as a tiny label. */
  lang?: string | null;
  /**
   * If the parent thread is bound to a specific terminal (via
   * `linked_session_id`), prefer that terminal — otherwise the toolbar falls
   * back to the currently focused terminal panel.
   */
  preferredTabId?: string | null;
  /** Query tab preferred by the parent thread, when chat is DB-tab bound. */
  preferredQueryTabId?: string | null;
}

/**
 * Toolbar that wraps a fenced code block in an assistant message. Adds:
 *   - "复制" — copies the entire block to the clipboard.
 *   - "选行" — toggles per-line checkboxes so the user can pick a subset.
 *   - "发送到终端" — writes the (possibly-filtered) text into the terminal's
 *     stdin via the `terminalRegistry`. The button is disabled when no
 *     terminal is registered.
 *
 * The component renders the code block itself (in addition to the toolbar)
 * so we can interleave per-line checkboxes with the original syntax.
 */
export function CodeBlockToolbar({
  code,
  lang,
  preferredTabId,
  preferredQueryTabId,
}: CodeBlockToolbarProps) {
  const t = useT();
  const lines = useMemo(() => code.split("\n"), [code]);
  const lineMeta = useMemo(
    () => lines.map((line) => ({
      text: line,
      selectable: isSelectableTerminalLine(line, lang),
    })),
    [lang, lines],
  );
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [copied, setCopied] = useState(false);
  const [sent, setSent] = useState(false);
  const [sentQuery, setSentQuery] = useState(false);
  const [pendingSend, setPendingSend] = useState<PendingTerminalSend | null>(null);
  // Track the focused terminal tab through the appStore so this toolbar
  // re-targets the moment the user switches tabs (the registry itself is
  // a non-reactive global, so we can't subscribe to it directly).
  const activeTabId = useAppStore((s) => s.activeTabId);
  const activeTabType = useAppStore((s) =>
    s.tabs.find((t) => t.id === s.activeTabId)?.type ?? null,
  );
  // Re-render the toolbar periodically so registry mutations (a terminal
  // appearing or disappearing while this message is on screen) flow through
  // even though the registry isn't reactive.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    setPicked((previous) => {
      const next = new Set(
        [...previous].filter((index) => lineMeta[index]?.selectable),
      );
      return next.size === previous.size ? previous : next;
    });
  }, [lineMeta]);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  const toggleLine = (i: number) => {
    if (!lineMeta[i]?.selectable) return;
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  const targetEntry = useMemo<TerminalRegistryEntry | null>(() => {
    void tick; // force re-evaluation when the registry is touched
    if (preferredTabId) {
      const e = getTerminal(preferredTabId);
      if (e) return e;
    }
    if (activeTabType === "terminal" && activeTabId) {
      return getTerminal(activeTabId);
    }
    return null;
  }, [preferredTabId, activeTabId, activeTabType, tick]);

  const queryTargetEntry = useMemo<QueryRegistryEntry | null>(() => {
    void tick; // force re-evaluation when DB tabs register/unregister
    if (preferredQueryTabId) {
      const e = getQueryTab(preferredQueryTabId);
      if (e) return e;
    }
    if (activeTabType === "database" && activeTabId) {
      const e = getQueryTab(activeTabId);
      if (e) return e;
    }
    const all = listQueryTabs();
    return all.length === 1 ? all[0] : null;
  }, [preferredQueryTabId, activeTabId, activeTabType, tick]);

  const buildPayload = (): string => {
    if (!selecting) return code;
    return lines
      .filter((_, i) => picked.has(i) && lineMeta[i]?.selectable)
      .join("\n");
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(buildPayload());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch (e) {
      console.warn("copy code block failed:", e);
    }
  };

  const commitTerminalSend = (entry: TerminalRegistryEntry, payload: PreparedTerminalInput) => {
    entry.writeInput(payload.text);
    setSent(true);
    window.setTimeout(() => setSent(false), 1200);
  };

  const handleSendToTerminal = (entry: TerminalRegistryEntry | null = targetEntry) => {
    if (!entry) return;
    const payload = prepareTerminalInput(buildPayload());
    if (!payload) return;
    if (payload.isMultiline) {
      setPendingSend({ entry, payload });
      return;
    }
    commitTerminalSend(entry, payload);
  };

  const handleSendToQuery = (entry: QueryRegistryEntry | null = queryTargetEntry) => {
    if (!entry) return;
    const payload = prepareQueryInput(buildPayload());
    if (!payload) return;
    entry.insertQuery(payload);
    setSentQuery(true);
    window.setTimeout(() => setSentQuery(false), 1200);
  };

  const selectableCount = lineMeta.filter((line) => line.selectable).length;
  const selectedSelectableCount = lineMeta.reduce(
    (count, line, index) => count + (line.selectable && picked.has(index) ? 1 : 0),
    0,
  );
  const allSelected = selecting && selectableCount > 0 && selectedSelectableCount === selectableCount;

  return (
    <div className="rounded border border-[var(--taomni-divider)] my-2 overflow-hidden">
      <div className="flex items-center gap-1 px-2 py-1 bg-[var(--taomni-divider)]/40 text-[10px] text-[var(--taomni-text-muted)]">
        <span className="font-mono uppercase tracking-wide">{lang || t("chat.codeLangFallback")}</span>
        <span className="flex-1" />
        <button
          type="button"
          className={`taomni-btn h-5 px-1.5 inline-flex items-center gap-1 ${selecting ? "bg-[var(--taomni-selected)]" : ""}`}
          onClick={() => {
            setSelecting((v) => !v);
            setPicked(new Set());
          }}
          title={t("chat.codeSelectLinesTitle")}
        >
          {allSelected ? <CheckSquare className="w-2.5 h-2.5" /> : <Square className="w-2.5 h-2.5" />}
          <span>{t("chat.codeSelectLines")}</span>
        </button>
        <button
          type="button"
          className="taomni-btn h-5 px-1.5 inline-flex items-center gap-1"
          onClick={handleCopy}
          title={t("chat.codeCopyTitle")}
        >
          {copied ? <Check className="w-2.5 h-2.5 text-green-400" /> : <Copy className="w-2.5 h-2.5" />}
          <span>{t("chat.codeCopy")}</span>
        </button>
        <SendToTerminalButton
          targetEntry={targetEntry}
          disabled={selecting && selectedSelectableCount === 0}
          sent={sent}
          onSend={handleSendToTerminal}
          t={t}
        />
        <SendToQueryButton
          targetEntry={queryTargetEntry}
          disabled={selecting && selectedSelectableCount === 0}
          sent={sentQuery}
          onSend={handleSendToQuery}
          t={t}
        />
      </div>
      <pre className="m-0 p-2 text-[11px] leading-snug overflow-x-auto bg-[var(--taomni-bg)]">
        <code>
          {selecting
            ? lineMeta.map((line, i) => {
              const content = (
                <span className="font-mono whitespace-pre-wrap break-all">{line.text || " "}</span>
              );
              if (!line.selectable) {
                return (
                  <div
                    key={i}
                    className="flex items-start gap-2 px-1 -mx-1 rounded text-[var(--taomni-text-muted)]"
                  >
                    <span className="mt-0.5 w-[13px] shrink-0" aria-hidden="true" />
                    {content}
                  </div>
                );
              }
              return (
                <label
                  key={i}
                  className="flex items-start gap-2 cursor-pointer hover:bg-[var(--taomni-selected)]/40 px-1 -mx-1 rounded"
                >
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={picked.has(i)}
                    onChange={() => toggleLine(i)}
                  />
                  {content}
                </label>
              );
            })
            : code}
        </code>
      </pre>
      {pendingSend && (
        <ConfirmDialog
          title={t("chat.confirmMultiTitle")}
          message={t("chat.confirmMultiBody", { target: pendingSend.entry.title, count: pendingSend.payload.lineCount })}
          confirmLabel={t("chat.confirmSend")}
          cancelLabel={t("chat.confirmCancel")}
          onCancel={() => setPendingSend(null)}
          onConfirm={() => {
            commitTerminalSend(pendingSend.entry, pendingSend.payload);
            setPendingSend(null);
          }}
        />
      )}
    </div>
  );
}

interface PendingTerminalSend {
  entry: TerminalRegistryEntry;
  payload: PreparedTerminalInput;
}

export interface PreparedTerminalInput {
  text: string;
  isMultiline: boolean;
  lineCount: number;
}

const HASH_COMMENT_LANGS = new Set([
  "",
  "bash",
  "sh",
  "shell",
  "zsh",
  "fish",
  "powershell",
  "ps1",
  "python",
  "py",
  "ruby",
  "rb",
  "perl",
  "yaml",
  "yml",
  "toml",
  "dockerfile",
  "makefile",
  "conf",
  "ini",
  "env",
]);

const SLASH_COMMENT_LANGS = new Set([
  "",
  "js",
  "javascript",
  "ts",
  "typescript",
  "java",
  "c",
  "cpp",
  "c++",
  "cs",
  "csharp",
  "go",
  "rust",
  "rs",
  "swift",
  "kotlin",
  "kt",
  "php",
  "scala",
  "css",
  "scss",
  "less",
]);

const SQL_COMMENT_LANGS = new Set(["sql", "mysql", "postgres", "postgresql", "sqlite", "lua", "haskell", "hs"]);
const HTML_COMMENT_LANGS = new Set(["", "html", "xml", "md", "markdown"]);
const BATCH_COMMENT_LANGS = new Set(["bat", "batch", "cmd"]);

function normalizeLang(lang?: string | null): string {
  return (lang ?? "").trim().toLowerCase();
}

export function isCommentLikeLine(line: string, lang?: string | null): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;

  const normalizedLang = normalizeLang(lang);
  if (HASH_COMMENT_LANGS.has(normalizedLang) && trimmed.startsWith("#")) return true;
  if (
    SLASH_COMMENT_LANGS.has(normalizedLang) &&
    (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.startsWith("*/"))
  ) {
    return true;
  }
  if (SQL_COMMENT_LANGS.has(normalizedLang) && trimmed.startsWith("--")) return true;
  if (
    HTML_COMMENT_LANGS.has(normalizedLang) &&
    (trimmed.startsWith("<!--") || trimmed.startsWith("-->"))
  ) {
    return true;
  }
  if (
    BATCH_COMMENT_LANGS.has(normalizedLang) &&
    (trimmed.startsWith("::") || /^rem(?:\s|$)/i.test(trimmed))
  ) {
    return true;
  }
  return false;
}

export function isSelectableTerminalLine(line: string, lang?: string | null): boolean {
  return line.trim().length > 0 && !isCommentLikeLine(line, lang);
}

export function prepareTerminalInput(payload: string): PreparedTerminalInput | null {
  const normalized = payload
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n+$/g, "");
  if (!normalized) return null;
  const lines = normalized.split("\n");
  return {
    text: lines.join("\r"),
    isMultiline: lines.length > 1,
    lineCount: lines.length,
  };
}

export function prepareQueryInput(payload: string): string | null {
  const normalized = payload
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n+$/g, "");
  return normalized.trim() ? normalized : null;
}

interface SendToTerminalButtonProps {
  targetEntry: TerminalRegistryEntry | null;
  disabled: boolean;
  sent: boolean;
  onSend: (entry: TerminalRegistryEntry | null) => void;
  t: TranslateFn;
}

/**
 * The "send to terminal" control. Shows a single button when there's exactly
 * one terminal target (or the thread already has a preferred one), and a
 * dropdown picker when the user has multiple terminals open and the snippet
 * has no preferred target.
 */
function SendToTerminalButton({ targetEntry, disabled, sent, onSend, t }: SendToTerminalButtonProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const allTerminals = listTerminals();
  const hasOptions = allTerminals.length > 1;
  const baseDisabled = !targetEntry || disabled;

  if (!hasOptions) {
    return (
      <button
        type="button"
        className="taomni-btn h-5 px-1.5 inline-flex items-center gap-1 disabled:opacity-50 bg-[var(--taomni-accent)]/15 text-[var(--taomni-accent)] border border-[var(--taomni-accent)]/30 hover:bg-[var(--taomni-accent)]/25"
        onClick={() => onSend(targetEntry)}
        disabled={baseDisabled}
        title={
          targetEntry
            ? t("chat.codeSendTargetTitle", { target: targetEntry.title })
            : t("chat.codeSendNoTarget")
        }
      >
        {sent ? <Check className="w-2.5 h-2.5 text-green-400" /> : <Send className="w-2.5 h-2.5" />}
        <span>{t("chat.codeSendToTerminal")}</span>
      </button>
    );
  }

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        className="taomni-btn h-5 px-1.5 inline-flex items-center gap-1 disabled:opacity-50 bg-[var(--taomni-accent)]/15 text-[var(--taomni-accent)] border border-[var(--taomni-accent)]/30 hover:bg-[var(--taomni-accent)]/25"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled || allTerminals.length === 0}
        title={t("chat.codeSendPickTitle")}
      >
        {sent ? <Check className="w-2.5 h-2.5 text-green-400" /> : <Send className="w-2.5 h-2.5" />}
        <span>{t("chat.codeSendToTerminalDropdown")}</span>
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-1 z-30 min-w-[160px] rounded border border-[var(--taomni-divider)] shadow-lg"
          style={{ background: "var(--taomni-panel-bg)" }}
        >
          {allTerminals.map((t) => (
            <button
              key={t.tabId}
              type="button"
              className="block w-full text-left px-2 py-1 text-[11px] hover:bg-[var(--taomni-selected)]"
              onClick={() => {
                onSend(t);
                setOpen(false);
              }}
            >
              <span className="truncate">{t.title}</span>
              {targetEntry?.tabId === t.tabId && (
                <span className="ml-1 text-[var(--taomni-accent)]">★</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface SendToQueryButtonProps {
  targetEntry: QueryRegistryEntry | null;
  disabled: boolean;
  sent: boolean;
  onSend: (entry: QueryRegistryEntry | null) => void;
  t: TranslateFn;
}

function SendToQueryButton({ targetEntry, disabled, sent, onSend, t }: SendToQueryButtonProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const allQueries = listQueryTabs();
  if (allQueries.length === 0) return null;
  const effectiveTarget = targetEntry ?? (allQueries.length === 1 ? allQueries[0] : null);
  const hasOptions = allQueries.length > 1;
  const baseDisabled = !effectiveTarget || disabled;

  if (!hasOptions) {
    return (
      <button
        type="button"
        className="taomni-btn h-5 px-1.5 inline-flex items-center gap-1 disabled:opacity-50 bg-[var(--taomni-selected)] text-[var(--taomni-text)] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)]"
        onClick={() => onSend(effectiveTarget)}
        disabled={baseDisabled}
        title={
          effectiveTarget
            ? t("chat.codeSendQueryTargetTitle", { target: effectiveTarget.title })
            : t("chat.codeSendQueryNoTarget")
        }
      >
        {sent ? <Check className="w-2.5 h-2.5 text-green-400" /> : <Database className="w-2.5 h-2.5" />}
        <span>{t("chat.codeSendToQuery")}</span>
      </button>
    );
  }

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        className="taomni-btn h-5 px-1.5 inline-flex items-center gap-1 disabled:opacity-50 bg-[var(--taomni-selected)] text-[var(--taomni-text)] border border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)]"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        title={t("chat.codeSendQueryPickTitle")}
      >
        {sent ? <Check className="w-2.5 h-2.5 text-green-400" /> : <Database className="w-2.5 h-2.5" />}
        <span>{t("chat.codeSendToQueryDropdown")}</span>
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-1 z-30 min-w-[180px] rounded border border-[var(--taomni-divider)] shadow-lg"
          style={{ background: "var(--taomni-panel-bg)" }}
        >
          {allQueries.map((query) => (
            <button
              key={query.tabId}
              type="button"
              className="block w-full text-left px-2 py-1 text-[11px] hover:bg-[var(--taomni-selected)]"
              onClick={() => {
                onSend(query);
                setOpen(false);
              }}
            >
              <span className="truncate">{query.title}</span>
              {effectiveTarget?.tabId === query.tabId && (
                <span className="ml-1 text-[var(--taomni-accent)]">★</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Extract fenced code blocks (``` ... ```) from a Markdown source so we can
 * render each one with a `CodeBlockToolbar`. Returns an alternating array of
 * `{ kind: "text" | "code", value, lang? }` segments suitable for sequential
 * rendering. Single backtick `inline` code is left untouched.
 */
export interface MarkdownSegment {
  kind: "text" | "code";
  value: string;
  lang?: string | null;
}

const FENCE_RE = /^```([^\n]*)\n([\s\S]*?)\n```/m;

export function splitFencedBlocks(source: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  let remaining = source;
  // Greedy line-anchored regex; safer than the global flag which loses
  // context when we slice. We re-run after each match.
  while (remaining.length > 0) {
    const m = remaining.match(FENCE_RE);
    if (!m || m.index === undefined) {
      segments.push({ kind: "text", value: remaining });
      break;
    }
    if (m.index > 0) {
      segments.push({ kind: "text", value: remaining.slice(0, m.index) });
    }
    segments.push({
      kind: "code",
      lang: (m[1] || "").trim() || null,
      value: m[2],
    });
    remaining = remaining.slice(m.index + m[0].length);
  }
  return segments;
}
