// ED-PARITY-012 DEC-012-02/04: IDEA keeps the last Find/Replace strings in a
// per-user history. Session memory is authoritative; localStorage only carries
// it across reloads and may be unavailable (private window, blocked storage).
export type SearchHistoryKind = "find" | "replace";

export const SEARCH_HISTORY_LIMIT = 10;

export const SEARCH_HISTORY_KEY = "taomni.editorSearchHistory.v1";

export let searchHistory: Record<SearchHistoryKind, string[]> | null = null;

export function loadSearchHistory(): Record<SearchHistoryKind, string[]> {
  if (searchHistory) return searchHistory;
  const empty: Record<SearchHistoryKind, string[]> = { find: [], replace: [] };
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(SEARCH_HISTORY_KEY) ?? "null") as unknown;
    if (parsed && typeof parsed === "object") {
      for (const kind of ["find", "replace"] as const) {
        const list = (parsed as Record<string, unknown>)[kind];
        if (Array.isArray(list)) {
          empty[kind] = list.filter((item): item is string => typeof item === "string" && item.length > 0)
            .slice(0, SEARCH_HISTORY_LIMIT);
        }
      }
    }
  } catch {
    // Unreadable storage: start from an empty session history.
  }
  searchHistory = empty;
  return searchHistory;
}

export function readSearchHistory(kind: SearchHistoryKind): readonly string[] {
  return loadSearchHistory()[kind];
}

export function recordSearchHistory(kind: SearchHistoryKind, value: string): void {
  if (!value) return;
  const history = loadSearchHistory();
  history[kind] = [value, ...history[kind].filter((item) => item !== value)].slice(0, SEARCH_HISTORY_LIMIT);
  try {
    globalThis.localStorage?.setItem(SEARCH_HISTORY_KEY, JSON.stringify(history));
  } catch {
    // Session history still works without storage.
  }
}

/** Test hook: forget the in-memory history so storage is read again. */
export function resetSearchHistoryForTests(): void {
  searchHistory = null;
}
