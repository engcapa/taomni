import { redactText } from "../redact";
import type { TaoChatState } from "./ports";

export interface TaoHandoff {
  sourceThreadId: string;
  sourceMessageId: string;
  linkedTabId?: string;
  content: string;
}

/** Capture a reviewable handoff at the clicked message. Do not include future
 * messages, unsent drafts, thinking, raw protocol blocks or opaque file IDs. */
export function prepareHandoff(state: TaoChatState, messageId: string): TaoHandoff {
  const thread = state.activeThreadId ? state.threads[state.activeThreadId] : undefined;
  const index = thread?.messages.findIndex((message) => message.id === messageId) ?? -1;
  if (!thread || index < 0) throw new Error("The source conversation is unavailable.");
  const bound = state.context;
  const history = thread.messages.slice(0, index + 1).map((message) => {
    const outcomes = message.blocks.flatMap((block) => block.action?.status && ["completed", "invalid", "rejected", "undone", "cancelled"].includes(block.action.status)
      ? [`Action ${block.action.title}: ${block.action.status}, exit ${block.action.result?.exitCode ?? "unknown"}\n${block.action.result?.output ?? ""}`] : []);
    return `${message.role}: ${message.text}\n${outcomes.join("\n")}`;
  }).join("\n\n");
  const excerpts = state.composer.chips.filter((chip) => !chip.fileId).map((chip) => `${chip.label}: ${chip.body ?? chip.preview ?? ""}`).join("\n");
  const metadata = [bound.workspace ? `Workspace: ${bound.workspace}` : "", bound.terminalId ? `Bound terminal: ${bound.terminalId}` : "", bound.databaseId ? `Bound database: ${bound.databaseId}` : ""].filter(Boolean).join("\n");
  const goal = thread.messages.find((message) => message.role === "user")?.text ?? "";
  const text = `Continue the user's development task from this Tao handoff. Plan, develop, test, diagnose failures, fix and add requested features. Respect the bridge's approval policy. Prior proposals are not proof of execution.\n\n${metadata}\n<untrusted_original_goal>\n${goal.slice(0,4000)}\n</untrusted_original_goal>\n<untrusted_tao_history>\n${history.slice(-24000)}\n</untrusted_tao_history>\n<untrusted_selected_excerpts>\n${excerpts.slice(0,4000)}\n</untrusted_selected_excerpts>`;
  return { sourceThreadId: thread.id, sourceMessageId: messageId, linkedTabId: bound.workspaceId ?? bound.terminalId ?? bound.databaseId, content: redactText(text).text };
}
