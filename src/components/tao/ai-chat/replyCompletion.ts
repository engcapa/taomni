import { parseActionReply } from "../actions";
import type { TaoMessage } from "./ports";

/** A truncated batch is incomplete: it must never publish executable actions. */
export function completeReply(message: TaoMessage, doMode: boolean, proposalId: () => string): TaoMessage {
  if (message.stopReason === "max_tokens") return message;
  const parsed = doMode ? parseActionReply(message.text) : { actions: [], text: message.text };
  const actions = parsed.actions;
  const blocks = actions.length > 0
    ? [...message.blocks.filter((block) => block.type !== "action").map((block) => block.type === "text" ? { ...block, text: parseActionReply(block.text || "").text } : block), ...actions.slice(0, 5).map((action) => ({ id: proposalId(), type: "action" as const, action: { ...action, executionId: proposalId() } }))]
    : message.blocks;
  return { ...message, text: parsed.text, blocks };
}

export function canResumeReply(message?: TaoMessage): boolean {
  return Boolean(message?.text.trim()) && Boolean(message?.blocks.every((block) => ["text", "thinking", "usage"].includes(block.type)));
}
