import type { TaoThread } from "../ai-chat";

export interface ThreadHistoryStorage {
  save(thread: TaoThread): Promise<void>;
  remove(thread: TaoThread): Promise<void>;
}

/** Serialize writes per conversation so an earlier autosave cannot resurrect a
 * deleted record. A failed delete releases the record for later save/retry. */
export function createThreadHistoryStorage(storage: ThreadHistoryStorage) {
  const writes = new Map<string, Promise<void>>();
  const deleted = new Set<string>();
  const enqueue = (id: string, action: () => Promise<void>) => {
    const request = (writes.get(id) ?? Promise.resolve()).catch(() => undefined).then(action);
    writes.set(id, request);
    void request.finally(() => { if (writes.get(id) === request) writes.delete(id); }).catch(() => undefined);
    return request;
  };
  return {
    save(thread: TaoThread) {
      if (thread.source === "legacy" || deleted.has(thread.id)) return Promise.resolve();
      return enqueue(thread.id, async () => {
        if (!deleted.has(thread.id)) await storage.save(thread);
      });
    },
    async remove(thread: TaoThread) {
      if (deleted.has(thread.id)) throw new Error("Conversation deletion is already pending.");
      deleted.add(thread.id);
      try { await enqueue(thread.id, () => storage.remove(thread)); }
      catch (error) { deleted.delete(thread.id); throw error; }
    },
  };
}
