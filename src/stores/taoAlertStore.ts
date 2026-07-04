import { create } from "zustand";
import type { TaoAlert } from "../lib/tao/taoAlerts";

/**
 * Holds transient chat "AI reply ready" and mail "new mail" alerts. Notes
 * alerts live in notesStore (persisted in notes.db); the Tao Ribbon merges all
 * sources via buildTaoAlerts(). Kept out of chatStore/mail UI state so those
 * modules stay domain-only.
 */
interface TaoAlertStore {
  aiDone: TaoAlert[];
  mailNew: TaoAlert[];
  /** Record a background chat completion (deduped per thread). */
  pushAiDone: (threadId: string, title: string) => void;
  /** Record new mail discovered by periodic sync, aggregated per visual mail tab. */
  pushMailNew: (tabId: string, accountId: string, title: string, count: number) => void;
  /** Remove a specific ai_done alert by its alert id. */
  ack: (id: string) => void;
  /** Clear any ai_done alert(s) for a thread (e.g. when the user opens it). */
  clearThread: (threadId: string) => void;
  /** Clear the new-mail alert for one visual mail tab. */
  clearMailTab: (tabId: string) => void;
  /** Drop mail alerts whose target tab no longer exists. */
  pruneMailTabs: (openTabIds: string[]) => void;
  clearAll: () => void;
}

export const useTaoAlertStore = create<TaoAlertStore>((set) => ({
  aiDone: [],
  mailNew: [],
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
  pushMailNew: (tabId, accountId, title, count) =>
    set((s) => {
      if (!tabId || count <= 0) return s;
      const existing = s.mailNew.find((a) => a.mailTabId === tabId);
      const rest = s.mailNew.filter((a) => a.mailTabId !== tabId);
      const alert: TaoAlert = {
        id: `mail:${tabId}`,
        source: "mail",
        kind: "mail_new",
        title: title || accountId || "Mail",
        count: (existing?.count ?? 0) + count,
        mailTabId: tabId,
        mailAccountId: accountId,
        fireAt: Math.floor(Date.now() / 1000),
      };
      return { mailNew: [...rest, alert] };
    }),
  ack: (id) => set((s) => ({ aiDone: s.aiDone.filter((a) => a.id !== id) })),
  clearThread: (threadId) =>
    set((s) => ({ aiDone: s.aiDone.filter((a) => a.threadId !== threadId) })),
  clearMailTab: (tabId) =>
    set((s) => ({ mailNew: s.mailNew.filter((a) => a.mailTabId !== tabId) })),
  pruneMailTabs: (openTabIds) =>
    set((s) => {
      const open = new Set(openTabIds);
      const mailNew = s.mailNew.filter((a) => !!a.mailTabId && open.has(a.mailTabId));
      return mailNew.length === s.mailNew.length ? s : { mailNew };
    }),
  clearAll: () => set({ aiDone: [], mailNew: [] }),
}));
