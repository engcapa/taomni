import { create } from "zustand";
import type { TaoAlert } from "../lib/tao/taoAlerts";

/**
 * Holds transient chat "AI reply ready" alerts (source === "chat"). Notes
 * alerts live in notesStore (persisted in notes.db); the Tao Ribbon merges both
 * via buildTaoAlerts(). Kept out of chatStore so chat stays chat-only.
 */
interface TaoAlertStore {
  aiDone: TaoAlert[];
  /** Record a background chat completion (deduped per thread). */
  pushAiDone: (threadId: string, title: string) => void;
  /** Remove a specific ai_done alert by its alert id. */
  ack: (id: string) => void;
  /** Clear any ai_done alert(s) for a thread (e.g. when the user opens it). */
  clearThread: (threadId: string) => void;
  clearAll: () => void;
}

export const useTaoAlertStore = create<TaoAlertStore>((set) => ({
  aiDone: [],
  pushAiDone: (threadId, title) =>
    set((s) => {
      // One live ai_done alert per thread — refresh title/time if it re-fires.
      const rest = s.aiDone.filter((a) => a.threadId !== threadId);
      const alert: TaoAlert = {
        id: `chat:${threadId}`,
        source: "chat",
        kind: "ai_done",
        title: title || "AI",
        threadId,
        fireAt: Math.floor(Date.now() / 1000),
      };
      return { aiDone: [...rest, alert] };
    }),
  ack: (id) => set((s) => ({ aiDone: s.aiDone.filter((a) => a.id !== id) })),
  clearThread: (threadId) =>
    set((s) => ({ aiDone: s.aiDone.filter((a) => a.threadId !== threadId) })),
  clearAll: () => set({ aiDone: [] }),
}));
