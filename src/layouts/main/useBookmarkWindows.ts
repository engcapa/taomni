import { useEffect, useRef } from "react";
import { readSessionBookmark } from "../../lib/sessionBookmark";
import { useAppStore } from "../../stores/appStore";
import { useSessionStore } from "../../stores/sessionStore";
import type { HandleDetachActiveTabContext } from "./detachedWindows";

/** Observe newly opened tabs rather than the selected tab: asynchronous auth
 * and multi-connect queues must hand off the intended session only once. */
export function useBookmarkWindows(actions: HandleDetachActiveTabContext) {
  const tabs = useAppStore((state) => state.tabs);
  const runtime = useAppStore((state) => state.terminalRuntimeByTab);
  const handled = useRef(new Set<string>());
  useEffect(() => {
    // Keep handled identities for this window lifetime: reattaching the same
    // tab must not immediately detach it again. New connections use new IDs.
    for (const tab of tabs) {
      if (!tab.sessionId || handled.current.has(tab.id)) continue;
      const session = useSessionStore.getState().sessions.find((session) => session.id === tab.sessionId);
      if (!session || !readSessionBookmark(session.options_json).openNewWindow) continue;
      // Wait for PTY creation before adopting its ownership into another window.
      if (tab.type === "terminal" && !runtime[tab.id]?.backendSessionId) continue;
      handled.current.add(tab.id);
      if (tab.type === "terminal") actions.openDetachedTerminal(tab.id, tab, tab.title);
      else if (tab.type === "rdp" && tab.rdp) actions.openDetachedRdp(tab.id, tab.rdp, tab.title);
      else if (tab.type === "vnc" && tab.vnc) actions.openDetachedVnc(tab.id, tab.vnc, tab.title);
      else if (tab.type === "database" && tab.db) actions.openDetachedDatabase(tab.id, tab.db, tab.title);
      else if (tab.type === "sftp" && tab.sftp) actions.openDetachedSftp(tab.sftp, tab.title);
    }
  }, [tabs, runtime, actions]);
}
