import { useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { isEditableTarget } from "../../../lib/terminal/keyboardGuards";
import { type TerminalBlockSelection } from "./types";
import { isMacPrintableOptionInput } from "./policy";


export interface UseTerminalShortcutsContext {
  setFullscreen: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  extendTerminalBlockSelectionByKeyboard: (key: string) => boolean;
  isMac: boolean;
  writeBroadcastInput: (data: string) => void;
  blockSelectionRef: import("react").RefObject<TerminalBlockSelection | null>;
  clearTerminalBlockSelection: () => void;
  isLocal: boolean;
  supportsShellTools: boolean;
  readOnlyRef: import("react").RefObject<boolean>;
  termRef: import("react").RefObject<Terminal | null>;
  setPaletteOpen: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  aiCommandRewriteEnabled: boolean;
  isLocalPowerShell: boolean;
  setAiRewriteOpen: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  getActiveTerminalSelectionText: () => string;
  copySelection: () => Promise<void>;
  suppressNativePasteUntilRef: import("react").RefObject<number>;
  pasteFromClipboard: () => Promise<void>;
  openSearch: () => void;
  saveBufferToFile: () => void;
  gitToggle: { cwd: string | null; onOpen: () => void; } | undefined;
  increaseFontSize: () => void;
  decreaseFontSize: () => void;
  resetFontSize: () => void;
  executeMacro: () => void;
  searchOpen: boolean;
  closeSearch: () => void;
  acceptInlineSuggestion: () => boolean;
}

export function useTerminalShortcuts(context: UseTerminalShortcutsContext) {
  const {
    setFullscreen,
    extendTerminalBlockSelectionByKeyboard,
    isMac,
    writeBroadcastInput,
    blockSelectionRef,
    clearTerminalBlockSelection,
    isLocal,
    supportsShellTools,
    readOnlyRef,
    termRef,
    setPaletteOpen,
    aiCommandRewriteEnabled,
    isLocalPowerShell,
    setAiRewriteOpen,
    getActiveTerminalSelectionText,
    copySelection,
    suppressNativePasteUntilRef,
    pasteFromClipboard,
    openSearch,
    saveBufferToFile,
    gitToggle,
    increaseFontSize,
    decreaseFontSize,
    resetFontSize,
    executeMacro,
    searchOpen,
    closeSearch,
    acceptInlineSuggestion,
  } = context;

  const handleShortcutKey = useCallback((event: KeyboardEvent): boolean => {
    if (isEditableTarget(event.target, document.activeElement)) {
      return true;
    }
    if (event.key === "F11") {
      event.preventDefault();
      setFullscreen((v) => !v);
      return false;
    }
    if (
      event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey &&
      (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "ArrowLeft" || event.key === "ArrowRight")
    ) {
      if (extendTerminalBlockSelectionByKeyboard(event.key)) {
        event.preventDefault();
        return false;
      }
    }
    if (isMac && isMacPrintableOptionInput(event)) {
      event.preventDefault();
      writeBroadcastInput(event.key);
      return false;
    }
    if (event.key === "Escape" && blockSelectionRef.current) {
      event.preventDefault();
      clearTerminalBlockSelection();
      return false;
    }
    if (
      isLocal && supportsShellTools &&
      event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey &&
      event.key.toLowerCase() === "p"
    ) {
      if (readOnlyRef.current) return false;
      if (termRef.current?.buffer.active.type === "alternate") return false;
      event.preventDefault();
      setPaletteOpen(true);
      return false;
    }
    // Ctrl+K: AI command rewrite overlay (v2.2)
    if (
      supportsShellTools && aiCommandRewriteEnabled && !isLocalPowerShell &&
      event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey &&
      event.key.toLowerCase() === "k"
    ) {
      if (readOnlyRef.current) return false;
      if (termRef.current?.buffer.active.type === "alternate") return false;
      event.preventDefault();
      setAiRewriteOpen(true);
      return false;
    }
    // Cross-platform copy/paste shortcuts
    if (isMac) {
      if (event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "c") {
        if (getActiveTerminalSelectionText()) {
          event.preventDefault();
          void copySelection();
          return false;
        }
        return true; // no selection: pass through (sends ETX)
      }
      if (event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "v") {
        event.preventDefault();
        if (!readOnlyRef.current) {
          // The desktop clipboard helper uses native IPC on macOS, so Cmd+V
          // does not depend on WKWebView synthesizing a paste event or prompt
          // for navigator.clipboard permission. Ignore a late native event to
          // keep the shortcut from inserting the same text twice.
          suppressNativePasteUntilRef.current = Date.now() + 500;
          void pasteFromClipboard();
        }
        return false;
      }
    } else {
      // Windows / Linux
      if (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === "c") {
        if (getActiveTerminalSelectionText()) {
          event.preventDefault();
          void copySelection();
          return false;
        }
        return true; // no selection: pass through
      }
      if (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === "v") {
        if (!readOnlyRef.current) {
          event.preventDefault();
          void pasteFromClipboard();
          return false;
        }
        return true;
      }
    }
    if (event.shiftKey && event.key === "Insert") {
      event.preventDefault();
      void pasteFromClipboard();
      return false;
    }
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      openSearch();
      return false;
    }
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "s") {
      event.preventDefault();
      saveBufferToFile();
      return false;
    }
    if (
      gitToggle &&
      event.shiftKey &&
      event.key.toLowerCase() === "g" &&
      (isMac ? event.metaKey : event.ctrlKey) &&
      !event.altKey
    ) {
      event.preventDefault();
      gitToggle.onOpen();
      return false;
    }
    if (event.ctrlKey && (event.key === "+" || event.key === "=")) {
      event.preventDefault();
      increaseFontSize();
      return false;
    }
    if (event.ctrlKey && (event.key === "-" || event.key === "_")) {
      event.preventDefault();
      decreaseFontSize();
      return false;
    }
    if (event.ctrlKey && event.key === "0") {
      event.preventDefault();
      resetFontSize();
      return false;
    }
    if (event.ctrlKey && event.code === "Space") {
      event.preventDefault();
      executeMacro();
      return false;
    }
    if (searchOpen && event.key === "Escape") {
      event.preventDefault();
      closeSearch();
      return false;
    }
    if (
      (event.key === "ArrowRight" || event.key === "End") &&
      !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey
    ) {
      if (acceptInlineSuggestion()) {
        event.preventDefault();
        return false;
      }
    }
    return true;
  }, [
    acceptInlineSuggestion,
    closeSearch,
    clearTerminalBlockSelection,
    decreaseFontSize,
    executeMacro,
    gitToggle,
    extendTerminalBlockSelectionByKeyboard,
    getActiveTerminalSelectionText,
    increaseFontSize,
    isLocal,
    isMac,
    openSearch,
    pasteFromClipboard,
    resetFontSize,
    saveBufferToFile,
    searchOpen,
    supportsShellTools,
    writeBroadcastInput,
  ]);
  return { handleShortcutKey };
}
