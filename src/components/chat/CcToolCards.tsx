import { useMemo } from "react";
import { useChatStore } from "../../stores/chatStore";
import { ToolActivityBlock } from "./ToolActivityBlock";
import type { ToolActivityEntry } from "./toolActivity";

/**
 * Live, display-only Claude Code / ACP tool-activity cards + usage footer (3.5).
 *
 * These render *only while the assistant message is streaming*: the backend
 * emits structured `cc_tool_activity` events for rich display and clears them
 * on `end`, at which point the persisted message content carries the compact
 * text transcript instead (rendered collapsed via `ToolActivityBlock` in
 * MessageBubble). Nothing here is re-executable — confirmation already happened
 * live via the in-app permission prompt — so this never triggers a tool call.
 * The usage footer persists for the in-session message.
 */
export function CcToolCards({ messageId }: { messageId: string }) {
  const cards = useChatStore((s) => s.ccToolCards[messageId]);
  const usage = useChatStore((s) => s.ccUsage[messageId]);

  const tools = useMemo<ToolActivityEntry[]>(() => {
    if (!cards || cards.length === 0) return [];
    return cards.map((c) => ({
      tool: c.tool,
      detail: c.detail || undefined,
      result: c.result,
    }));
  }, [cards]);

  const hasCards = tools.length > 0;
  if (!hasCards && !usage) return null;

  return (
    <div className="ml-7 mb-1 flex flex-col gap-1">
      {hasCards && <ToolActivityBlock tools={tools} />}
      {usage && <UsageFooter usage={usage} />}
    </div>
  );
}

function UsageFooter({
  usage,
}: {
  usage: NonNullable<ReturnType<typeof useChatStore.getState>["ccUsage"][string]>;
}) {
  const parts: string[] = [];
  if (usage.input_tokens != null || usage.output_tokens != null) {
    parts.push(`↑${usage.input_tokens ?? 0} ↓${usage.output_tokens ?? 0} tok`);
  }
  if (usage.cost_usd != null) parts.push(`$${usage.cost_usd.toFixed(4)}`);
  if (usage.duration_ms != null) parts.push(`${(usage.duration_ms / 1000).toFixed(1)}s`);
  if (parts.length === 0) return null;
  return (
    <div className="text-[9px] text-[var(--taomni-text-muted)] tabular-nums">
      {parts.join(" · ")}
    </div>
  );
}
