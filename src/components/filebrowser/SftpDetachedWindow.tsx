import { useEffect, useMemo, useState } from "react";
import { FileBrowser } from "./FileBrowser";
import { useAppTheme } from "../../lib/appTheme";
import { subscribeCwdHint, getLatestCwdHint } from "../../lib/sftpSync";
import { getAppPlatform } from "../../lib/runtime";
import { useT } from "../../lib/i18n";
import {
  consumeDetachedHandoff as consumeGenericHandoff,
  writeDetachedHandoff as writeGenericHandoff,
  clearDetachedHandoff as clearGenericHandoff,
  detachedWindowUrl as detachedGenericUrl,
  detectDetachedRoute,
  sweepExpiredHandoffs as sweepGenericHandoffs,
} from "../../lib/detachedSession";

interface DetachedSftpParams {
  /**
   * Session id used by the detached window for its OWN SFTP attach. We
   * deliberately make this distinct from the parent window's session id
   * (see `parentSessionId`) so the backend opens a fresh SFTP channel and
   * the popup never contends with the sidebar / standalone tab for the
   * same `Mutex<SftpSession>` lock.
   */
  sessionId: string;
  /**
   * Original session id in the parent window. Used only so the detached
   * window can subscribe to the same OSC 7 cwd-hint broadcasts that the
   * main window publishes for the source tab. The detached window does
   * NOT attach SFTP under this id.
   */
  parentSessionId?: string;
  host: string;
  port: number;
  username: string;
  authMethod: string;
  authData: string | null;
  networkSettingsJson?: string | null;
  initialPath?: string;
  title?: string;
}

// Re-export TTL so callers expecting the previous symbol still work.
export { HANDOFF_TTL_MS } from "../../lib/detachedSession";

const STORAGE_PREFIX = "taomni.sftp.detached.";

/**
 * Read the credential handoff for `sessionId` without deleting it. We
 * previously deleted the entry on first read for defence-in-depth, but
 * that broke React StrictMode double-mount and any browser/Tauri runtime
 * that re-renders the detached window before its `beforeunload` fires:
 * the second read came back `null` and the window stayed blank forever.
 *
 * The TTL check + `clearDetachedHandoff` on `pagehide`/`beforeunload`
 * still bound how long the credentials can sit on disk.
 *
 * We use `localStorage` instead of `sessionStorage` because Tauri's
 * `WebviewWindow` opened for a detached SFTP view runs as a fresh
 * WebContents — its `sessionStorage` is empty even though it shares the
 * origin.
 */
export function consumeDetachedHandoff(sessionId: string): DetachedSftpParams | null {
  return consumeGenericHandoff<DetachedSftpParams>("sftp", sessionId);
}

export function writeDetachedHandoff(params: DetachedSftpParams): void {
  writeGenericHandoff<DetachedSftpParams>("sftp", params.sessionId, params);
}

export function clearDetachedHandoff(sessionId: string): void {
  clearGenericHandoff("sftp", sessionId);
}

/**
 * Sweep any expired handoff entries on app start.
 *
 * If a window-open attempt failed midway (browser blocked the popup, user
 * dismissed an OS prompt, etc.) the credential blob would otherwise stay
 * in `localStorage` forever. This belt-and-braces pass keeps that from
 * happening across restarts.
 */
export function sweepExpiredHandoffs(): void {
  sweepGenericHandoffs();
}

export function detachedWindowUrl(sessionId: string): string {
  return detachedGenericUrl("sftp", sessionId);
}

/**
 * Returns the SFTP session id if the page was opened as a detached SFTP
 * window, or null otherwise.
 *
 * Checks the URL fragment first (`#sftp=...`) — this is what the Tauri
 * backend writes via WebviewUrl::App so the path component never gets
 * percent-encoded. Falls back to the query string (`?sftp=...`) for
 * browser-mode window.open() and older builds.
 */
export function detectDetachedSftpRoute(): string | null {
  const route = detectDetachedRoute();
  return route?.kind === "sftp" ? route.id : null;
}

