import { useEffect } from "react";
import { parentPath } from "../../lib/sftp";
import { useSftpStore } from "../../stores/sftpStore";

/** The only directory owner remains the shared local pane. */
export function useExplorerDirectory(tabId: string, initialPath: string, notice: (message: string) => void) {
  const session = useSftpStore((state) => state.sessions[tabId]);
  useEffect(() => {
    let disposed = false;
    const store = useSftpStore.getState();
    void store.attachLocalOnly(tabId, initialPath).then(async () => {
      if (disposed) return;
      const pane = useSftpStore.getState().sessions[tabId]?.local;
      // A permission error is not a missing directory; never silently hide it.
      if (!pane?.error || !/not found|no such file|cannot find|does not exist|os error [23]\b/i.test(pane.error)) return;
      let candidate = pane.path;
      while (!disposed) {
        const parent = parentPath(candidate);
        if (parent === candidate) break;
        candidate = parent;
        await store.navigate(tabId, "local", candidate);
        if (disposed) return;
        if (!useSftpStore.getState().sessions[tabId]?.local.error) {
          notice(`${initialPath} → ${candidate}`);
          break;
        }
      }
    }).catch((error) => { if (!disposed) notice(String(error)); });
    return () => { disposed = true; store.detachLocalOnly(tabId); };
    // initialPath is a seed, not a controlled path. Persistence updates must not reattach.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);
  useEffect(() => {
    const refresh = () => {
      const root = document.querySelector(`[data-testid="explorer-tab"][data-tab-id="${CSS.escape(tabId)}"]`);
      if (root?.getClientRects().length && document.visibilityState !== "hidden") {
        const store = useSftpStore.getState();
        if (!store.sessions[tabId]?.local.loading) void store.refreshPane(tabId, "local");
      }
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [tabId]);
  return session?.local;
}
