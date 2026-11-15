import { t as tr } from "./i18n";
import { claimServersTabLock, releaseServersTabLock } from "./servers";
import { useAppStore } from "../stores/appStore";
import { useServersStore } from "../stores/serversStore";

export const SERVERS_TAB_ID = "servers";
const SERVERS_TAB_REALM_MARKER = "taomni.serversTabClaimedInRealm";

let inFlightServersOpen: Promise<boolean> | null = null;

function markServersTabClaimedInRealm(claimed: boolean): void {
  try {
    if (typeof sessionStorage === "undefined") return;
    if (claimed) {
      sessionStorage.setItem(SERVERS_TAB_REALM_MARKER, "1");
    } else {
      sessionStorage.removeItem(SERVERS_TAB_REALM_MARKER);
    }
  } catch {
    /* ignore restricted storage */
  }
}

/**
 * True when the current WebView/browser tab previously claimed the servers
 * lock in this realm (survives same-window navigation like `?servers=main` -> `/`).
 */
export function hasServersTabClaimMarker(): boolean {
  try {
    return typeof sessionStorage !== "undefined" && sessionStorage.getItem(SERVERS_TAB_REALM_MARKER) === "1";
  } catch {
    return false;
  }
}

/**
 * True when the launch URL carries `?servers=...` or `#servers=...` so direct
 * route links (such as QA harnesses or deep links) open the Local servers tab
 * inside the main workspace instead of spawning a separate OS window.
 */
export function hasServersRouteParam(
  search = typeof window !== "undefined" ? window.location.search : "",
  hash = typeof window !== "undefined" ? window.location.hash : "",
): boolean {
  const query = search.startsWith("?") ? search.slice(1) : search;
  if (query && new URLSearchParams(query).get("servers")) {
    return true;
  }
  const hashQuery = hash.startsWith("#") ? hash.slice(1) : hash;
  if (hashQuery.includes("=") && new URLSearchParams(hashQuery).get("servers")) {
    return true;
  }
  return false;
}

function formatServersTabBlockedMessage(holder: string | null): string {
  const trimmed = holder?.trim() ?? "";
  return trimmed
    ? tr("servers.tabAlreadyOpenHolder", { holder: trimmed })
    : tr("servers.tabAlreadyOpenMessage");
}

function blockServersTabOpen(holder: string | null): false {
  const message = formatServersTabBlockedMessage(holder);
  useAppStore.getState().setStatusMessage(message);
  useServersStore.getState().setTabBlockedMessage(message);
  return false;
}

/**
 * Open or focus the single Local servers tab in the main window.
 * Enforces singleton uniqueness both inside the current window and across
 * concurrently running Taomni instances.
 */
export function openServersTab(options?: { title?: string }): Promise<boolean> {
  const existing = useAppStore.getState().tabs.find((tab) => tab.type === "servers");
  if (existing) {
    useAppStore.getState().setActiveTab(existing.id);
    useServersStore.getState().setTabBlockedMessage(null);
    return Promise.resolve(true);
  }
  if (inFlightServersOpen) {
    return inFlightServersOpen;
  }

  inFlightServersOpen = (async () => {
    try {
      const claim = await claimServersTabLock();
      if (!claim.acquired) {
        markServersTabClaimedInRealm(false);
        return blockServersTabOpen(claim.holder);
      }
      markServersTabClaimedInRealm(true);
      const afterClaim = useAppStore.getState().tabs.find((tab) => tab.type === "servers");
      if (afterClaim) {
        useAppStore.getState().setActiveTab(afterClaim.id);
        useServersStore.getState().setTabBlockedMessage(null);
        return true;
      }
      useServersStore.getState().setTabBlockedMessage(null);
      useAppStore.getState().addTab({
        id: SERVERS_TAB_ID,
        type: "servers",
        title: options?.title ?? tr("servers.dialogTitle"),
        closable: true,
      });
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return blockServersTabOpen(detail || null);
    } finally {
      inFlightServersOpen = null;
    }
  })();

  return inFlightServersOpen;
}

/** Release the cross-instance Local servers tab lock, ignoring teardown errors. */
export async function releaseServersTabLockSafe(): Promise<void> {
  markServersTabClaimedInRealm(false);
  try {
    await releaseServersTabLock();
  } catch {
    /* ignore lock release failures during shutdown or mocked unit teardown */
  }
}
