import { validateActionProposal } from "../actions";
import { taoText as tr } from "../i18n";
import type { ActionPorts, ActionProposal, TaoChatController, TaoChatState, TaoThread } from "./ports";

type Runtime = TaoChatState["runtime"][string];
interface ActionOwner {
  getState(): TaoChatState;
  patchThread(id: string, update: (thread: TaoThread) => TaoThread): void;
  patchRuntime(id: string, update: (runtime: Runtime) => Runtime): void;
  ports?: ActionPorts;
}

export const actionPending = (action: ActionProposal) => !action.status || action.status === "pending" || action.status === "approved";
export const actionKey = (action: ActionProposal) => action.executionId ?? action.id;

/** Own each mutation by its originating thread and message, across tab switches,
 * late executor replies, undo of older rounds and repeated model proposal IDs. */
export function createActionLifecycle(owner: ActionOwner): Pick<TaoChatController, "approveAction" | "rejectAction" | "undoAction"> {
  const busy = new Set<string>();
  const busyThreads = new Map<string, string>();
  const setBusy = (key: string, threadId: string, active: boolean) => {
    if (active) { busy.add(key); busyThreads.set(key, threadId); }
    else { busy.delete(key); busyThreads.delete(key); }
    owner.patchRuntime(threadId, (runtime) => ({ ...runtime, actionBusy: [...busyThreads.values()].includes(threadId) }));
  };
  const blocked = (threadId: string) => owner.getState().runtime[threadId]?.deleting || ["sending", "thinking", "searching", "streaming", "vault_locked"].includes(owner.getState().runtime[threadId]?.phase);
  const locate = (action: ActionProposal) => {
    const state = owner.getState();
    const thread = state.activeThreadId ? state.threads[state.activeThreadId] : undefined;
    const message = thread?.messages.find((m) => m.blocks.some((b) => b.action && actionKey(b.action) === actionKey(action)));
    const current = message?.blocks.find((b) => b.action && actionKey(b.action) === actionKey(action))?.action;
    return thread && message && current ? { thread, message, current, key: `${thread.id}:${actionKey(current)}` } : undefined;
  };
  const update = (source: NonNullable<ReturnType<typeof locate>>, action: ActionProposal) => {
    owner.patchThread(source.thread.id, (thread) => ({ ...thread, updatedAt: Date.now(), messages: thread.messages.map((m) => m.id === source.message.id ? { ...m, blocks: m.blocks.map((b) => b.action && actionKey(b.action) === actionKey(source.current) ? { ...b, action } : b) } : m) }));
    const pending = owner.getState().threads[source.thread.id]?.messages.some((m) => m.blocks.some((b) => b.action && actionPending(b.action)));
    owner.patchRuntime(source.thread.id, (runtime) => ({ ...runtime, phase: runtime.vaultLocked || runtime.phase === "vault_locked" ? "vault_locked" : pending ? "awaiting_action" : "idle", pendingAction: undefined }));
  };
  return {
    async approveAction(action) {
      const source = locate(action);
      if (!source || blocked(source.thread.id) || busy.has(source.key) || !actionPending(source.current) || source.current.status === "approved") return;
      const state = owner.getState();
      if (blocked(source.thread.id)) return;
      const checked = validateActionProposal(action, state.runtime[source.thread.id]?.lastRequest?.context ?? state.context);
      if (!checked.ok || !owner.ports?.execute) {
        update(source, { ...checked.action, status: "invalid", result: { output: checked.reason ?? tr("当前宿主没有提供动作执行器。") } });
        return;
      }
      setBusy(source.key, source.thread.id, true);
      update(source, { ...checked.action, status: "approved" });
      try {
        const result = await owner.ports.execute(checked.action, source.thread.id);
        const status = result?.status === "cancelled" ? "cancelled" : result?.status === "failed" || result?.exitCode !== undefined && result.exitCode !== 0 ? "invalid" : "completed";
        update(source, { ...checked.action, status, result });
      } catch (error) {
        update(source, { ...checked.action, status: "invalid", result: { output: String(error) } });
      } finally { setBusy(source.key, source.thread.id, false); }
    },
    async rejectAction(action) {
      const source = locate(action);
      if (!source || blocked(source.thread.id) || busy.has(source.key) || !actionPending(source.current) || source.current.status === "approved") return;
      setBusy(source.key, source.thread.id, true);
      try { await owner.ports?.reject?.(source.current); }
      finally { update(source, { ...source.current, status: "rejected" }); setBusy(source.key, source.thread.id, false); }
    },
    async undoAction(action) {
      const source = locate(action);
      if (!source || busy.has(source.key) || source.current.status !== "completed" || !source.current.result?.undoAvailable || !owner.ports?.undo) return;
      if (blocked(source.thread.id)) return;
      setBusy(source.key, source.thread.id, true);
      try {
        await owner.ports.undo(source.current, source.thread.id);
        update(source, { ...source.current, status: "undone", result: { ...source.current.result, undoAvailable: false, output: tr("已撤销") } });
      } catch (error) {
        update(source, { ...source.current, result: { ...source.current.result, output: String(error) } });
      } finally { setBusy(source.key, source.thread.id, false); }
    },
  };
}
