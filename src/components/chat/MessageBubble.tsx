import type { ChatMessage } from "../../stores/chatStore";
import { Check, Copy, ShieldAlert } from "lucide-react";
import { ActionCard, type ActionCardDecision } from "../agent/ActionCard";
import { invoke } from "@tauri-apps/api/core";
import { useMemo, useState } from "react";
import { renderFormatted, type ChatOutputFormat } from "../../lib/chat/renderFormatted";
import { CodeBlockToolbar, splitFencedBlocks } from "./CodeBlockToolbar";

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
        {/* Per-message copy button — visible on hover or focus. */}
        <button
          type="button"
          className={`absolute -top-2 ${isUser ? "left-1" : "right-1"} h-5 w-5 p-0 inline-flex items-center justify-center rounded border border-[var(--moba-divider)] bg-[var(--moba-panel-bg)] opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity`}
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

        {/* Body — three rendering modes. */}
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
    </div>
  );
}
