import { useCallback, type MouseEvent as ReactMouseEvent } from "react";
import { Terminal } from "@xterm/xterm";
import { type TerminalBlockSelection } from "./types";
import { formatPasteForTerminal } from "./transfer";
import { terminalCellFromMouseEvent, isTerminalBlockSelectionMouseEvent } from "./policy";
import { collectTerminalBlockSelectionText } from "./buffer";


export interface UseTerminalPointerContext {
  readOnlyRef: import("react").RefObject<boolean>;
  middleClickSelectionRef: import("react").RefObject<string>;
  setStatusMessage: (message: string) => void;
  getActiveTerminalSelectionText: () => string;
  writeBroadcastInput: (data: string) => void;
  termRef: import("react").RefObject<Terminal | null>;
  focusTerminal: () => void;
  pasteFromClipboard: () => Promise<void>;
  lastMacMiddlePasteAtRef: import("react").RefObject<number>;
  blockSelectionTextRef: import("react").RefObject<string>;
  copyOnSelectRef: import("react").RefObject<boolean>;
  writeClipboardText: (text: string, successMessage: string) => Promise<void>;
  showTerminalSelectionToolbar: (text: string) => void;
  containerRef: import("react").RefObject<HTMLDivElement | null>;
  updateTerminalBlockSelection: (next: TerminalBlockSelection | null) => void;
  setSelectionToolbar: import("react").Dispatch<import("react").SetStateAction<{ rect: { top: number; left: number; right: number; bottom: number; }; text: string; } | null>>;
  isMac: boolean;
  cancelPendingSearch: () => void;
  clearTerminalBlockSelection: () => void;
  suppressNativePasteUntilRef: import("react").RefObject<number>;
}

export function useTerminalPointer(context: UseTerminalPointerContext) {
  const {
    readOnlyRef,
    middleClickSelectionRef,
    setStatusMessage,
    getActiveTerminalSelectionText,
    writeBroadcastInput,
    termRef,
    focusTerminal,
    pasteFromClipboard,
    lastMacMiddlePasteAtRef,
    blockSelectionTextRef,
    copyOnSelectRef,
    writeClipboardText,
    showTerminalSelectionToolbar,
    containerRef,
    updateTerminalBlockSelection,
    setSelectionToolbar,
    isMac,
    cancelPendingSearch,
    clearTerminalBlockSelection,
    suppressNativePasteUntilRef,
  } = context;

  const pasteMiddleClickSelectionOrClipboard = useCallback(() => {
    if (readOnlyRef.current) {
      middleClickSelectionRef.current = "";
      setStatusMessage("Terminal is read-only");
      return;
    }

    const selection = getActiveTerminalSelectionText() || middleClickSelectionRef.current;
    middleClickSelectionRef.current = "";
    if (selection) {
      writeBroadcastInput(formatPasteForTerminal(termRef.current, selection));
      focusTerminal();
      return;
    }
    void pasteFromClipboard();
  }, [focusTerminal, getActiveTerminalSelectionText, pasteFromClipboard, setStatusMessage, writeBroadcastInput]);

  const shouldHandleMacMiddlePaste = useCallback(() => {
    const now = Date.now();
    if (now - lastMacMiddlePasteAtRef.current < 250) return false;
    lastMacMiddlePasteAtRef.current = now;
    return true;
  }, []);

  const finishTerminalBlockSelection = useCallback((selection: TerminalBlockSelection | null) => {
    if (!selection) return;
    const term = termRef.current;
    if (!term) return;
    const text = blockSelectionTextRef.current || collectTerminalBlockSelectionText(term, selection);
    if (copyOnSelectRef.current && text) {
      void writeClipboardText(text, "");
    }
    showTerminalSelectionToolbar(text);
  }, [showTerminalSelectionToolbar, writeClipboardText]);

  const startTerminalBlockSelection = useCallback((event: ReactMouseEvent) => {
    const term = termRef.current;
    const container = containerRef.current;
    if (!term || !container) return false;

    const anchor = terminalCellFromMouseEvent(term, container, event);
    if (!anchor) return false;

    event.preventDefault();
    event.stopPropagation();
    term.clearSelection();

    const initial = { anchor, focus: anchor };
    updateTerminalBlockSelection(initial);
    setSelectionToolbar(null);

    let latest = initial;
    const onMove = (moveEvent: globalThis.MouseEvent) => {
      const focus = terminalCellFromMouseEvent(term, container, moveEvent);
      if (!focus) return;
      latest = { anchor, focus };
      updateTerminalBlockSelection(latest);
    };
    const onUp = (upEvent: globalThis.MouseEvent) => {
      const focus = terminalCellFromMouseEvent(term, container, upEvent);
      if (focus) {
        latest = { anchor, focus };
        updateTerminalBlockSelection(latest);
      }
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      finishTerminalBlockSelection(latest);
      focusTerminal();
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return true;
  }, [finishTerminalBlockSelection, focusTerminal, updateTerminalBlockSelection]);

  // Middle-click paste: if the terminal has a current selection, paste it at
  // the cursor; otherwise fall back to the system clipboard. Linux/Windows use
  // auxclick; macOS gets a mouseup capture fallback because WKWebView does not
  // consistently dispatch auxclick for the middle button.
  const handleMiddleClick = useCallback((event: ReactMouseEvent) => {
    if (event.button !== 1) return;
    event.preventDefault();
    if (isMac && !shouldHandleMacMiddlePaste()) return;
    pasteMiddleClickSelectionOrClipboard();
  }, [isMac, pasteMiddleClickSelectionOrClipboard, shouldHandleMacMiddlePaste]);

  const handleTerminalMouseDownCapture = useCallback((event: ReactMouseEvent) => {
    if (event.button === 0) {
      const target = event.target;
      if (!(target instanceof Node) || !containerRef.current?.contains(target)) {
        return;
      }
      cancelPendingSearch();
      if (isTerminalBlockSelectionMouseEvent(event)) {
        startTerminalBlockSelection(event);
        return;
      }
      clearTerminalBlockSelection();
    }
    if (event.button === 1) {
      suppressNativePasteUntilRef.current = Date.now() + 500;
      middleClickSelectionRef.current = getActiveTerminalSelectionText();
    }
  }, [cancelPendingSearch, clearTerminalBlockSelection, getActiveTerminalSelectionText, startTerminalBlockSelection]);

  const handleTerminalMouseUpCapture = useCallback((event: ReactMouseEvent) => {
    if (!isMac || event.button !== 1) return;
    event.preventDefault();
    if (!shouldHandleMacMiddlePaste()) return;
    pasteMiddleClickSelectionOrClipboard();
  }, [isMac, pasteMiddleClickSelectionOrClipboard, shouldHandleMacMiddlePaste]);
  return { handleTerminalMouseDownCapture, handleTerminalMouseUpCapture, handleMiddleClick };
}
