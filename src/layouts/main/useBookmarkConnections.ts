import { useEffect, useRef } from "react";
import { getAppPlatform } from "../../lib/runtime";
import { readSessionBookmark, shortcutMatches } from "../../lib/sessionBookmark";
import type { SessionConfig } from "../../lib/ipc";
import { useSessionStore } from "../../stores/sessionStore";
import { useAppStore } from "../../stores/appStore";

/** Startup is scoped to this main window lifetime. Loading/StrictMode cleanup
 * cannot consume the once flag before the actual session list is available. */
export function useBookmarkConnections(connect: (sessions: SessionConfig[]) => void) {
  const callback = useRef(connect);
  callback.current = connect;
  const started = useRef(false);
  useEffect(() => {
    let cancelled = false;
    void useSessionStore.getState().loadSessions().then(() => {
      if (cancelled || started.current) return;
      started.current = true;
      const open = new Set(useAppStore.getState().tabs.map((tab) => tab.sessionId));
      callback.current(useSessionStore.getState().sessions.filter((session) =>
        readSessionBookmark(session.options_json).autoConnect && !open.has(session.id) && session.session_type !== "Proxy"));
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target;
      if (event.defaultPrevented || event.repeat || event.isComposing ||
        (target instanceof Element && target.closest("input,textarea,select,[contenteditable=true],[role=dialog]")) ||
        document.querySelector('[data-testid="session-editor"],[role="dialog"][aria-modal="true"]')) return;
      const matches = useSessionStore.getState().sessions.filter((session) =>
        session.session_type !== "Proxy" && shortcutMatches(readSessionBookmark(session.options_json).shortcut, event, getAppPlatform() === "macos"));
      // Ambiguous shortcuts never connect an arbitrary account.
      if (matches.length !== 1) return;
      event.preventDefault();
      callback.current(matches);
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, []);
}
