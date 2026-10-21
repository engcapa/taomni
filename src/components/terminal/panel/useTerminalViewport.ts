import { useEffect } from "react";
import { Terminal } from "@xterm/xterm";
import { getDefaultTerminalFontFamily, getPrimaryFontName, isMonospaceFont } from "../../../lib/systemFonts";
import { shouldUseTerminalWebgl } from "./policy";


export interface UseTerminalViewportContext {
  webglRendererRef: import("react").RefObject<boolean>;
  webglRenderer: boolean;
  termRef: import("react").RefObject<Terminal | null>;
  disposeTerminalWebgl: (term: Terminal | null) => void;
  installTerminalWebgl: (term: Terminal) => void;
  fontFamily: string;
  fontSize: number;
  resolvePanelTheme: (name: string) => import("@xterm/xterm").ITheme;
  themeName: string;
  cursorBlink: boolean;
  cursorStyle: "block" | "underline" | "bar";
  scrollback: number;
  fitVisibleTerminal: (forceSync?: boolean) => void;
  visible: boolean;
  activeForShortcuts: boolean;
  searchOpen: boolean;
  focusTerminal: () => void;
  fullscreen: boolean;
  showScrollbar: boolean;
}

export function useTerminalViewport(context: UseTerminalViewportContext) {
  const { webglRendererRef, webglRenderer, termRef, disposeTerminalWebgl, installTerminalWebgl, fontFamily, fontSize, resolvePanelTheme, themeName, cursorBlink, cursorStyle, scrollback, fitVisibleTerminal, visible, activeForShortcuts, searchOpen, focusTerminal, fullscreen, showScrollbar } = context;

  useEffect(() => {
    webglRendererRef.current = webglRenderer;
    const term = termRef.current;
    if (!term) return;

    if (!shouldUseTerminalWebgl(webglRenderer)) {
      disposeTerminalWebgl(term);
      return;
    }
    installTerminalWebgl(term);
  }, [disposeTerminalWebgl, installTerminalWebgl, webglRenderer]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    const primaryFont = getPrimaryFontName(fontFamily);
    const safeFontFamily = isMonospaceFont(primaryFont) ? fontFamily : getDefaultTerminalFontFamily();

    term.options = {
      fontFamily: safeFontFamily,
      fontSize,
      theme: resolvePanelTheme(themeName),
      cursorBlink,
      cursorStyle,
      scrollback,
      macOptionIsMeta: false,
    };
    window.setTimeout(() => requestAnimationFrame(() => fitVisibleTerminal()), 0);
  }, [cursorBlink, cursorStyle, fitVisibleTerminal, fontFamily, fontSize, resolvePanelTheme, scrollback, themeName]);

  // When a hidden tab becomes visible again, re-measure xterm. Focus is
  // reserved for the active pane so split view does not race visible panes.
  useEffect(() => {
    if (!visible) return;

    let frame = 0;
    const timer = window.setTimeout(() => {
      frame = window.requestAnimationFrame(() => {
        fitVisibleTerminal();
        if (activeForShortcuts && !searchOpen) {
          focusTerminal();
        }
      });
    }, 50);

    return () => {
      window.clearTimeout(timer);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [activeForShortcuts, fitVisibleTerminal, focusTerminal, fullscreen, searchOpen, showScrollbar, visible]);
  return {  };
}
