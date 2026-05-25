import type { ChatMessage } from "../../stores/chatStore";
import { Check, Copy, Send, ShieldAlert } from "lucide-react";
import { ActionCard, type ActionCardDecision } from "../agent/ActionCard";
import { ConfirmDialog } from "../sidebar/ConfirmDialog";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { renderFormatted, type ChatOutputFormat } from "../../lib/chat/renderFormatted";
import {
  CodeBlockToolbar,
  prepareTerminalInput,
  splitFencedBlocks,
  type PreparedTerminalInput,
} from "./CodeBlockToolbar";
import { useAppStore } from "../../stores/appStore";
import {
  getTerminal,
  type TerminalRegistryEntry,
} from "../../lib/terminal/terminalRegistry";

interface MessageBubbleProps {
  message: ChatMessage;
  /** Resolved output format for this thread; defaults to "md" when omitted. */
  format?: ChatOutputFormat;
  /**
   * The terminal-tab the parent thread is bound to. Code-block toolbars on
   * this message default their "send to terminal" action to it. Null for
   * global threads — the toolbars fall back to the active terminal.
   */
  preferredTerminalTabId?: string | null;
}

interface InlineToolCall {
  tool: string;
  args: Record<string, unknown>;
  preview?: string;
  description?: string;
  requiresConfirmation: boolean;
}

/**
 * Extract tool-call markers from an assistant message.
 *
 * The convention is:
 *   ...assistant text...
 *   [TOOL_CALL]{"tool":"run_in_terminal","args":{...},"preview":"...","description":"..."}
 *   ...more assistant text...
 *
 * This is a pragmatic transitional shape — the streaming protocol does not
 * yet have a first-class tool_call event, but agent-orchestrated flows can
 * embed the JSON marker so the UI renders an ActionCard inline. Once
 * `chat_stream` learns a `tool_call` event kind, we'll consume it directly
 * and drop this regex.
 */
const TOOL_MARKER_RE = /\[TOOL_CALL\](\{[\s\S]+?\})/g;

function parseInlineToolCalls(text: string): { stripped: string; toolCalls: InlineToolCall[] } {
  const toolCalls: InlineToolCall[] = [];
  const stripped = text.replace(TOOL_MARKER_RE, (_match, jsonStr) => {
    try {
      const obj = JSON.parse(jsonStr);
      if (typeof obj.tool === "string") {
        toolCalls.push({
          tool: obj.tool,
          args: obj.args ?? {},
          preview: typeof obj.preview === "string" ? obj.preview : undefined,
          description: typeof obj.description === "string" ? obj.description : undefined,
          requiresConfirmation: obj.requires_confirmation !== false,
        });
      }
    } catch {
      // Malformed marker — leave the literal text in.
    }
    return "";
  }).trim();
  return { stripped, toolCalls };
}

