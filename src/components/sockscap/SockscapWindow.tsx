import { useEffect, useState } from "react";
import { useSockscapStore } from "../../stores/sockscapStore";
import type { EngineStateName } from "../../lib/sockscap";
import { isTauriRuntime } from "../../lib/runtime";
import { SockscapDashboard } from "./SockscapDashboard";
import { SockscapProfiles } from "./SockscapProfiles";
import { SockscapRules } from "./SockscapRules";

type Tab = "dashboard" | "profiles" | "rules";

const STATE_LABEL: Record<EngineStateName, string> = {
  disabled: "Disabled",
  preparing: "Preparing…",
  active: "Active",
  degraded: "Degraded",
  stopping: "Stopping…",
  "recovery-required": "Recovery required",
};

const STATE_DOT: Record<EngineStateName, string> = {
  disabled: "bg-gray-400",
  preparing: "bg-blue-400 animate-pulse",
  active: "bg-green-500",
  degraded: "bg-yellow-400",
  stopping: "bg-blue-400 animate-pulse",
  "recovery-required": "bg-red-500",
};

/**
 * The standalone Sockscap window (plan §11): a master status bar with
 * start/stop/recover, a capability banner, and Dashboard / Profiles / Rules
 * tabs. Closing the window only hides it; the engine keeps running.
 */
export function SockscapWindow() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const status = useSockscapStore((s) => s.status);
  const capabilities = useSockscapStore((s) => s.capabilities);
  const busy = useSockscapStore((s) => s.busy);
  const error = useSockscapStore((s) => s.error);
  const refreshAll = useSockscapStore((s) => s.refreshAll);
  const start = useSockscapStore((s) => s.start);
  const stop = useSockscapStore((s) => s.stop);
  const recover = useSockscapStore((s) => s.recover);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  // Plan §9 / §16.6-21: closing the Sockscap window only hides it; the engine
  // keeps running until Stop or tray Quit. Without this, X would destroy the
  // webview and lose UI state while capture might still be active.
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        const fn = await win.onCloseRequested(async (event) => {
          event.preventDefault();
          await win.hide();
        });
        if (disposed) fn();
        else unlisten = fn;
      } catch (err) {
        console.warn("sockscap: close-to-hide hook unavailable", err);
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const stateName: EngineStateName = status?.state ?? "disabled";
  const active = stateName === "active" || stateName === "degraded";

  return (
    <div className="flex h-screen flex-col bg-neutral-950 text-neutral-100">
      <header className="flex items-center gap-4 border-b border-neutral-800 px-5 py-3">
        <div className="flex items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full ${STATE_DOT[stateName]}`} />
          <span className="font-semibold">Sockscap</span>
          <span className="text-sm text-neutral-400">{STATE_LABEL[stateName]}</span>
          {status?.detail ? (
            <span className="text-xs text-neutral-500">— {status.detail}</span>
          ) : null}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {!active ? (
            <button
              disabled={busy}
              onClick={() => void start()}
              className="rounded bg-green-600 px-3 py-1.5 text-sm font-medium hover:bg-green-500 disabled:opacity-50"
            >
              Start
            </button>
          ) : (
            <button
              disabled={busy}
              onClick={() => void stop()}
              className="rounded bg-neutral-700 px-3 py-1.5 text-sm font-medium hover:bg-neutral-600 disabled:opacity-50"
            >
              Stop
            </button>
          )}
          <button
            disabled={busy}
            onClick={() => void recover()}
            className="rounded border border-red-500/60 px-3 py-1.5 text-sm text-red-300 hover:bg-red-500/10 disabled:opacity-50"
            title="Restore direct networking regardless of upstream availability"
          >
            Restore network
          </button>
        </div>
      </header>

      {error ? (
        <div className="border-b border-red-900/50 bg-red-950/50 px-5 py-2 text-sm text-red-300">
          {error}
        </div>
      ) : null}

      {capabilities ? (
        <div className="border-b border-neutral-800 bg-neutral-900/60 px-5 py-1.5 text-xs text-neutral-400">
          <span className="text-neutral-300">{capabilities.platform}</span>
          {" · "}
          global: {capabilities.globalCapture} · app: {capabilities.appCapture} · pid:{" "}
          {capabilities.pidCapture}
          {capabilities.notes.length > 0 ? ` · ${capabilities.notes[0]}` : ""}
        </div>
      ) : null}

      <nav className="flex gap-1 border-b border-neutral-800 px-3">
        {(["dashboard", "profiles", "rules"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm capitalize ${
              tab === t
                ? "border-b-2 border-blue-500 text-neutral-100"
                : "text-neutral-400 hover:text-neutral-200"
            }`}
          >
            {t}
          </button>
        ))}
      </nav>

      <main className="flex-1 overflow-auto p-5">
        {tab === "dashboard" ? <SockscapDashboard /> : null}
        {tab === "profiles" ? <SockscapProfiles /> : null}
        {tab === "rules" ? <SockscapRules /> : null}
      </main>
    </div>
  );
}
