import { useEffect, useMemo, useRef, useState } from "react";
import { PanelRightOpen } from "lucide-react";
import { FileBrowser } from "./FileBrowser";
import { subscribeCwdHint, getLatestCwdHint } from "../../lib/sftpSync";
import { isTauriRuntime } from "../../lib/runtime";
import { DetachedHandoffStatus } from "../detached/DetachedHandoffStatus";
import { closeCurrentDetachedWindow } from "../../lib/detachWindowing";
import { sftpWindowPaths, type DetachedSftpParams } from "../../lib/sftpWindowState";
import { useSftpStore } from "../../stores/sftpStore";
import { useT } from "../../lib/i18n";
import {
  consumeDetachedHandoff as consumeGenericHandoff,
  writeDetachedHandoff as writeGenericHandoff,
  clearDetachedHandoff as clearGenericHandoff,
  detachedWindowUrl as detachedGenericUrl,
  detectDetachedRoute,
  sweepExpiredHandoffs as sweepGenericHandoffs,
  broadcastReattach,
} from "../../lib/detachedSession";

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
  const reattachingRef = useRef(false);
  const [reattachError, setReattachError] = useState<string | null>(null);
  const [params, setParams] = useState<DetachedSftpParams | null>(() =>
    consumeDetachedHandoff(sessionId),
  );
  const reattach = async () => {
    if (!params || reattachingRef.current) return;
    reattachingRef.current = true;
    setReattachError(null);
    broadcastReattach("sftp", sessionId, { ...params, ...sftpWindowPaths(sessionId) });
    clearDetachedHandoff(sessionId);
    try {
      await useSftpStore.getState().detach(sessionId);
      if (isTauriRuntime()) await closeCurrentDetachedWindow();
      else window.close();
    } catch (error) {
      reattachingRef.current = false;
      setReattachError(String(error));
    }
  };
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
    return <DetachedHandoffStatus key={sessionId} sessionId={sessionId} failed={handoffTimedOut} />;
  }

  return (
    <div
      data-testid="sftp-detached-window"
      className="w-screen h-screen flex flex-col"
      style={{ background: "var(--taomni-chrome-bg)", color: "var(--taomni-text)" }}
    >
      <div
        className="h-6 px-2 flex items-center text-ui-small font-semibold border-b shrink-0"
        style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}
      >
        <span className="truncate flex-1">{title}</span>
        <button
          type="button"
          data-testid="sftp-reattach"
          className="inline-flex items-center gap-1 rounded px-1.5 hover:bg-[var(--taomni-hover)]"
          title={t(params.attachedToTerminal ? "fileBrowser.restoreSftpPanel" : "rdp.reattach")}
          aria-label={t(params.attachedToTerminal ? "fileBrowser.restoreSftpPanel" : "rdp.reattach")}
          onClick={() => void reattach()}
        >
          <PanelRightOpen size={13} />
          {t(params.attachedToTerminal ? "fileBrowser.restoreSftpPanel" : "rdp.reattach")}
        </button>
      </div>
      {reattachError && <div role="alert" className="px-2 text-xs">{reattachError}</div>}
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
          initialLocalPath={params.initialLocalPath}
          cwdHint={cwdHint}
          detachable={false}
        />
      </div>
    </div>
  );
}
