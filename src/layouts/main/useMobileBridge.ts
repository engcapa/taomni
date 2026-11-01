import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getSession, type SessionConfig } from "../../lib/ipc";
import { useAppStore } from "../../stores/appStore";
import { useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";
import type { LocalLaunchOutcome } from "../../types";
import type { ConnectQueueOutcome } from "./types";

/** Backend event `mobile-open-session` (src-tauri/src/mobile/session_open.rs). */
interface MobileOpenRequest {
  request_id: string;
  kind: "local" | "saved";
  saved_session_id: string | null;
}

// One deadline for dispatch + authentication + readiness, below the server's 180 s.
const OPEN_TIMEOUT_MS = 170_000;

export interface MobileBridgeContext {
  openQueuedSession: (session: SessionConfig) => ConnectQueueOutcome;
  openLocalTab: () => Promise<LocalLaunchOutcome>;
  /** Do not replace an authentication dialog belonging to a desktop operation. */
  authenticationBusy?: () => boolean;
}

/** Waits for store state, with a bounded lifetime even if the main shell unmounts. */
export function waitForAppState<T>(pick: () => T | null | undefined, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    let timer: number | undefined;
    const clean = () => { unsubscribe(); window.clearTimeout(timer); signal?.removeEventListener("abort", cancel); };
    const cancel = () => { clean(); reject(new Error("open_cancelled")); };
    if (signal?.aborted) { cancel(); return; }
    const check = () => {
      try {
        const value = pick();
        if (value != null) { clean(); resolve(value); }
      } catch (error) { clean(); reject(error); }
    };
    timer = window.setTimeout(() => { clean(); reject(new Error("open_timeout")); }, Math.max(0, timeoutMs));
    signal?.addEventListener("abort", cancel, { once: true });
    unsubscribe = useAppStore.subscribe(check);
    check();
  });
}

/** A launch promise can await a desktop dialog; abandon our waiter on timeout/unmount. */
function within<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(new Error("open_cancelled"));
    if (signal.aborted) { cancel(); return; }
    signal.addEventListener("abort", cancel, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
}

function backendKey(tabId: string) {
  const state = useAppStore.getState();
  if (!state.tabs.some(tab => tab.id === tabId)) throw new Error("open_cancelled");
  const runtime = state.terminalRuntimeByTab[tabId];
  if (runtime?.state === "disconnected") throw new Error("open_failed");
  return runtime?.backendSessionId;
}

/** Desktop-owned session opening and readable terminal names for paired phones. */
export function useMobileBridge(context: MobileBridgeContext) {
  const contextRef = useRef(context);
  contextRef.current = context;

  useEffect(() => {
    if (getCurrentWindow().label !== "main") return;
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    let queue = Promise.resolve();
    const pending = new Set<AbortController>();
    const report = (requestId: string, terminalId: string | null, error: string | null) =>
      invoke("mobile_open_session_result", { requestId, terminalId, error }).catch(() => {});
    const handle = async (request: MobileOpenRequest, abort: AbortController, deadline: number) => {
      const remaining = () => Math.max(0, deadline - Date.now());
      let session: SessionConfig | undefined;
      if (request.kind === "saved") {
        session = await within(getSession(request.saved_session_id ?? "").catch(() => { throw new Error("saved_session_not_found"); }), abort.signal);
      }
      // Serialize mobile opens and respect the normal desktop auth owner. The
      // refs are not store state, so only this pre-dispatch check needs polling.
      while (contextRef.current.authenticationBusy?.()) {
        await within(new Promise(resolve => window.setTimeout(resolve, Math.min(200, remaining()))), abort.signal);
      }
      if (disposed || abort.signal.aborted) return;
      // The server rechecks opt-in, request age and device revocation here, and
      // makes the claim single-use even if a WebView receives an event twice.
      const accepted = await invoke<boolean>("mobile_claim_open_session", { requestId: request.request_id });
      if (!accepted || disposed || abort.signal.aborted) return;
      let tabId: string;
      if (!session) {
        const outcome = await within(contextRef.current.openLocalTab(), abort.signal);
        if (outcome.status !== "started" || !outcome.tabId) throw new Error(outcome.status === "cancelled" ? "open_cancelled" : "open_failed");
        tabId = outcome.tabId;
      } else {
        const savedId = session.id;
        const before = new Set(useAppStore.getState().tabs.map(tab => tab.id));
        contextRef.current.openQueuedSession(session);
        tabId = await waitForAppState(
          () => useAppStore.getState().tabs.find(tab => !before.has(tab.id) && tab.sessionId === savedId)?.id,
          remaining(), abort.signal,
        );
      }
      const key = await waitForAppState(() => backendKey(tabId), remaining(), abort.signal);
      if (!disposed) await report(request.request_id, key, null);
    };
    void listen<MobileOpenRequest>("mobile-open-session", event => {
      const request = event.payload;
      if (disposed || !request?.request_id || !["local", "saved"].includes(request.kind)) return;
      const abort = new AbortController();
      const deadline = Date.now() + OPEN_TIMEOUT_MS;
      const timer = window.setTimeout(() => abort.abort(), OPEN_TIMEOUT_MS);
      pending.add(abort);
      queue = queue.then(() => handle(request, abort, deadline)).catch((error: unknown) => {
        const code = abort.signal.aborted && !disposed ? "open_timeout" : error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "open_failed";
        if (!disposed) return report(request.request_id, null, code).then(() => {});
      }).finally(() => { window.clearTimeout(timer); pending.delete(abort); });
    }).then(fn => { if (disposed) fn(); else unlisten = fn; }).catch(() => {});
    return () => { disposed = true; unlisten?.(); for (const abort of pending) abort.abort(); };
  }, []);

  useEffect(() => {
    const sent = new Map<string, string>();
    const sync = () => {
      const { tabs, terminalRuntimeByTab } = useAppStore.getState();
      const titles = new Map<string, string>(tabs.map(tab => [tab.id, tab.title]));
      for (const workspace of useWorkspacePlatformStore.getState().workspaces) {
        for (const tab of workspace.openTabs) titles.set(tab.id, `${workspace.name} · ${tab.title}`);
      }
      const liveKeys = new Set<string>();
      for (const [tabId, runtime] of Object.entries(terminalRuntimeByTab)) {
        const key = runtime?.backendSessionId;
        const title = titles.get(tabId);
        if (!key || !title) continue;
        liveKeys.add(key);
        if (sent.get(key) === title) continue;
        sent.set(key, title);
        invoke("mobile_terminal_title", { sessionId: key, title }).catch(() => { if (sent.get(key) === title) sent.delete(key); });
      }
      for (const key of sent.keys()) if (!liveKeys.has(key)) sent.delete(key);
    };
    sync();
    const offApp = useAppStore.subscribe(sync);
    const offWorkspace = useWorkspacePlatformStore.subscribe(sync);
    return () => { offApp(); offWorkspace(); };
  }, []);
}
