import type { ChatMessage } from "../../stores/chatStore";
import { ShieldAlert } from "lucide-react";
import { ActionCard, type ActionCardDecision } from "../agent/ActionCard";
import { invoke } from "@tauri-apps/api/core";
import { useMemo, useState } from "react";
import { renderFormatted, type ChatOutputFormat } from "../../lib/chat/renderFormatted";

interface MessageBubbleProps {
  message: ChatMessage;
  /** Resolved output format for this thread; defaults to "md" when omitted. */
  format?: ChatOutputFormat;
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

export function MessageBubble({ message, format = "md" }: MessageBubbleProps) {
  const isUser = message.role === "user";
  const [executed, setExecuted] = useState<Record<number, "approved" | "denied">>({});

  const { stripped, toolCalls } = isUser
    ? { stripped: message.content, toolCalls: [] as InlineToolCall[] }
    : parseInlineToolCalls(message.content);

  // Only assistant messages get markdown / HTML rendering. User input stays
  // verbatim — what the user typed is what the user sees.
  const renderedHtml = useMemo(() => {
    if (isUser || format === "plain") return null;
    try {
      return renderFormatted(stripped, format);
    } catch (e) {
      // If anything blows up (malformed markdown, sanitizer edge case…),
      // fall back to plain text rather than swallowing the message.
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

  return (
    <div className={`flex flex-col gap-0.5 ${isUser ? "items-end" : "items-start"}`}>
      <div
        className={`max-w-[90%] rounded-lg px-3 py-2 text-[12px] leading-relaxed break-words ${
          isUser
            ? "bg-[var(--moba-accent)] text-white rounded-br-sm whitespace-pre-wrap"
            : `bg-[var(--moba-panel-bg)] border border-[var(--moba-divider)] rounded-bl-sm ${
                renderedHtml ? "moba-chat-md" : "whitespace-pre-wrap"
              }`
        }`}
      >
        {renderedHtml ? (
          <div dangerouslySetInnerHTML={{ __html: renderedHtml }} />
        ) : (
          stripped
        )}
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
        <div className="flex items-center gap-1 text-[10px] text-yellow-500">
          <ShieldAlert className="w-3 h-3" />
          已脱敏敏感字段
        </div>
      )}
    </div>
  );
}
