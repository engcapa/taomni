import { parseActionProposals } from "../actions";
import type { TaoMessage } from "./ports";

/** A truncated batch is incomplete: it must never publish executable actions. */
export function completeReply(message: TaoMessage, doMode: boolean, proposalId: () => string): TaoMessage {
  if (message.stopReason === "max_tokens") return message;
  const actions = doMode ? parseActionProposals(message.text) : [];
  const blocks = actions.length > 0
    ? [...message.blocks.filter((block) => block.type !== "action").map((block) => block.type === "text" ? { ...block, text: block.text?.replace(/```tao-action[\s\S]*?```/gi, "").trim() } : block), ...actions.slice(0, 5).map((action) => ({ id: proposalId(), type: "action" as const, action: { ...action, executionId: proposalId() } }))]
    : message.blocks;
  return { ...message, text: message.text.replace(/```tao-action[\s\S]*?```/g, "").trim(), blocks };
}

export function canResumeReply(message?: TaoMessage): boolean {
  return Boolean(message?.text.trim()) && Boolean(message?.blocks.every((block) => ["text", "thinking", "usage"].includes(block.type)));
}
