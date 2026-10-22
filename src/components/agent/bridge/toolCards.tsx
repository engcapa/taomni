import { useChatStore } from "../../../stores/chatStore";
import { useAppStore } from "../../../stores/appStore";
import { type AgentToolContext } from "./types";


export const agentToolCardTargets = new Map<string, string>();


export function updateAgentToolCardResult(ctx: AgentToolContext, result: string): void {
  const messageId = useChatStore.getState().streamingId[ctx.threadId];
  if (!messageId) return;

  useChatStore.setState((state) => {
    const cards = [...(state.ccToolCards[messageId] ?? [])];
    const targetCallId = agentToolCardTargets.get(ctx.callId) ?? ctx.callId;
    let idx = cards.findIndex((card) => card.call_id === targetCallId);
    if (idx < 0) {
      for (let i = cards.length - 1; i >= 0; i -= 1) {
        const cardTool = cards[i]?.tool ?? "";
        if (
          cardTool === ctx.tool ||
          cardTool.endsWith(`__${ctx.tool}`) ||
          cardTool.includes(ctx.tool)
        ) {
          idx = i;
          agentToolCardTargets.set(ctx.callId, cards[i].call_id);
          break;
        }
      }
    }

    if (idx >= 0) {
      cards[idx] = { ...cards[idx], result };
    } else {
      cards.push({ call_id: ctx.callId, tool: ctx.tool, detail: "", result });
      agentToolCardTargets.set(ctx.callId, ctx.callId);
    }
    return { ccToolCards: { ...state.ccToolCards, [messageId]: cards } };
  });
}


export function reportAgentToolStatus(ctx: AgentToolContext | null | undefined, message: string): void {
  useAppStore.getState().setStatusMessage(message);
  if (ctx) updateAgentToolCardResult(ctx, message);
}
