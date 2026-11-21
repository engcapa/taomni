import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { explorerCancelOperation, explorerSearchEntries, type ExplorerSearchEntry } from "../../lib/explorer";
import { setExplorerPreferences, useExplorerPreferences } from "./explorerPreferences";

export interface ExplorerSearchController {
  query: string;
  setQuery: (query: string) => void;
  recursive: boolean;
  setRecursive: (recursive: boolean) => void;
  active: boolean;
  results: ExplorerSearchEntry[];
  relativePaths: Record<string, string>;
  searching: boolean;
  cancelling: boolean;
  scanned: number;
  truncated: boolean;
  cancelled: boolean;
  error: string | null;
  cancel: () => void;
  retry: () => void;
}

export function hasExplorerGlob(query: string): boolean {
  return /[*?\[]/.test(query) || /[\\/]/.test(query);
}

export function useExplorerSearch(path: string, showHidden: boolean, revision: unknown): ExplorerSearchController {
  const preferences = useExplorerPreferences();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ExplorerSearchEntry[]>([]);
  const [searching, setSearching] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [scanned, setScanned] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryVersion, setRetryVersion] = useState(0);
  const sequence = useRef(0);
  const operation = useRef<string | null>(null);
  const recursive = preferences.searchRecursive;
  const active = !!query.trim() && (recursive || hasExplorerGlob(query));

  const setRecursive = useCallback((value: boolean) => setExplorerPreferences({ searchRecursive: value }), []);
  const cancel = useCallback(() => {
    if (!operation.current) {
      sequence.current++;
      setSearching(false);
      setCancelling(false);
      setCancelled(true);
      return;
    }
    setCancelling(true);
    void explorerCancelOperation(operation.current).catch(() => undefined);
  }, []);

  useEffect(() => {
    const current = ++sequence.current;
    const previousOperation = operation.current;
    operation.current = null;
    if (previousOperation) void explorerCancelOperation(previousOperation).catch(() => undefined);
    setResults([]);
    setScanned(0);
    setTruncated(false);
    setCancelled(false);
    setCancelling(false);
    setError(null);
    if (!active || !path) {
      setSearching(false);
      return;
    }
    setSearching(true);
    const id = `explorer-search-${crypto.randomUUID()}`;
    const timer = window.setTimeout(() => {
      if (current !== sequence.current) return;
      void (async () => {
        operation.current = id;
        let unlisten: (() => void) | undefined;
        try {
          unlisten = await listen("explorer:progress", ({ payload }) => {
            const progress = payload as { operationId?: string; items?: number };
            if (current === sequence.current && progress.operationId === id) setScanned(progress.items ?? 0);
          });
          const result = await explorerSearchEntries(path, query.trim(), recursive, showHidden, id);
          if (current !== sequence.current) return;
          setResults(result.entries);
          setScanned(result.scanned);
          setTruncated(result.truncated);
          setCancelled(result.cancelled);
        } catch (reason) {
          if (current === sequence.current) setError(String(reason));
        } finally {
          unlisten?.();
          if (current === sequence.current) {
            setSearching(false);
            setCancelling(false);
            operation.current = null;
          }
        }
      })();
    }, 250);
    return () => {
      window.clearTimeout(timer);
      if (operation.current === id) {
        void explorerCancelOperation(id).catch(() => undefined);
        operation.current = null;
      }
    };
  }, [active, path, query, recursive, showHidden, revision, retryVersion]);

  useEffect(() => () => {
    sequence.current++;
    if (operation.current) void explorerCancelOperation(operation.current).catch(() => undefined);
    operation.current = null;
  }, []);

  const relativePaths = useMemo(() => Object.fromEntries(results.map((entry) => [entry.path, entry.relativePath])), [results]);
  return {
    query, setQuery, recursive, setRecursive, active, results, relativePaths, searching, cancelling,
    scanned, truncated, cancelled, error, cancel, retry: () => setRetryVersion((value) => value + 1),
  };
}
