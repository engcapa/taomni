import { type ChatStore, type QueuedSend } from "./model";

/**
 * Cap on sends waiting behind the current turn, per thread. Small on purpose:
 * a deep queue means the user is typing far ahead of answers they have not read
 * yet, and each queued turn was written without the context of the replies that
 * will land before it.
 */
export const MAX_QUEUED_SENDS = 5;

export function queueId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `q-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function nextSendingAggregate(sendingByThreadId: Record<string, boolean>): boolean {
  return Object.values(sendingByThreadId).some(Boolean);
}

export function nextThreadSendingState(
  current: Record<string, boolean>,
  threadId: string,
  sending: boolean,
): Pick<ChatStore, "sendingByThreadId" | "sending"> {
  const next = { ...current };
  if (sending) {
    next[threadId] = true;
  } else {
    delete next[threadId];
  }
  return {
    sendingByThreadId: next,
    sending: nextSendingAggregate(next),
  };
}

/** Drop a thread's queue key entirely when it empties, so the map stays clean. */
export function pruneQueue(
  queues: Record<string, QueuedSend[]>,
  threadId: string,
  next: QueuedSend[],
): Record<string, QueuedSend[]> {
  const result = { ...queues };
  if (next.length === 0) {
    delete result[threadId];
  } else {
    result[threadId] = next;
  }
  return result;
}

/**
 * Run one send, then pull the thread's next parked send and repeat.
 *
 * The recursion lives in `finally`, so the chain advances whether the turn
 * succeeded, threw, or was cut short by `stopSending` — a failed turn must not
 * strand everything behind it. Errors are logged rather than rethrown: the user
 * already sees them in the transcript (`sendMessage` writes an error message
 * into the stream), and this is a detached background chain with no caller left
 * to catch.
 *
 * Defined outside the store so it can reference `useChatStore` lazily and stay
 * off the public interface — callers use `enqueueMessage`.
 */
export async function runQueuedSend(store: Pick<import("zustand").StoreApi<ChatStore>, "getState" | "setState">, threadId: string, item: QueuedSend): Promise<void> {
  try {
    await store.getState().sendMessage(
      threadId,
      item.content,
      item.terminalContext,
      item.attachments,
    );
  } catch (e) {
    console.error("queued chat send failed:", e);
  } finally {
    let next: QueuedSend | undefined;
    store.setState((s) => {
      const queued = s.sendQueues[threadId];
      if (!queued || queued.length === 0) return s;
      [next] = queued;
      return { sendQueues: pruneQueue(s.sendQueues, threadId, queued.slice(1)) };
    });
    if (next) void runQueuedSend(store, threadId, next);
  }
}
