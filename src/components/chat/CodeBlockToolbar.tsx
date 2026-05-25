import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, Send, Check, Square, CheckSquare } from "lucide-react";
import {
  getTerminal,
  listTerminals,
  type TerminalRegistryEntry,
} from "../../lib/terminal/terminalRegistry";
import { useAppStore } from "../../stores/appStore";

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
export function CodeBlockToolbar({ code, lang, preferredTabId }: CodeBlockToolbarProps) {
  const lines = useMemo(() => code.split("\n"), [code]);
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [copied, setCopied] = useState(false);
  const [sent, setSent] = useState(false);
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
    if (!selecting) return;
    setPicked(new Set(lines.map((_, i) => i)));
  }, [selecting, lines]);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  const toggleLine = (i: number) => {
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

  const buildPayload = (): string => {
    if (!selecting || picked.size === lines.length) return code;
    return lines.filter((_, i) => picked.has(i)).join("\n");
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

  const handleSendToTerminal = (entry: TerminalRegistryEntry | null = targetEntry) => {
    if (!entry) return;
    const payload = buildPayload();
    if (!payload) return;
    // Trim a trailing newline so we don't auto-execute multi-line snippets;
    // the user presses Enter in the terminal to confirm. Single-line snippets
    // get a trailing CR added so they read naturally as "type-and-run".
    const isMultiline = payload.includes("\n");
    const text = isMultiline
      ? payload.replace(/\r?\n/g, "\r")
      : payload + "\r";
    entry.writeInput(text);
    setSent(true);
    window.setTimeout(() => setSent(false), 1200);
  };

  const allSelected = selecting && picked.size === lines.length;

  return (
    <div className="rounded border border-[var(--moba-divider)] my-2 overflow-hidden">
      <div className="flex items-center gap-1 px-2 py-1 bg-[var(--moba-divider)]/40 text-[10px] text-[var(--moba-text-muted)]">
        <span className="font-mono uppercase tracking-wide">{lang || "code"}</span>
        <span className="flex-1" />
        <button
          type="button"
          className={`moba-btn h-5 px-1.5 inline-flex items-center gap-1 ${selecting ? "bg-[var(--moba-selected)]" : ""}`}
          onClick={() => {
            setSelecting((v) => !v);
            setPicked(new Set());
          }}
          title="选择部分行后再发送"
        >
          {allSelected ? <CheckSquare className="w-2.5 h-2.5" /> : <Square className="w-2.5 h-2.5" />}
          <span>选行</span>
        </button>
        <button
          type="button"
          className="moba-btn h-5 px-1.5 inline-flex items-center gap-1"
          onClick={handleCopy}
          title="复制到剪贴板"
        >
          {copied ? <Check className="w-2.5 h-2.5 text-green-400" /> : <Copy className="w-2.5 h-2.5" />}
          <span>复制</span>
        </button>
        <SendToTerminalButton
          targetEntry={targetEntry}
          disabled={selecting && picked.size === 0}
          sent={sent}
          onSend={handleSendToTerminal}
        />
      </div>
      <pre className="m-0 p-2 text-[11px] leading-snug overflow-x-auto bg-[var(--moba-bg)]">
        <code>
          {selecting
            ? lines.map((line, i) => (
              <label
                key={i}
                className="flex items-start gap-2 cursor-pointer hover:bg-[var(--moba-selected)]/40 px-1 -mx-1 rounded"
              >
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={picked.has(i)}
                  onChange={() => toggleLine(i)}
                />
                <span className="font-mono whitespace-pre-wrap break-all">{line || " "}</span>
              </label>
            ))
            : code}
        </code>
      </pre>
    </div>
  );
}

interface SendToTerminalButtonProps {
  targetEntry: TerminalRegistryEntry | null;
  disabled: boolean;
  sent: boolean;
  onSend: (entry: TerminalRegistryEntry | null) => void;
}

/**
 * The "send to terminal" control. Shows a single button when there's exactly
 * one terminal target (or the thread already has a preferred one), and a
 * dropdown picker when the user has multiple terminals open and the snippet
 * has no preferred target.
 */
function SendToTerminalButton({ targetEntry, disabled, sent, onSend }: SendToTerminalButtonProps) {
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
        className="moba-btn h-5 px-1.5 inline-flex items-center gap-1 disabled:opacity-50 bg-[var(--moba-accent)]/15 text-[var(--moba-accent)] border border-[var(--moba-accent)]/30 hover:bg-[var(--moba-accent)]/25"
        onClick={() => onSend(targetEntry)}
        disabled={baseDisabled}
        title={
          targetEntry
            ? `发送到终端：${targetEntry.title}`
            : "无可用终端"
        }
      >
        {sent ? <Check className="w-2.5 h-2.5 text-green-400" /> : <Send className="w-2.5 h-2.5" />}
        <span>发送到终端</span>
      </button>
    );
  }

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        className="moba-btn h-5 px-1.5 inline-flex items-center gap-1 disabled:opacity-50 bg-[var(--moba-accent)]/15 text-[var(--moba-accent)] border border-[var(--moba-accent)]/30 hover:bg-[var(--moba-accent)]/25"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled || allTerminals.length === 0}
        title="发送到指定终端"
      >
        {sent ? <Check className="w-2.5 h-2.5 text-green-400" /> : <Send className="w-2.5 h-2.5" />}
        <span>发送到终端 ▾</span>
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-1 z-30 min-w-[160px] rounded border border-[var(--moba-divider)] shadow-lg"
          style={{ background: "var(--moba-panel-bg)" }}
        >
          {allTerminals.map((t) => (
            <button
              key={t.tabId}
              type="button"
              className="block w-full text-left px-2 py-1 text-[11px] hover:bg-[var(--moba-selected)]"
              onClick={() => {
                onSend(t);
                setOpen(false);
              }}
            >
              <span className="truncate">{t.title}</span>
              {targetEntry?.tabId === t.tabId && (
                <span className="ml-1 text-[var(--moba-accent)]">★</span>
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
