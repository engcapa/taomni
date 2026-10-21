import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type PanelImperativeHandle, type PanelSize } from "react-resizable-panels";
import { useAppTheme } from "../../../lib/appTheme";
import { DEFAULT_MAIL_TERMINAL_PROFILE } from "../../../lib/terminalProfile";
import { MAILBOX_EXPANDED_SIZE, MAILBOX_RIBBON_THRESHOLD, clampMailFontSize, mailAppearanceStyle } from "./appearance";

export interface UseMailAppearanceContext {
  info: import("../../../types").MailTabInfo;
  visible: boolean;
  rootRef: import("react").RefObject<HTMLDivElement | null>;
}

export function useMailAppearance(context: UseMailAppearanceContext) {
  const { info, visible, rootRef } = context;
  const foldersPanelRef = useRef<PanelImperativeHandle>(null);
  const [mailboxCollapsed, setMailboxCollapsed] = useState(false);
  const [mailboxPaneSize, setMailboxPaneSize] = useState(MAILBOX_EXPANDED_SIZE);
  const profileFontSize = clampMailFontSize(info.terminalProfile?.fontSize ?? DEFAULT_MAIL_TERMINAL_PROFILE.fontSize);
  const [mailFontSize, setMailFontSize] = useState(profileFontSize);
  const { resolvedTheme } = useAppTheme();
  const appPrefersDark = resolvedTheme === "dark";
  const mailAppearance = useMemo(
    () => mailAppearanceStyle(info.terminalProfile, mailFontSize, appPrefersDark),
    [info.terminalProfile, mailFontSize, appPrefersDark],
  );
  const preferDarkReader = useMemo(() => {
    const scheme = String((mailAppearance as Record<string, string | number | undefined>)["--taomni-color-scheme"] ?? "");
    return scheme === "dark";
  }, [mailAppearance]);

  const increaseFontSize = useCallback(() => {
    setMailFontSize((size) => clampMailFontSize(size + 1));
  }, []);

  const decreaseFontSize = useCallback(() => {
    setMailFontSize((size) => clampMailFontSize(size - 1));
  }, []);

  const resetFontSize = useCallback(() => {
    setMailFontSize(profileFontSize);
  }, [profileFontSize]);

  useEffect(() => {
    setMailFontSize(profileFontSize);
  }, [info.sessionId, profileFontSize]);

  useEffect(() => {
    if (!visible) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const primary = event.ctrlKey || event.metaKey;
      if (!primary || event.altKey) return;
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        increaseFontSize();
        return;
      }
      if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        decreaseFontSize();
        return;
      }
      if (event.key === "0") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        resetFontSize();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [decreaseFontSize, increaseFontSize, resetFontSize, visible]);

  useEffect(() => {
    if (!visible) return;
    const root = rootRef.current;
    if (!root) return;

    const handleWheel = (event: WheelEvent) => {
      const primary = event.ctrlKey || event.metaKey;
      if (!primary) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.deltaY < 0) {
        increaseFontSize();
      } else if (event.deltaY > 0) {
        decreaseFontSize();
      }
    };

    root.addEventListener("wheel", handleWheel, { capture: true, passive: false });
    return () => root.removeEventListener("wheel", handleWheel, { capture: true });
  }, [decreaseFontSize, increaseFontSize, visible]);

  const expandMailboxPanel = useCallback(() => {
    foldersPanelRef.current?.resize(`${MAILBOX_EXPANDED_SIZE}%`);
    setMailboxPaneSize(MAILBOX_EXPANDED_SIZE);
    setMailboxCollapsed(false);
  }, []);

  const handleMailboxResize = useCallback((size: PanelSize) => {
    const percentage = size.asPercentage;
    setMailboxPaneSize(percentage);
    setMailboxCollapsed(percentage === 0);
  }, []);

  useEffect(() => {
    if (mailboxPaneSize > 0 && mailboxPaneSize <= MAILBOX_RIBBON_THRESHOLD) {
      setMailboxCollapsed(true);
      window.requestAnimationFrame(() => foldersPanelRef.current?.resize("0%"));
    }
  }, [mailboxPaneSize]);
  return { mailAppearance, mailFontSize, preferDarkReader, decreaseFontSize, increaseFontSize, mailboxCollapsed, expandMailboxPanel, foldersPanelRef, handleMailboxResize };
}
