// DetachedSessionWindow — universal route renderer for any session kind
// (rdp/vnc/terminal) opened in its own OS window via the Tauri
// `open_detached_window` command. SFTP retains its dedicated route
// (`SftpDetachedWindow`) for backward compatibility.
//
// Lifecycle:
//   1. The main window writes a credential blob to localStorage and asks
//      Tauri to open `index.html#<kind>=<id>`.
//   2. `App.tsx` detects the route via `detectDetachedRoute()` and mounts
//      this component, which consumes the handoff and renders the
//      relevant panel full-window.
//   3. The panel's own floating toolbar offers `Reattach` and an
//      OS-fullscreen toggle (`setFullscreen`).
//   4. Closing via the OS X button is treated as Reattach: we hook
//      `onCloseRequested`, broadcast the reattach payload synchronously,
//      and then let the close proceed.

import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import {
  type DetachedKind,
  consumeDetachedHandoff,
  clearDetachedHandoff,
  broadcastReattach,
  HANDOFF_TTL_MS,
} from "../../lib/detachedSession";
import { closeCurrentDetachedWindow } from "../../lib/detachWindowing";
import type { RdpOptions } from "../../types/rdp";
import type { TerminalProfile } from "../../lib/terminalProfile";
import type { SshConnectInfo } from "../terminal/TerminalPanel";
import type { LocalShellSelection } from "../../types";
import { useT, t as tr } from "../../lib/i18n";
import { useAppTheme } from "../../lib/appTheme";
import { isTauriRuntime } from "../../lib/runtime";
import {
  TerminalPanel,
  type TerminalReattachState,
} from "../terminal/TerminalPanel";
import { useAppStore } from "../../stores/appStore";

const RdpPanel = lazy(() => import("../rdp/RdpPanel"));
const VncPanel = lazy(() => import("../vnc/VncPanel"));

/* ── Handoff payload shapes ──────────────────────────────────────────── */

export interface DetachedRdpParams {
  sessionId: string;
  host: string;
  port: number;
  username?: string | null;
  password?: string;
  options: RdpOptions;
  networkSettingsJson?: string | null;
  title?: string;
}

export interface DetachedVncParams {
  sessionId: string;
  host: string;
  port: number;
  username?: string | null;
  password?: string;
  title?: string;
}

export interface DetachedTerminalParams {
  title?: string;
  ssh?: SshConnectInfo | null;
  localShell?: LocalShellSelection | null;
  terminalProfile?: TerminalProfile | null;
  reattach?: TerminalReattachState;
}

/* ── Component ───────────────────────────────────────────────────────── */

interface DetachedSessionWindowProps {
  kind: Exclude<DetachedKind, "sftp">;
  id: string;
}

