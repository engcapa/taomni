import { invoke } from "@tauri-apps/api/core";
import { useCallback, useRef } from "react";
import type { InlineSuggestionsSource } from "../terminalProfile";

interface SuggestionSourceOptions {
  source: InlineSuggestionsSource;
  isLocal: boolean;
  cwd?: string;
  /** Recent commands fed as context to the FIM model. Already trimmed. */
  recentHistory?: string[];
}

/**
 * Returns a function that, given a typed prefix and the history match,
 * resolves the best suggestion using the configured data sources.
 *
 * Priority: history (1) → PATH/files (2) → FIM (3, llama-server / cloud)
 *
 * Source 1 (history) is computed by the caller and passed in synchronously.
 * Sources 2 (PATH/files) and 3 (FIM) are async; we debounce FIM by 120ms to
 * avoid hammering the LLM on every keystroke. New keystrokes invalidate the
 * pending request via the prefix-still-current check at apply time.
 */
const FIM_DEBOUNCE_MS = 120;

export function useSuggestionSource(opts: SuggestionSourceOptions) {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  // Debounce timer for FIM only — PATH is fast enough to fire immediately.
  const fimTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks the prefix we kicked the most recent FIM request for so a fresh
  // keystroke supersedes a slower in-flight request.
  const fimInflightPrefixRef = useRef<string | null>(null);

  const resolve = useCallback(async (
    prefix: string,
    historyMatch: string | null,
    onResult: (suggestion: string | null) => void,
  ) => {
    const { source, isLocal, cwd, recentHistory } = optsRef.current;

    // Source 1: history (already computed)
    if (historyMatch !== null) {
      onResult(historyMatch);
      return;
    }

    if (source !== "history+path" && source !== "history+path+ai") {
      onResult(null);
      return;
    }

    // Source 2: PATH / files (async, <5ms target)
    try {
      const matches = await invoke<string[]>("tab_suggest_path", {
        prefix,
        cwd: cwd ?? null,
        isLocal,
      });
      const best = matches.find((m) => m.length > prefix.length) ?? null;
      if (best !== null) {
        onResult(best);
        return;
      }
    } catch {
      // PATH scan is best-effort.
    }

    // Source 3: FIM (only when explicitly enabled)
    if (source !== "history+path+ai") {
      onResult(null);
      return;
    }

    // Cheap heuristic — don't fire FIM for very short prefixes; matches
    // tab_suggest_fim's <3 char skip but lets us avoid a roundtrip too.
    if (prefix.length < 3) {
      onResult(null);
      return;
    }

    if (fimTimerRef.current) clearTimeout(fimTimerRef.current);
    fimInflightPrefixRef.current = prefix;
    fimTimerRef.current = setTimeout(async () => {
      try {
        const completion = await invoke<string | null>("tab_suggest_fim", {
          prefix,
          recentHistory: recentHistory ?? [],
        });
        if (fimInflightPrefixRef.current !== prefix) {
          // A newer keystroke superseded us.
          return;
        }
        if (completion && completion.trim().length > 0) {
          // Build the full ghost-text by concatenating typed prefix + suggestion.
          // The FIM model returns only the continuation, but ghost-text needs
          // the full string so the renderer can compare against pendingRef.
          const tail = completion.replace(/^[\s`]+|[\s`]+$/g, "");
          if (tail.length === 0) { onResult(null); return; }
          onResult(prefix + tail);
        } else {
          onResult(null);
        }
      } catch {
        onResult(null);
      }
    }, FIM_DEBOUNCE_MS);
  }, []);

  return resolve;
}