export function MessageBubble({ message, format = "md", preferredTerminalTabId }: MessageBubbleProps) {
  const isUser = message.role === "user";
  const [executed, setExecuted] = useState<Record<number, "approved" | "denied">>({});
  const [copied, setCopied] = useState(false);
  const [sentAll, setSentAll] = useState(false);
  const [pendingSendAll, setPendingSendAll] = useState<PendingMessageTerminalSend | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Subscribe to the active tab so the inline-code send affordance below
  // re-evaluates its target whenever the user switches tabs.
  const activeTabId = useAppStore((s) => s.activeTabId);
  const activeTabType = useAppStore((s) =>
    s.tabs.find((t) => t.id === s.activeTabId)?.type ?? null,
  );
  const targetEntry = useMemo<TerminalRegistryEntry | null>(() => {
    if (preferredTerminalTabId) {
      const e = getTerminal(preferredTerminalTabId);
      if (e) return e;
    }
    if (activeTabType === "terminal" && activeTabId) {
      return getTerminal(activeTabId);
    }
    return null;
  }, [preferredTerminalTabId, activeTabId, activeTabType]);

  const { stripped, toolCalls } = isUser
    ? { stripped: message.content, toolCalls: [] as InlineToolCall[] }
    : parseInlineToolCalls(message.content);

  // For assistant + Markdown, split fenced code blocks out of the rendered
  // path so each block gets a CodeBlockToolbar (copy / select-lines / send
  // to terminal). Non-code prose still goes through marked + DOMPurify.
  const segments = useMemo(() => {
    if (isUser || format !== "md") return null;
    return splitFencedBlocks(stripped);
  }, [isUser, format, stripped]);

  // Single rendered block (used for "html" mode and as a fallback when
  // there are no fenced code blocks in Markdown mode).
  const renderedHtml = useMemo(() => {
    if (isUser || format === "plain") return null;
    try {
      return renderFormatted(stripped, format);
    } catch (e) {
      console.warn("renderFormatted failed:", e);
      return null;
    }
  }, [isUser, stripped, format]);

  const handleDecide = async (idx: number, call: InlineToolCall, decision: ActionCardDecision) => {
    if (decision === "deny") {
      setExecuted((s) => ({ ...s, [idx]: "denied" }));
      return;
    }
    setExecuted((s) => ({ ...s, [idx]: "approved" }));
    if (decision === "allow" || decision === "allow-session") {
      try {
        await invoke("agent_execute_tool", { tool: call.tool, args: call.args });
      } catch (e) {
        console.error("agent_execute_tool failed:", e);
      }
    }
  };

  const handleCopyMessage = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch (e) {
      console.warn("copy message failed:", e);
    }
  };

  // Decorate every inline `<code>` (i.e., NOT inside a <pre>) in the rendered
  // body with a click-to-send affordance. The user can shift+click an inline
  // command to push it into the active terminal — useful when the assistant
  // hands back things like "run `git pull`" without a fenced block. Visual
  // hint comes from a CSS class that surfaces a tiny ▶ on hover.
  useEffect(() => {
    if (isUser) return;
    const root = bodyRef.current;
    if (!root) return;
    const codes = root.querySelectorAll<HTMLElement>("code");
    const cleanups: Array<() => void> = [];
    codes.forEach((codeEl) => {
      // Skip code blocks that live inside a <pre> — those already have a
      // dedicated CodeBlockToolbar. We only target true inline code.
      if (codeEl.closest("pre")) return;
      codeEl.classList.add("ai-chat-inline-code");
      codeEl.title = "点击发送到终端";
      const onClick = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const text = codeEl.textContent ?? "";
        if (!text || !targetEntry) return;
        const payload = prepareTerminalInput(text);
        if (!payload) return;
        targetEntry.writeInput(payload.text);
        codeEl.classList.add("ai-chat-inline-code-sent");
        window.setTimeout(() => codeEl.classList.remove("ai-chat-inline-code-sent"), 800);
      };
      codeEl.addEventListener("click", onClick);
      cleanups.push(() => codeEl.removeEventListener("click", onClick));
    });
    return () => cleanups.forEach((fn) => fn());
    // Re-run when the rendered HTML structure changes (new tokens during
    // streaming) or when the target terminal flips.
  }, [isUser, stripped, format, targetEntry]);

  // Collect every fenced code block in this assistant message. Used by the
  // header's "全部发送" button — common case is the assistant proposing a
  // sequence of shell commands and the user wanting to run them all.
  const codeBlocks = useMemo(() => {
    if (isUser) return [] as string[];
    return splitFencedBlocks(stripped)
      .filter((s) => s.kind === "code")
      .map((s) => s.value);
  }, [isUser, stripped]);

  const commitSendAll = (entry: TerminalRegistryEntry, payload: PreparedTerminalInput) => {
    entry.writeInput(payload.text);
    setSentAll(true);
    window.setTimeout(() => setSentAll(false), 1200);
  };

  const handleSendAll = () => {
    if (!targetEntry || codeBlocks.length === 0) return;
    const payload = prepareTerminalInput(codeBlocks.join("\n"));
    if (!payload) return;
    if (payload.isMultiline) {
      setPendingSendAll({ entry: targetEntry, payload });
      return;
    }
    commitSendAll(targetEntry, payload);
  };

  return (
    <div className={`flex flex-col gap-0.5 group ${isUser ? "items-end" : "items-start"}`}>
      <div
        className={`relative max-w-[90%] rounded-lg px-3 py-2 text-[12px] leading-relaxed break-words ${
          isUser
            ? "bg-[var(--moba-accent)] text-white rounded-br-sm whitespace-pre-wrap"
            : `bg-[var(--moba-panel-bg)] border border-[var(--moba-divider)] rounded-bl-sm ${
                renderedHtml || segments ? "moba-chat-md" : "whitespace-pre-wrap"
              }`
        }`}
      >
        {/* Per-message hover toolbar — copy + (assistant only) send-all-blocks. */}
        <div
          className={`absolute -top-2 ${isUser ? "left-1" : "right-1"} flex gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity`}
        >
          {!isUser && codeBlocks.length > 0 && (
            <button
              type="button"
              className="h-5 px-1.5 inline-flex items-center gap-1 rounded border border-[var(--moba-accent)]/40 bg-[var(--moba-panel-bg)] text-[10px] text-[var(--moba-accent)] hover:bg-[var(--moba-accent)]/10 disabled:opacity-50"
              onClick={handleSendAll}
              disabled={!targetEntry}
              title={
                targetEntry
                  ? `把全部 ${codeBlocks.length} 段命令依序发送到 ${targetEntry.title}`
                  : "无可用终端 — 请先打开/聚焦一个终端 tab"
              }
              aria-label="Send all code blocks to terminal"
            >
              {sentAll ? (
                <Check className="w-3 h-3 text-green-400" />
              ) : (
                <Send className="w-3 h-3" />
              )}
              <span>全部 →终端</span>
            </button>
          )}
          <button
            type="button"
            className="h-5 w-5 p-0 inline-flex items-center justify-center rounded border border-[var(--moba-divider)] bg-[var(--moba-panel-bg)]"
            onClick={handleCopyMessage}
            title="复制此条消息"
            aria-label="Copy this message"
          >
            {copied ? (
              <Check className="w-3 h-3 text-green-400" />
            ) : (
              <Copy className="w-3 h-3 text-[var(--moba-text-muted)]" />
            )}
          </button>
        </div>

        {/* Body — three rendering modes. */}
        <div ref={bodyRef}>
          {segments
            ? segments.map((seg, i) => {
              if (seg.kind === "code") {
                return (
                  <CodeBlockToolbar
                    key={i}
                    code={seg.value}
                    lang={seg.lang}
                    preferredTabId={preferredTerminalTabId}
                  />
                );
              }
              // Render the prose chunk through marked+sanitize so inline
              // formatting (bold, links, inline code) still works.
              const html = (() => {
                try {
                  return renderFormatted(seg.value, "md");
                } catch (e) {
                  console.warn("renderFormatted segment failed:", e);
                  return null;
                }
              })();
              if (!html) {
                return <span key={i} className="whitespace-pre-wrap">{seg.value}</span>;
              }
              return <div key={i} dangerouslySetInnerHTML={{ __html: html }} />;
            })
            : renderedHtml
              ? <div dangerouslySetInnerHTML={{ __html: renderedHtml }} />
              : stripped}
        </div>
      </div>
      {toolCalls.map((call, i) => (
        <div key={i} className="max-w-[90%] mt-1">
          {executed[i] === "denied" ? (
            <div className="text-[11px] text-[var(--moba-text-muted)] italic">
              已拒绝 {call.tool}
            </div>
          ) : executed[i] === "approved" ? (
            <div className="text-[11px] text-[var(--moba-accent)]">
              已执行 {call.tool}
            </div>
          ) : (
            <ActionCard
              tool={call.tool}
              description={call.description ?? `Agent 想要执行：${call.tool}`}
              preview={call.preview ?? null}
              requiresConfirmation={call.requiresConfirmation}
              onDecide={(d) => handleDecide(i, call, d)}
            />
          )}
        </div>
      ))}
      {message.redacted && (
        <div
          className="inline-flex items-center gap-1 text-[10px] rounded px-1.5 py-0.5 self-start"
          style={{
            background: "var(--moba-badge-warning-bg)",
            color: "var(--moba-badge-warning-text)",
            border: "1px solid var(--moba-badge-warning-border)",
          }}
        >
          <ShieldAlert className="w-3 h-3" />
          已脱敏敏感字段
        </div>
      )}
      {pendingSendAll && (
        <ConfirmDialog
          title="确认发送多行内容"
          message={`将向终端“${pendingSendAll.entry.title}”发送 ${pendingSendAll.payload.lineCount} 行内容。多行内容可能会触发终端执行，请确认后继续。`}
          confirmLabel="发送"
          cancelLabel="取消"
          onCancel={() => setPendingSendAll(null)}
          onConfirm={() => {
            commitSendAll(pendingSendAll.entry, pendingSendAll.payload);
            setPendingSendAll(null);
          }}
        />
      )}
    </div>
  );
}

interface PendingMessageTerminalSend {
  entry: TerminalRegistryEntry;
  payload: PreparedTerminalInput;
}