export default function DetachedSessionWindow({
  kind,
  id,
}: DetachedSessionWindowProps) {
  const t = useT();
  const { mode, resolvedTheme } = useAppTheme();
  const uiFontFamily = useAppStore((s) => s.uiFontFamily);
  const uiFontSize = useAppStore((s) => s.uiFontSize);
  const tauri = isTauriRuntime();

  // The handoff payload races the page load. We poll briefly until it
  // shows up so the window never appears blank.
  const [params, setParams] = useState<unknown | null>(() =>
    consumeDetachedHandoff<unknown>(kind, id),
  );
  const [handoffTimedOut, setHandoffTimedOut] = useState(false);

  useEffect(() => {
    if (params) return;
    const tick = () => {
      const next = consumeDetachedHandoff<unknown>(kind, id);
      if (next) setParams(next);
    };
    const interval = window.setInterval(tick, 250);
    const timeout = window.setTimeout(() => setHandoffTimedOut(true), 5_000);
    const onStorage = (event: StorageEvent) => {
      if (event.key && event.newValue) tick();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(timeout);
      window.removeEventListener("storage", onStorage);
    };
  }, [kind, id, params]);

  // Theme + font side-effects (mirrors App.tsx so the detached window
  // looks consistent with the main app).
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.appTheme = resolvedTheme;
    root.dataset.appThemeMode = mode;
    root.style.colorScheme = resolvedTheme;
  }, [mode, resolvedTheme]);
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--moba-ui-font-family", uiFontFamily);
    root.style.setProperty("--moba-ui-font-size", `${uiFontSize}px`);
  }, [uiFontFamily, uiFontSize]);

  const title = useMemo(() => {
    const titled = (params as { title?: string } | null)?.title;
    if (titled) return titled;
    return tr(`rdp.status.connecting`);
  }, [params]);
  useEffect(() => {
    document.title = title;
  }, [title]);

  // OS fullscreen toggle. Backed by the Tauri WebviewWindow API on
  // native, falls back to the document.fullscreen API in browser dev
  // mode so the dev experience matches.
  const [osFullscreen, setOsFullscreen] = useState(false);
  const toggleOsFullscreen = useCallback(async () => {
    if (tauri) {
      try {
        const w = getCurrentWindow();
        const next = !(await w.isFullscreen());
        await w.setFullscreen(next);
        setOsFullscreen(next);
      } catch {
        /* noop */
      }
      return;
    }
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        setOsFullscreen(false);
      } else {
        await document.documentElement.requestFullscreen();
        setOsFullscreen(true);
      }
    } catch {
      /* noop */
    }
  }, [tauri]);

  // Reattach: write the same handoff payload back through
  // `broadcastReattach`, clear local handoffs, then close the window.
  // The main window's `subscribeReattach` recreates/adopts the tab.
  const reattachingRef = useRef(false);
  const terminalReattachStateRef = useRef<TerminalReattachState>({});
  const mergeTerminalReattachState = useCallback((state?: TerminalReattachState) => {
    if (kind !== "terminal") return params;
    const merged = {
      ...terminalReattachStateRef.current,
      ...(state ?? {}),
    };
    terminalReattachStateRef.current = merged;
    return {
      ...(params as DetachedTerminalParams),
      reattach: merged,
    } satisfies DetachedTerminalParams;
  }, [kind, params]);
  const requestReattach = useCallback(async (state?: TerminalReattachState) => {
    if (reattachingRef.current) return;
    if (!params) return;
    reattachingRef.current = true;
    broadcastReattach(kind, id, mergeTerminalReattachState(state));
    clearDetachedHandoff(kind, id);
    try {
      if (tauri) {
        await closeCurrentDetachedWindow();
      } else {
        window.close();
      }
    } catch {
      try {
        if (tauri) {
          const current = getCurrentWindow();
          await current.hide().catch(() => undefined);
          await current.destroy();
        }
      } catch {
        /* noop */
      }
    }
  }, [kind, id, mergeTerminalReattachState, params, tauri]);

  // Treat OS-close as Reattach. The Tauri close-requested hook fires
  // before the window is actually destroyed, which lets us
  // synchronously broadcast the reattach payload. The localStorage
  // backstop in `broadcastReattach` covers the race where the channel
  // post hasn't been delivered yet.
  useEffect(() => {
    if (!tauri) {
      const handler = () => {
        if (params && !reattachingRef.current) {
          broadcastReattach(kind, id, mergeTerminalReattachState());
        }
        clearDetachedHandoff(kind, id);
      };
      window.addEventListener("beforeunload", handler);
      window.addEventListener("pagehide", handler);
      return () => {
        window.removeEventListener("beforeunload", handler);
        window.removeEventListener("pagehide", handler);
      };
    }
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested(() => {
        if (params && !reattachingRef.current) {
          broadcastReattach(kind, id, mergeTerminalReattachState());
        }
        clearDetachedHandoff(kind, id);
        // We do NOT prevent the close — the user asked to close, and
        // the reattach broadcast has already been published.
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => unlisten?.();
  }, [kind, id, mergeTerminalReattachState, params, tauri]);

  // Wipe the handoff if the page is unloaded for any other reason
  // (page navigation, reload, app shutdown). Defence-in-depth — the
  // close-requested hook above is the primary path.
  useEffect(() => {
    const onUnload = () => {
      clearDetachedHandoff(kind, id);
    };
    window.addEventListener("beforeunload", onUnload);
    window.addEventListener("pagehide", onUnload);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      window.removeEventListener("pagehide", onUnload);
    };
  }, [kind, id]);

  if (!params) {
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
                {t("fileBrowser.detachedTimedOutBody", { sessionId: id })}
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

  const detachedWindowControls = {
    onReattach: requestReattach,
    onToggleOsFullscreen: toggleOsFullscreen,
    osFullscreen,
  };
  const inner = renderInner(
    kind,
    id,
    params,
    detachedWindowControls,
    (state) => {
      terminalReattachStateRef.current = {
        ...terminalReattachStateRef.current,
        ...state,
      };
    },
  );

  return (
    <div
      data-testid="detached-session-window"
      data-detached-kind={kind}
      data-detached-id={id}
      className="w-screen h-screen relative"
      style={{ background: "#000", color: "var(--moba-text)" }}
    >
      {inner}
    </div>
  );
}

function renderInner(
  kind: Exclude<DetachedKind, "sftp">,
  id: string,
  params: unknown,
  detachedWindowControls: {
    onReattach: (state?: TerminalReattachState) => void;
    onToggleOsFullscreen: () => void;
    osFullscreen: boolean;
  },
  onTerminalStateChange: (state: TerminalReattachState) => void,
): JSX.Element | null {
  switch (kind) {
    case "rdp": {
      const p = params as DetachedRdpParams;
      return (
        <Suspense fallback={<LoadingScreen label={tr("rdp.loading")} />}>
          <RdpPanel
            tabId={`detached-rdp-${id}`}
            host={p.host}
            port={p.port}
            username={p.username ?? undefined}
            password={p.password}
            options={p.options}
            networkSettingsJson={p.networkSettingsJson ?? null}
            visible
            detachedWindowControls={detachedWindowControls}
          />
        </Suspense>
      );
    }
    case "vnc": {
      const p = params as DetachedVncParams;
      return (
        <Suspense fallback={<LoadingScreen label={tr("vnc.loading")} />}>
          <VncPanel
            tabId={`detached-vnc-${id}`}
            host={p.host}
            port={p.port}
            username={p.username ?? undefined}
            password={p.password}
            visible
            detachedWindowControls={detachedWindowControls}
          />
        </Suspense>
      );
    }
    case "terminal": {
      const p = params as DetachedTerminalParams;
      const adopted = p.reattach?.terminalSessionId
        ? {
            sessionId: p.reattach.terminalSessionId,
            snapshotText: p.reattach.snapshotText,
          }
        : undefined;
      return (
        <TerminalPanel
          tabId={`detached-term-${id}`}
          tabTitle={p.title}
          ssh={p.ssh ?? undefined}
          localShell={p.localShell ?? undefined}
          terminalProfile={p.terminalProfile ?? undefined}
          adoptedTerminal={adopted}
          preserveSessionOnUnmount
          detachedWindowControls={detachedWindowControls}
          onDetachedStateChange={onTerminalStateChange}
          visible
        />
      );
    }
    default:
      return null;
  }
}

function LoadingScreen({ label }: { label: string }) {
  return (
    <div
      className="w-screen h-screen flex items-center justify-center"
      style={{ background: "#000", color: "#aaa" }}
    >
      {label}
    </div>
  );
}

// Re-export TTL so callers expecting the previous symbol still work.
export { HANDOFF_TTL_MS };
