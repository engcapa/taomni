import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileBrowser } from "./FileBrowser";
import { useAppTheme } from "../../lib/appTheme";
import { subscribeCwdHint, getLatestCwdHint } from "../../lib/sftpSync";
import { getAppPlatform, isTauriRuntime } from "../../lib/runtime";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { closeCurrentDetachedWindow } from "../../lib/detachWindowing";
import { useSftpStore } from "../../stores/sftpStore";
import { useTransferStore } from "../../stores/transferStore";
import { activeSftpJobs, waitTransferTerminal } from "../../lib/shell/sftpShellAdapter";
import { sftpCancelTransfer } from "../../lib/sftp";
import { signalPanelWindow, waitPanelWindow, matchesPanelWindow } from "../../lib/shell/panelWindowTransaction";
import type { PanelWindowEnvelope } from "../../lib/shell/types";
import { subscribePanelWindow } from "../../lib/detachedSession";
import { useConfirmDialog } from "../sidebar/ConfirmDialog";
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
  localPath?: string;
  localSelection?: string[];
  remoteSelection?: string[];
  envelope?: PanelWindowEnvelope;
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
  const [windowError, setWindowError] = useState<string | null>(null);
  const [committed, setCommitted] = useState(false);
  const closing = useRef(false), announced = useRef(false), confirm = useConfirmDialog();
  const confirmRef = useRef(confirm.confirm); confirmRef.current = confirm.confirm;
  const connection = useSftpStore((s) => s.sessions[sessionId]);
  useEffect(() => {
    if (!params?.envelope || !committed) return;
    const envelope = params.envelope;
    const publish = () => {
      const view = useSftpStore.getState().sessions[sessionId];
      signalPanelWindow(envelope, "snapshot", { localPath: view?.local.path, remotePath: view?.remote.path, localSelection: view?.local.selection, remoteSelection: view?.remote.selection, jobs: useTransferStore.getState().bySession(sessionId) });
    };
    signalPanelWindow(envelope, "committed");
    publish();
    const offView = useSftpStore.subscribe(publish), offJobs = useTransferStore.subscribe(publish);
    return () => { offView(); offJobs(); };
  }, [params, committed, sessionId]);
  const requestReattach = useCallback(async () => {
    if (!params?.envelope || closing.current) return;
    closing.current = true; setWindowError(null);
    try {
      const jobs = activeSftpJobs(sessionId);
      if (jobs.length) {
        if (!await confirmRef.current({ title: t("shell.reattach"), message: t("shell.transferCloseRisk", { count: jobs.length }), confirmLabel: t("shell.close.cancel-job"), danger: true })) return;
        const signal = new AbortController().signal;
        for (const job of activeSftpJobs(sessionId)) { await sftpCancelTransfer(job.id); await waitTransferTerminal(job.id, signal); }
      }
      const view = useSftpStore.getState().sessions[sessionId];
      const ack = waitPanelWindow(params.envelope, "reattached");
      signalPanelWindow(params.envelope, "request-reattach", { localPath: view?.local.path, remotePath: view?.remote.path, localSelection: view?.local.selection, remoteSelection: view?.remote.selection });
      await ack;
      clearDetachedHandoff(sessionId);
      await useSftpStore.getState().detach(sessionId);
      if (isTauriRuntime()) await closeCurrentDetachedWindow(); else window.close();
    } catch (error) { setWindowError(String(error)); }
    finally { closing.current = false; }
  }, [params, sessionId, t]);
  useEffect(() => {
    if (!params?.envelope) return;
    return subscribePanelWindow((message) => {
      if (!matchesPanelWindow(params.envelope!, message.envelope)) return;
      if (message.envelope.event === "commit") { setCommitted(true); clearDetachedHandoff(sessionId); }
      if (message.envelope.event === "request-reattach") void requestReattach();
      if (message.envelope.event === "request-focus" && isTauriRuntime()) void getCurrentWindow().show().then(() => getCurrentWindow().setFocus());
      if (message.envelope.event === "cancel") { if (isTauriRuntime()) void closeCurrentDetachedWindow(); else window.close(); }
    });
  }, [params, sessionId, requestReattach]);
  useEffect(() => {
    if (!params?.envelope || announced.current || !connection) return;
    if (connection.error) { announced.current = true; signalPanelWindow({ ...params.envelope, errorCode: connection.error }, "failed"); }
    else if (connection.attached && !connection.remote.loading && !connection.local.loading) {
      announced.current = true;
      void (async () => {
        try {
          if (params.localPath) await useSftpStore.getState().navigate(sessionId, "local", params.localPath);
          if (params.initialPath) await useSftpStore.getState().navigate(sessionId, "remote", params.initialPath);
          if (params.localSelection) useSftpStore.getState().setSelection(sessionId, "local", params.localSelection);
          if (params.remoteSelection) useSftpStore.getState().setSelection(sessionId, "remote", params.remoteSelection);
          signalPanelWindow(params.envelope!, "ready");
        } catch (error) { signalPanelWindow({ ...params.envelope!, errorCode: String(error) }, "failed"); }
      })();
    }
  }, [connection, params, sessionId]);
  useEffect(() => {
    if (!isTauriRuntime() || !params?.envelope) return;
    let off: (() => void) | undefined, disposed = false;
    void getCurrentWindow().onCloseRequested((event) => {
      event.preventDefault();
      if (!committed) { void closeCurrentDetachedWindow(); return; }
      // OS close keeps the live channel and its jobs in this window. The parent
      // placeholder can show/focus it again; explicit return resolves jobs first.
      if (activeSftpJobs(sessionId).length) void getCurrentWindow().hide();
      else void requestReattach();
    }).then((fn) => { if (disposed) fn(); else off = fn; });
    return () => { disposed = true; off?.(); };
  }, [params, sessionId, requestReattach, committed]);
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
      data-phase={committed ? "ready" : "initializing"}
      className="w-screen h-screen flex flex-col"
      style={{ background: "var(--taomni-chrome-bg)", color: "var(--taomni-text)" }}
    >
      <div
        className="h-6 px-2 flex items-center text-[11px] font-semibold border-b shrink-0"
        style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}
      >
        <span className="truncate flex-1">{title}</span>
        {params.envelope && <button data-testid="shell-window-reattach" onClick={() => void requestReattach()}>{t("shell.reattach")}</button>}
        {params.envelope && <button data-testid="shell-window-hide" onClick={() => { if (isTauriRuntime()) void getCurrentWindow().hide(); }}>{t("shell.hide")}</button>}
      </div>
      {windowError && <p role="alert" data-testid="shell-window-error">{windowError}</p>}
      {confirm.render}
      <div className="flex-1 min-h-0" inert={!!params.envelope && !committed}>
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
