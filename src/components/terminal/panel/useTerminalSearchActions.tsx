import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { SearchAddon } from "@xterm/addon-search";
import { type SearchMatch } from "./types";
import { findAndSelectBufferText } from "./buffer";


export interface UseTerminalSearchActionsContext {
  searchAddonRef: import("react").RefObject<SearchAddon | null>;
  termRef: import("react").RefObject<Terminal | null>;
  clearTerminalBlockSelection: () => void;
  focusTerminal: () => void;
  searchInputRef: import("react").RefObject<HTMLInputElement | null>;
}

export function useTerminalSearchActions(context: UseTerminalSearchActionsContext) {
  const { searchAddonRef, termRef, clearTerminalBlockSelection, focusTerminal, searchInputRef } = context;
  const fallbackSearchRef = useRef<{ query: string; index: number; }>({ query: "", index: -1 });

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchValue, setSearchValue] = useState("");
  const searchTimerRef = useRef<number | null>(null);
  const [searchStatus, setSearchStatus] = useState("");
  const [searchMatches, setSearchMatches] = useState<SearchMatch[]>([]);
  const [activeSearchIndex, setActiveSearchIndex] = useState(-1);

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    setSearchStatus("");
  }, []);

  const cancelPendingSearch = useCallback(() => {
    if (searchTimerRef.current !== null) {
      window.clearTimeout(searchTimerRef.current);
      searchTimerRef.current = null;
    }
  }, []);

  const closeSearch = useCallback(() => {
    cancelPendingSearch();
    setSearchOpen(false);
    setSearchStatus("");
    setSearchMatches([]);
    setActiveSearchIndex(-1);
    searchAddonRef.current?.clearDecorations();
    termRef.current?.clearSelection();
    clearTerminalBlockSelection();
    focusTerminal();
  }, [cancelPendingSearch, clearTerminalBlockSelection, focusTerminal]);

  const runSearch = useCallback((direction: "next" | "previous" = "next") => {
    cancelPendingSearch();
    const terminal = termRef.current;
    const term = (searchInputRef.current?.value ?? searchValue).trim();
    if (!terminal || !term) {
      searchAddonRef.current?.clearDecorations();
      setSearchMatches([]);
      setActiveSearchIndex(-1);
      setSearchStatus("");
      return;
    }

    searchAddonRef.current?.clearDecorations();
    clearTerminalBlockSelection();
    const result = findAndSelectBufferText(
      terminal,
      term,
      direction,
      fallbackSearchRef,
    );
    if (result) {
      setSearchMatches(result.matches);
      setActiveSearchIndex(result.index);
      setSearchStatus(`Match ${result.index + 1}/${result.total}`);
    } else {
      setSearchMatches([]);
      setActiveSearchIndex(-1);
      setSearchStatus("No matches");
    }
  }, [cancelPendingSearch, clearTerminalBlockSelection, searchValue]);


  useEffect(() => {
    if (!searchOpen) return;

    const frame = requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });

    return () => cancelAnimationFrame(frame);
  }, [searchOpen]);

  useEffect(() => {
    if (!searchOpen) return;
    if (!searchValue.trim()) {
      searchAddonRef.current?.clearDecorations();
      setSearchMatches([]);
      setActiveSearchIndex(-1);
      termRef.current?.clearSelection();
      setSearchStatus("");
      return;
    }

    searchTimerRef.current = window.setTimeout(() => runSearch("next"), 120);
    return cancelPendingSearch;
  }, [cancelPendingSearch, runSearch, searchOpen, searchValue]);
  return { openSearch, closeSearch, cancelPendingSearch, runSearch, setSearchOpen, setSearchStatus, searchTimerRef, setSearchMatches, setActiveSearchIndex, searchValue, fallbackSearchRef, searchOpen, searchMatches, activeSearchIndex, setSearchValue, searchStatus };
}
