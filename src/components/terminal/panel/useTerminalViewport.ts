import { useEffect, useRef } from "react";
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
  const searchOpenRef = useRef(searchOpen);
  searchOpenRef.current = searchOpen;

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

  // Layout changes only measure. In particular, opening an adjacent file
  // browser must not reclaim focus from its path/rename inputs.
  useEffect(() => {
    if (!visible) return;

    let frame = 0;
    const timer = window.setTimeout(() => {
      frame = window.requestAnimationFrame(() => {
        fitVisibleTerminal();
      });
    }, 50);

    return () => {
      window.clearTimeout(timer);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [fitVisibleTerminal, fullscreen, showScrollbar, visible]);

  // Only activation owns automatic focus. Abandon a delayed request as soon
  // as another control claims focus, even if it later blurs back to body.
  useEffect(() => {
    if (!visible || !activeForShortcuts) return;
    let superseded = false;
    let frame = 0;
    const onFocus = () => { superseded = true; };
    document.addEventListener("focusin", onFocus, true);
    const timer = window.setTimeout(() => {
      frame = window.requestAnimationFrame(() => {
        document.removeEventListener("focusin", onFocus, true);
        const navigatingTabs = document.activeElement?.closest('[role="tablist"][data-keyboard-navigation="true"]');
        if (!superseded && !searchOpenRef.current && !navigatingTabs) focusTerminal();
      });
    }, 50);
    return () => {
      document.removeEventListener("focusin", onFocus, true);
      window.clearTimeout(timer);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [activeForShortcuts, focusTerminal, visible]);
  return {  };
}
