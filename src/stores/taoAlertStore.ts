import { create } from "zustand";
import type { TaoAlert } from "../lib/tao/taoAlerts";

export type TaoAlertHistoryLimit = 30 | 300;

export interface TaoAlertHistoryEntry extends TaoAlert {
  /** Stable key for one historical occurrence. */
  historyId: string;
  /** When this occurrence first entered the local history. */
  firstSeenAt: number;
  /** Last time the same occurrence was observed/refreshed. */
  lastSeenAt: number;
}

export const DEFAULT_TAO_ALERT_HISTORY_LIMIT: TaoAlertHistoryLimit = 300;

const HISTORY_STORAGE_KEY = "taomni.taoAlerts.history.v1";
const HISTORY_LIMIT_STORAGE_KEY = "taomni.taoAlerts.historyLimit.v1";

export function taoAlertHistoryKey(alert: Pick<TaoAlert, "id" | "fireAt">): string {
  return `${alert.id}:${alert.fireAt}`;
}

function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

function coerceHistoryLimit(value: unknown): TaoAlertHistoryLimit {
  return Number(value) === 30 ? 30 : DEFAULT_TAO_ALERT_HISTORY_LIMIT;
}

function safeReadStorage(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeWriteStorage(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Best-effort UI history persistence.
  }
}

function normalizeHistoryEntry(value: unknown): TaoAlertHistoryEntry | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<TaoAlertHistoryEntry>;
  if (typeof raw.id !== "string" || typeof raw.title !== "string") return null;
  if (typeof raw.source !== "string" || typeof raw.kind !== "string") return null;
  const fireAt = Number(raw.fireAt);
  const firstSeenAt = Number(raw.firstSeenAt);
  const lastSeenAt = Number(raw.lastSeenAt);
  if (!Number.isFinite(fireAt) || !Number.isFinite(firstSeenAt) || !Number.isFinite(lastSeenAt)) return null;
  return {
    ...raw,
    id: raw.id,
    source: raw.source as TaoAlert["source"],
    kind: raw.kind as TaoAlert["kind"],
    title: raw.title,
    count: typeof raw.count === "number" ? raw.count : undefined,
    threadId: raw.threadId ?? null,
    noteId: raw.noteId ?? null,
    mailTabId: raw.mailTabId ?? null,
    mailAccountId: raw.mailAccountId ?? null,
    fireAt,
    historyId: typeof raw.historyId === "string" ? raw.historyId : `${raw.id}:${fireAt}`,
    firstSeenAt,
    lastSeenAt,
  };
}

function readHistoryLimit(): TaoAlertHistoryLimit {
  return coerceHistoryLimit(safeReadStorage(HISTORY_LIMIT_STORAGE_KEY));
}

function readHistory(limit: TaoAlertHistoryLimit): TaoAlertHistoryEntry[] {
  const raw = safeReadStorage(HISTORY_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return sortAndTrimHistory(parsed.map(normalizeHistoryEntry).filter((entry): entry is TaoAlertHistoryEntry => entry !== null), limit);
  } catch {
    return [];
  }
}

function persistHistory(history: TaoAlertHistoryEntry[]): void {
  safeWriteStorage(HISTORY_STORAGE_KEY, JSON.stringify(history));
}

function persistHistoryLimit(limit: TaoAlertHistoryLimit): void {
  safeWriteStorage(HISTORY_LIMIT_STORAGE_KEY, String(limit));
}

function sortAndTrimHistory(history: TaoAlertHistoryEntry[], limit: TaoAlertHistoryLimit): TaoAlertHistoryEntry[] {
  return [...history]
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt || b.fireAt - a.fireAt || a.historyId.localeCompare(b.historyId))
    .slice(0, limit);
}

function sameHistory(a: TaoAlertHistoryEntry[], b: TaoAlertHistoryEntry[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, index) => {
    const other = b[index];
    return other &&
      entry.historyId === other.historyId &&
      entry.title === other.title &&
      entry.count === other.count &&
      entry.lastSeenAt === other.lastSeenAt &&
      entry.kind === other.kind &&
      entry.source === other.source;
  });
}

function upsertHistory(
  history: TaoAlertHistoryEntry[],
  alerts: TaoAlert[],
  limit: TaoAlertHistoryLimit,
): TaoAlertHistoryEntry[] {
  if (alerts.length === 0) return history;
  const seenAt = nowSecs();
  const byId = new Map(history.map((entry) => [entry.historyId, entry]));
  for (const alert of alerts) {
    const historyId = taoAlertHistoryKey(alert);
    const existing = byId.get(historyId);
    byId.set(historyId, {
      ...alert,
      historyId,
      firstSeenAt: existing?.firstSeenAt ?? seenAt,
      lastSeenAt: seenAt,
    });
  }
  return sortAndTrimHistory([...byId.values()], limit);
}

/**
 * Holds transient chat "AI reply ready" and mail "new mail" alerts. Notes
 * alerts live in notesStore (persisted in notes.db); the Tao Ribbon merges all
 * sources via buildTaoAlerts(). Kept out of chatStore/mail UI state so those
 * modules stay domain-only.
 */
interface TaoAlertStore {
  aiDone: TaoAlert[];
  mailNew: TaoAlert[];
  history: TaoAlertHistoryEntry[];
  historyLimit: TaoAlertHistoryLimit;
  /** Record a background chat completion (deduped per thread). */
  pushAiDone: (threadId: string, title: string) => void;
  /** Record new mail discovered by periodic sync, aggregated per visual mail tab. */
  pushMailNew: (tabId: string, accountId: string, title: string, count: number) => void;
  /** Remember pending alerts as searchable local history without making them visible by default. */
  recordHistory: (alerts: TaoAlert[]) => void;
  setHistoryLimit: (limit: TaoAlertHistoryLimit) => void;
  clearHistory: () => void;
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

const initialHistoryLimit = readHistoryLimit();

export const useTaoAlertStore = create<TaoAlertStore>((set) => ({
  aiDone: [],
  mailNew: [],
  history: readHistory(initialHistoryLimit),
  historyLimit: initialHistoryLimit,
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
      const history = upsertHistory(s.history, [alert], s.historyLimit);
      if (!sameHistory(history, s.history)) persistHistory(history);
      return { aiDone: [...rest, alert], history };
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
      const history = upsertHistory(s.history, [alert], s.historyLimit);
      if (!sameHistory(history, s.history)) persistHistory(history);
      return { mailNew: [...rest, alert], history };
    }),
  recordHistory: (alerts) =>
    set((s) => {
      const next = upsertHistory(s.history, alerts, s.historyLimit);
      if (sameHistory(next, s.history)) return s;
      persistHistory(next);
      return { history: next };
    }),
  setHistoryLimit: (limit) =>
    set((s) => {
      const nextLimit = coerceHistoryLimit(limit);
      const history = sortAndTrimHistory(s.history, nextLimit);
      persistHistoryLimit(nextLimit);
      persistHistory(history);
      return { historyLimit: nextLimit, history };
    }),
  clearHistory: () => {
    persistHistory([]);
    set({ history: [] });
  },
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
