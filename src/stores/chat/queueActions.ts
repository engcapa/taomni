import { invoke } from "@tauri-apps/api/core";
import type { StoreApi } from "zustand";
import { type ChatStore, type QueuedSend } from "./model";
import { MAX_QUEUED_SENDS, nextThreadSendingState, pruneQueue, queueId, runQueuedSend } from "./queue";

export function createChatQueueActions(set: StoreApi<ChatStore>["setState"], get: StoreApi<ChatStore>["getState"]): Pick<ChatStore, "enqueueMessage" | "dequeueSend" | "clearQueue" | "stopSending"> {
  return {

    enqueueMessage: async (threadId, content, terminalContext, attachments) => {
      const trimmed = content.trim();
      if (!threadId || !trimmed) return { status: "skipped" };

      // Idle thread: nothing to wait behind. Run it through the same executor as
      // queued items so a send that arrives mid-flight is picked up when this one
      // finishes, no matter which path put it there.
      if (get().sendingByThreadId[threadId] !== true) {
        void runQueuedSend({ getState: get, setState: set }, threadId, { id: queueId(), content: trimmed, terminalContext, attachments });
        return { status: "sent" };
      }

      const queued = get().sendQueues[threadId] ?? [];
      if (queued.length >= MAX_QUEUED_SENDS) {
        // Rejected outright rather than dropping the oldest: the caller still
        // holds the text and can resend, whereas a silent eviction would lose a
        // message the user believed was accepted.
        return { status: "rejected", limit: MAX_QUEUED_SENDS };
      }

      const item: QueuedSend = { id: queueId(), content: trimmed, terminalContext, attachments };
      set((s) => ({
        sendQueues: { ...s.sendQueues, [threadId]: [...(s.sendQueues[threadId] ?? []), item] },
      }));
      return { status: "queued", position: queued.length + 1 };
    },

    dequeueSend: (threadId, itemId) => {
      set((s) => {
        const queued = s.sendQueues[threadId];
        if (!queued) return s;
        const next = queued.filter((item) => item.id !== itemId);
        if (next.length === queued.length) return s;
        return { sendQueues: pruneQueue(s.sendQueues, threadId, next) };
      });
    },

    clearQueue: (threadId) => {
      set((s) => (s.sendQueues[threadId] ? { sendQueues: pruneQueue(s.sendQueues, threadId, []) } : s));
    },

    stopSending: async (threadId: string) => {
      try {
        await invoke("chat_stop_stream", { threadId });
      } catch (e) {
        console.error("chat_stop_stream failed:", e);
      }
      // Deliberately leaves `sendQueues` alone: stopping is "skip this answer".
      // `runQueuedSend`'s finally block picks up the next parked send, so the
      // queue keeps moving. Callers wanting a full abort call `clearQueue` too.
      set((s) => nextThreadSendingState(s.sendingByThreadId, threadId, false));
    }
  };
}
