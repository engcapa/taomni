import type { MailDraft } from "./mail";

/**
 * Local Outbox (TASK-17). Queued messages are local drafts whose
 * `replyContext.outbox` holds the queue state. They are only sent while the
 * account's mail tab is open (DEC-01: no background sending), so "send
 * later" fires at the first moment the tab is open after `sendAt`.
 */
export interface MailOutboxState {
  /** Earliest send time (epoch seconds); null waits for "Send now". */
  sendAt?: number | null;
  queuedAt: number;
  attempts: number;
  lastError?: string | null;
  readReceipt?: boolean;
}

/** Retry delays after failed attempts (seconds). */
export const OUTBOX_RETRY_SECONDS = [60, 120, 300, 600, 1800];

export function outboxState(draft: MailDraft): MailOutboxState | null {
  return (draft.replyContext?.outbox as MailOutboxState | null | undefined) ?? null;
}

export function isOutbox(draft: MailDraft): boolean {
  return outboxState(draft) != null;
}

/** Epoch seconds when the queued message may go out next; null = manual. */
export function outboxNextAttemptAt(state: MailOutboxState): number | null {
  if (state.attempts > 0) {
    const base = Math.max(state.sendAt ?? 0, state.queuedAt);
    let wait = 0;
    for (let i = 0; i < state.attempts; i += 1) {
      wait += OUTBOX_RETRY_SECONDS[Math.min(i, OUTBOX_RETRY_SECONDS.length - 1)];
    }
    return base + wait;
  }
  return state.sendAt ?? null;
}

export function outboxDue(draft: MailDraft, now: number): boolean {
  const state = outboxState(draft);
  if (!state) return false;
  const at = outboxNextAttemptAt(state);
  return at != null && at <= now;
}

/**
 * Connection-level failures (offline, DNS, refused, timeouts, TLS setup)
 * queue the message for retry; anything else (auth, rejected recipient,
 * invalid address) stays in the composer so the user can fix it.
 */
export function isTransientSendError(message: string): boolean {
  return /(connect|connection|network|offline|timed? ?out|dns|resolve|lookup|unreachable|refused|reset|broken pipe|temporar|try again|\b(?:421|450|451|452)\b)/i
    .test(message);
}

/** `datetime-local` value (local time) for an epoch-seconds instant. */
export function toDateTimeLocal(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Parse a `datetime-local` value; null when empty or invalid. */
export function fromDateTimeLocal(value: string): number | null {
  if (!value.trim()) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}
