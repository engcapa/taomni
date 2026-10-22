import { type ChatThread } from "./model";

// A thread list read can overlap a local create/update (for example while the
// drawer's initial load is still waiting on SQLite). Keep a small mutation
// revision outside persisted thread data so a stale read cannot replace a
// newer in-memory model/provider selection.
export let threadMutationRevision = 0;

export function markThreadMutation(): void {
  threadMutationRevision += 1;
}

export function mergeThreadsPreservingLocal(fetched: ChatThread[], local: ChatThread[]): ChatThread[] {
  const localById = new Map(local.map((thread) => [thread.id, thread]));
  const fetchedIds = new Set(fetched.map((thread) => thread.id));
  const merged = fetched.map((thread) => localById.get(thread.id) ?? thread);
  for (const thread of local) {
    if (!fetchedIds.has(thread.id)) merged.unshift(thread);
  }
  return merged;
}