export function SftpDetachedWindow({ sessionId }: { sessionId: string }) {
  const t = useT();
  const { mode, resolvedTheme } = useAppTheme();
  const [uiFontFamily, setUiFontFamily] = useState(() => {
    try {
      return localStorage.getItem("taomni.uiFontFamily") || "Inter";
    } catch {
      return "Inter";
    }
  });
  const [uiFontSize, setUiFontSize] = useState<number>(() => {
    try {
      const val = localStorage.getItem("taomni.uiFontSize");
      if (val) {
        const parsed = parseInt(val, 10);
        if (!isNaN(parsed) && parsed >= 10 && parsed <= 18) return parsed;
      }
      return 12;
    } catch {
      return 12;
    }
  });

  const [params, setParams] = useState<DetachedSftpParams | null>(() =>
    consumeDetachedHandoff(sessionId),
  );
  // Flip to true after a grace period if no handoff has arrived. Lets us
  // replace the indefinite "waiting…" spinner with an actionable error so
  // the popup never *looks* blank to the user.
  const [handoffTimedOut, setHandoffTimedOut] = useState(false);
  // Latest cwd hint broadcast by the parent window (terminal OSC 7). Lets
  // a detached SFTP view offer last-known terminal cwd sync even though it
  // can't see the terminal directly. We subscribe under the PARENT session id
  // because the main window broadcasts under that id; fall back to the
  // detached id for older builds that didn't carry a parentSessionId.
  const cwdSubscriptionId = params?.parentSessionId ?? sessionId;
  const [cwdHint, setCwdHint] = useState<string | null>(() =>
    getLatestCwdHint(cwdSubscriptionId),
  );

  useEffect(() => {
    const handler = (event: StorageEvent) => {
      if (event.key === "taomni.uiFontFamily" && event.newValue) {
        setUiFontFamily(event.newValue);
      } else if (event.key === "taomni.uiFontSize" && event.newValue) {
        const parsed = parseInt(event.newValue, 10);
        if (!isNaN(parsed) && parsed >= 10 && parsed <= 18) {
          setUiFontSize(parsed);
        }
      }
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.appTheme = resolvedTheme;
    root.dataset.appThemeMode = mode;
    root.style.colorScheme = resolvedTheme;
    root.dataset.appPlatform = getAppPlatform();
  }, [mode, resolvedTheme]);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--taomni-ui-font-family", uiFontFamily);
    root.style.setProperty("--taomni-ui-font-size", `${uiFontSize}px`);
  }, [uiFontFamily, uiFontSize]);

  useEffect(() => {
    if (params) return;
    const handler = (event: StorageEvent) => {
      if (event.key === STORAGE_PREFIX + sessionId && event.newValue) {
        // Re-consume so we delete the entry and apply TTL. Don't trust the
        // raw `event.newValue` directly.
        const next = consumeDetachedHandoff(sessionId);
        if (next) setParams(next);
      }
    };
    window.addEventListener("storage", handler);
    // Poll as a fallback for runtimes where the storage event doesn't fire
    // reliably between webviews (e.g. some Tauri builds).
    const id = window.setInterval(() => {
      const next = consumeDetachedHandoff(sessionId);
      if (next) {
        setParams(next);
        window.clearInterval(id);
      }
    }, 250);
    // Flag a timeout after ~5s so the user sees an actionable message
    // instead of an indefinite "waiting…" line.
    const timeoutId = window.setTimeout(() => setHandoffTimedOut(true), 5_000);
    return () => {
      window.removeEventListener("storage", handler);
      window.clearInterval(id);
      window.clearTimeout(timeoutId);
    };
  }, [sessionId, params]);

  // Subscribe to cwd hint updates from the main window; detached SFTP can
  // use them for explicit Sync, but it no longer auto-follows the terminal.
  useEffect(() => {
    return subscribeCwdHint((sid, cwd) => {
      if (sid === cwdSubscriptionId) setCwdHint(cwd);
    });
  }, [cwdSubscriptionId]);

  // Belt-and-braces: if the window is closed before we ever consumed the
  // handoff (e.g. user cancelled mid-load), wipe it from `localStorage`
  // so the secret doesn't sit on disk waiting for a future read.
  useEffect(() => {
    const onUnload = () => {
      clearDetachedHandoff(sessionId);
    };
    window.addEventListener("beforeunload", onUnload);
    window.addEventListener("pagehide", onUnload);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      window.removeEventListener("pagehide", onUnload);
    };
  }, [sessionId]);

  const title = useMemo(
    () => `${params?.title ?? t("fileBrowser.detachedTitleDefault", { sessionId })}`,
    [params?.title, sessionId, t],
  );

  useEffect(() => {
    document.title = `${title} • ${t("fileBrowser.detachedDocTitleSuffix")}`;
  }, [title, t]);

  if (!params) {
    // Use literal colours here (not CSS vars) so that even if the theme
    // stylesheet hasn't loaded the popup is visibly populated rather than
    // appearing as a blank white page.
    return (
      <div
        className="w-screen h-screen flex items-center justify-center p-6"
        style={{ background: "#1e2128", color: "#e6e6e6" }}
      >
        <div className="max-w-md text-center text-sm leading-relaxed">
          {handoffTimedOut ? (
            <>
              <div className="text-base font-semibold mb-2">
                {t("fileBrowser.detachedTimedOutTitle")}
              </div>
              <p style={{ color: "#a0a0a0" }}>
                {t("fileBrowser.detachedTimedOutBody", { sessionId })}
              </p>
              <p className="mt-3" style={{ color: "#a0a0a0" }}>
                {t("fileBrowser.detachedTimedOutHint")}
              </p>
              <button
                type="button"
                className="mt-4 px-3 py-1.5 text-xs rounded"
                style={{ background: "#3a3f4a", color: "#e6e6e6" }}
                onClick={() => window.close()}
              >
                {t("fileBrowser.detachedCloseWindow")}
              </button>
            </>
          ) : (
            <>
              <div className="text-base font-semibold mb-2">
                {t("fileBrowser.detachedLoadingTitle")}
              </div>
              <p style={{ color: "#a0a0a0" }}>
                {t("fileBrowser.detachedLoadingBody")}
              </p>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="sftp-detached-window"
      className="w-screen h-screen flex flex-col"
      style={{ background: "var(--taomni-chrome-bg)", color: "var(--taomni-text)" }}
    >
      <div
        className="h-6 px-2 flex items-center text-[11px] font-semibold border-b shrink-0"
        style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}
      >
        <span className="truncate">{title}</span>
      </div>
      <div className="flex-1 min-h-0">
        <FileBrowser
          sessionId={params.sessionId}
          host={params.host}
          port={params.port}
          username={params.username}
          authMethod={params.authMethod}
          authData={params.authData}
          networkSettingsJson={params.networkSettingsJson ?? null}
          initialPath={params.initialPath}
          cwdHint={cwdHint}
          detachable={false}
        />
      </div>
    </div>
  );
}
