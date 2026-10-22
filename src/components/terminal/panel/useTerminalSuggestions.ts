import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { useSuggestionSource } from "../../../lib/terminal/aiSuggestionSource";
import { captureBufferCommand } from "./buffer";

export interface UseTerminalSuggestionsContext {
  history: import("../../../lib/history").CommandHistory;
  suggestionsActive: boolean;
  inlineSuggestionsSource: "history" | "history+path" | "history+path+ai";
  isLocal: boolean;
  termRef: import("react").RefObject<Terminal | null>;
}

export function useTerminalSuggestions(context: UseTerminalSuggestionsContext) {
  const {
    history,
    suggestionsActive,
    inlineSuggestionsSource,
    isLocal,
    termRef,
  } = context;

  // Refs decouple the once-mounted xterm.onData callback from the live
  // history/enabled values. Without this, the initial writeXtermInput closure
  // captures the empty prewarm cache and never sees later state changes.
  const historyRef = useRef(history);
  const suggestionsActiveRef = useRef(suggestionsActive);
  const inlineSuggestionsSourceRef = useRef(inlineSuggestionsSource);
  const isLocalRef = useRef(isLocal);
  /** Last absolute local cwd we already recorded into command history. */
  const lastRecordedLocalDirRef = useRef<string | null>(null);
  /** OSC-7 reports can arrive before the async PTY creation result. */
  const pendingLocalDirectoryReportsRef = useRef<string[]>([]);
  useEffect(() => {
    historyRef.current = history;
    suggestionsActiveRef.current = suggestionsActive;
    inlineSuggestionsSourceRef.current = inlineSuggestionsSource;
    isLocalRef.current = isLocal;
  }, [history, suggestionsActive, inlineSuggestionsSource, isLocal]);

  // AI suggestion source resolver (data sources 2 + 3).
  // The resolver caches its options on every render; passing a thunk for
  // recent history keeps it invalidation-free without triggering rerenders.
  const recentHistoryForSuggestion = useMemo(
    () => history.recent(5),
    // The history hook bumps a cache version internally on commit, but we
    // only want to pull a fresh snapshot for new keystrokes — depending on
    // history alone here is fine because match() is the keystroke trigger.
    [history],
  );
  const resolveSuggestion = useSuggestionSource({
    source: inlineSuggestionsSource,
    isLocal,
    recentHistory: recentHistoryForSuggestion,
  });

  // State shared between onData tracking and the ghost renderer.
  const pendingRef = useRef("");
  const invalidatedRef = useRef(false);
  const suggestionRef = useRef<string | null>(null);
  const [ghostTick, setGhostTick] = useState(0);
  const ghostVisibleRef = useRef(false);

  const bumpGhost = useCallback(() => setGhostTick((v) => v + 1), []);

  const refreshSuggestion = useCallback(() => {
    if (!suggestionsActiveRef.current || invalidatedRef.current || pendingRef.current === "") {
      if (suggestionRef.current !== null) {
        suggestionRef.current = null;
      }
      bumpGhost();
      return;
    }
    const prefix = pendingRef.current;
    const matches = historyRef.current.match(prefix, 1);
    const historyMatch = matches[0] && matches[0].length > prefix.length ? matches[0] : null;

    if (historyMatch !== null) {
      // Source 1 hit — use immediately.
      suggestionRef.current = historyMatch;
      bumpGhost();
      return;
    }

    // Source 1 miss — try sources 2/3 asynchronously.
    const source = inlineSuggestionsSourceRef.current;
    if (source === "history+path" || source === "history+path+ai") {
      void resolveSuggestion(prefix, null, (result) => {
        // Only apply if the prefix hasn't changed since we started.
        if (pendingRef.current === prefix && !invalidatedRef.current) {
          suggestionRef.current = result;
          bumpGhost();
        }
      });
    } else {
      suggestionRef.current = null;
      bumpGhost();
    }
  }, [bumpGhost, resolveSuggestion]);

  const invalidatePending = useCallback(() => {
    if (invalidatedRef.current && suggestionRef.current === null) return;
    invalidatedRef.current = true;
    suggestionRef.current = null;
    bumpGhost();
  }, [bumpGhost]);

  const trackPending = useCallback((data: string) => {
    // History commit on Enter is always needed (Welcome recent-folders reads
    // host_key=local command history). Ghost-text suggestion tracking is
    // separate and only runs when suggestions are enabled — PowerShell local
    // shells disable suggestions (PSReadLine owns that UX) but still must
    // record typed commands.
    const suggestionsOn = suggestionsActiveRef.current;

    // Bracketed paste: whole block is shell input, never a typed command.
    if (data.startsWith("\x1b[200~")) {
      if (suggestionsOn) invalidatePending();
      return;
    }

    // Defensive: large chunk with any control char → treat as paste, invalidate.
    if (data.length > 64) {
      if (suggestionsOn) invalidatePending();
      return;
    }

    let changed = false;
    for (let i = 0; i < data.length; i++) {
      const code = data.charCodeAt(i);

      // CR / LF → Enter: commit the actual command on screen (handles Tab
      // completion, history recall, etc.), fall back to tracked pending.
      if (code === 0x0d || code === 0x0a) {
        let committed: string | null = null;
        const term = termRef.current;
        if (term && term.buffer.active.type !== "alternate") {
          const fromBuffer = captureBufferCommand(term);
          if (fromBuffer) committed = fromBuffer;
        }
        if (!committed && pendingRef.current !== "" && !invalidatedRef.current) {
          committed = pendingRef.current;
        }
        if (committed) historyRef.current.commit(committed);
        pendingRef.current = "";
        invalidatedRef.current = false;
        changed = true;
        continue;
      }

      // Below: only track keystrokes for ghost-text when suggestions are on.
      if (!suggestionsOn) {
        continue;
      }

      // Ctrl+C: cancel current line entirely, but re-enable suggestions immediately.
      if (code === 0x03) {
        pendingRef.current = "";
        invalidatedRef.current = false;
        changed = true;
        continue;
      }

      // Backspace / DEL.
      if (code === 0x08 || code === 0x7f) {
        if (!invalidatedRef.current && pendingRef.current.length > 0) {
          pendingRef.current = pendingRef.current.slice(0, -1);
          changed = true;
        }
        continue;
      }

      // Escape or any CSI-like sequence — arrows, Home/End, Tab completion, function
      // keys: give up on the current line until the next Enter.
      if (code === 0x1b || code === 0x09) {
        invalidatedRef.current = true;
        changed = true;
        // Skip rest of this data chunk; it's almost certainly a single escape seq.
        break;
      }

      // Other C0 control chars (Ctrl+A/E/U/W/K/L/R/...) → invalidate.
      if (code < 0x20) {
        invalidatedRef.current = true;
        changed = true;
        break;
      }

      // Printable: append unless we're already invalidated.
      if (!invalidatedRef.current) {
        pendingRef.current += data[i];
        changed = true;
      }
    }

    if (changed && suggestionsOn) refreshSuggestion();
  }, [invalidatePending, refreshSuggestion]);

  // Rerun suggestion matching whenever the live cache or the on/off toggles
  // change — this is what picks up a freshly-prewarmed history list.
  useEffect(() => {
    refreshSuggestion();
  }, [suggestionsActive, history, refreshSuggestion]);
  return {
    trackPending,
    pendingRef,
    invalidatedRef,
    refreshSuggestion,
    suggestionsActiveRef,
    suggestionRef,
    ghostVisibleRef,
    bumpGhost,
    pendingLocalDirectoryReportsRef,
    isLocalRef,
    lastRecordedLocalDirRef,
    historyRef,
    ghostTick,
  };
}
