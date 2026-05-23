import { invoke } from "@tauri-apps/api/core";
import { useCallback, useRef } from "react";
import type { InlineSuggestionsSource } from "../terminalProfile";

interface SuggestionSourceOptions {
  source: InlineSuggestionsSource;
  isLocal: boolean;
  cwd?: string;
}

/**
 * Returns a function that, given a typed prefix and the history match,
 * resolves the best suggestion using the configured data sources.
 *
 * Priority: history (1) → PATH/files (2) → FIM (3, placeholder)
 *
 * The function is async for sources 2 and 3, but source 1 is synchronous
 * (already computed by the caller). The caller passes historyMatch as the
 * already-computed source-1 result.
 */
export function useSuggestionSource(opts: SuggestionSourceOptions) {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  // Debounce timer for PATH/FIM requests.
  const pathTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resolve = useCallback(async (
    prefix: string,
    historyMatch: string | null,
    onResult: (suggestion: string | null) => void,
  ) => {
    const { source, isLocal, cwd } = optsRef.current;

    // Source 1: history (already computed, synchronous)
    if (historyMatch !== null) {
      onResult(historyMatch);
      return;
    }

    // Source 2: PATH / files (async, <5ms target)
    if (source === "history+path" || source === "history+path+ai") {
      if (pathTimerRef.current) clearTimeout(pathTimerRef.current);
      pathTimerRef.current = setTimeout(async () => {
        try {
          const matches = await invoke<string[]>("tab_suggest_path", {
            prefix,
            cwd: cwd ?? null,
            isLocal,
          });
          if (matches.length > 0) {
            // Return the first match that extends the prefix.
            const best = matches.find((m) => m.length > prefix.length) ?? null;
            onResult(best);
            return;
          }
        } catch {
          // Silently ignore — PATH scan is best-effort.
        }

        // Source 3: FIM (placeholder — real llama-cpp-2 in-process in v2.2d full)
        if (source === "history+path+ai") {
          // TODO: invoke tab_suggest_fim when llama-cpp-2 is integrated
          onResult(null);
        } else {
          onResult(null);
        }
      }, 0); // No debounce for PATH (it's fast); FIM would use 120ms
    } else {
      onResult(null);
    }
  }, []);

  return resolve;
}
