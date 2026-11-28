import { useCallback, useEffect, useRef, useState } from "react";
import { explorerCancelOperation } from "../../lib/explorer";
import { searchGlobalFiles, validFileQuery, type GlobalFileResults } from "../../lib/explorer/globalFileSearch";

type SearchState =
  | { phase: "idle" | "loading" | "cancelled" }
  | { phase: "error"; detail: string }
  | { phase: "done"; results: GlobalFileResults };

export function useGlobalFileSearch(contextRoot?: string, initialQuery = "") {
  const [query, setQuery] = useState(initialQuery);
  const [state, setState] = useState<SearchState>({ phase: "idle" });
  const current = useRef<string | null>(null);

  const stop = useCallback(() => {
    const id = current.current;
    current.current = null;
    if (id) void explorerCancelOperation(id).catch(() => {});
  }, []);

  const submit = useCallback(async (value: string) => {
    if (current.current || !validFileQuery(value)) return;
    const id = crypto.randomUUID();
    current.current = id;
    setState({ phase: "loading" });
    try {
      const results = await searchGlobalFiles(value, id, contextRoot);
      if (current.current === id) setState({ phase: "done", results });
    } catch (error) {
      if (current.current !== id) return;
      const detail = error instanceof Error ? error.message : String(error);
      setState(detail.startsWith("cancelled:") ? { phase: "cancelled" } : { phase: "error", detail });
    } finally {
      if (current.current === id) current.current = null;
    }
  }, [contextRoot]);

  useEffect(() => {
    // A seeded query comes only from a confirmed palette action. Defer its
    // dispatch until mounting settles, including React Strict Mode's rehearsal.
    let mounted = true;
    if (validFileQuery(initialQuery)) queueMicrotask(() => { if (mounted) void submit(initialQuery); });
    return () => { mounted = false; stop(); };
  }, [initialQuery, submit, stop]);

  return {
    query, state,
    edit(value: string) {
      stop();
      setState({ phase: "idle" });
      setQuery(value);
    },
    cancel() {
      stop();
      setState({ phase: "cancelled" });
    },
    submit: () => void submit(query),
  };
}
