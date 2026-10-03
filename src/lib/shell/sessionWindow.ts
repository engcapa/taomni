import { useAppStore } from "../../stores/appStore";
import { useRdpStore } from "../../stores/rdpStore";
import { useVncStore } from "../../stores/vncStore";
import { getQueryTab } from "../queryRegistry";
import { clearDetachedHandoff, consumeDetachedHandoff, writeDetachedHandoff, subscribePanelWindow, detachedWindowUrl, type DetachedKind } from "../detachedSession";
import { openDetachedWindow } from "../detachWindowing";
import { isTauriRuntime } from "../runtime";
import { clearTerminalDetachPending, markTerminalDetachPending } from "../terminal/terminalRegistry";
import { prepareTabMove } from "./closeCoordinator";
import { detachedWindowLabel, matchesPanelWindow, signalPanelWindow, waitPanelWindow } from "./panelWindowTransaction";
import { waitShellReady } from "./readiness";
import type { PanelWindowEnvelope } from "./types";

export interface SessionWindowMetadata { envelope?: PanelWindowEnvelope }
const windows = new Map<string, { envelope: PanelWindowEnvelope; kind: DetachedKind; id: string }>();
const pending = new Map<string, Promise<void>>();
export function sessionTabReady(kind: DetachedKind, id: string): boolean {
  if (kind === "terminal") return !!useAppStore.getState().terminalRuntimeByTab[id]?.backendSessionId;
  if (kind === "vnc") return useVncStore.getState().connections[id]?.status === "connected";
  if (kind === "rdp") return useRdpStore.getState().connections[id]?.status === "connected";
  if (kind === "database") return getQueryTab(id)?.ready?.() === true;
  return false;
}
export function openSessionWindow<T>(kind: DetachedKind, tabId: string, id: string, payload: T, title: string): Promise<void> {
  const existing = windows.get(tabId);
  if (existing) { signalPanelWindow(existing.envelope, "request-focus"); return Promise.resolve(); }
  const running = pending.get(tabId); if (running) return running;
  const envelope: PanelWindowEnvelope = { version: 1, panelId: `tab:${tabId}:${kind}`, operationId: crypto.randomUUID(), generation: 1, windowLabel: detachedWindowLabel(kind, id), event: "ready" };
  const controller = new AbortController();
  const task = (async () => {
    const off = useAppStore.subscribe((s) => { if (!s.tabs.some((tab) => tab.id === tabId)) controller.abort(); });
    try {
      const plan = await prepareTabMove(tabId); if (plan.status !== "closed") throw new Error("Window move cancelled. The source view is preserved.");
      if (controller.signal.aborted) throw new Error("The source view was closed");
      const ready = waitPanelWindow(envelope, "ready", controller.signal); void ready.catch(() => undefined);
      writeDetachedHandoff(kind, id, { ...payload, envelope });
      if (!consumeDetachedHandoff(kind, id)) throw new Error("Could not write the window handoff");
      if (isTauriRuntime()) await openDetachedWindow({ kind, sessionId: id, title });
      else if (!window.open(detachedWindowUrl(kind, id), `taomni_${kind}_${id}`, "width=1280,height=800,resizable=yes")) throw new Error("Window popup blocked");
      await ready;
      windows.set(tabId, { envelope, kind, id });
      off();
      useAppStore.getState().commitRemoveTab(tabId);
      signalPanelWindow(envelope, "commit");
      clearDetachedHandoff(kind, id);
    } catch (error) {
      controller.abort(); signalPanelWindow(envelope, "cancel"); clearDetachedHandoff(kind, id);
      if (kind === "terminal") clearTerminalDetachPending(tabId);
      throw error;
    } finally { off(); pending.delete(tabId); }
  })();
  pending.set(tabId, task); return task;
}
export function installSessionWindowReceiver(reattach: (kind: DetachedKind, id: string, payload: unknown) => Promise<void>) {
  const returning = new Set<string>();
  const completed = new Map<string, PanelWindowEnvelope>();
  return subscribePanelWindow((message) => {
    const acknowledged = completed.get(message.envelope.operationId);
    if (acknowledged && message.envelope.event === "request-reattach" && matchesPanelWindow(acknowledged, message.envelope)) {
      signalPanelWindow(acknowledged, "reattached"); return;
    }
    const record = [...windows.entries()].find(([, item]) => matchesPanelWindow(item.envelope, message.envelope));
    if (!record || message.envelope.event !== "request-reattach" || returning.has(message.envelope.operationId)) return;
    const [tabId, info] = record; returning.add(info.envelope.operationId);
    const existed = useAppStore.getState().tabs.some((tab) => tab.id === tabId);
    const previousActive = useAppStore.getState().activeTabId;
    void reattach(info.kind, info.id, message.data).then(async () => {
      await waitShellReady(() => sessionTabReady(info.kind, tabId));
      windows.delete(tabId); completed.set(info.envelope.operationId, info.envelope);
      if (completed.size > 100) completed.delete(completed.keys().next().value!);
      signalPanelWindow(info.envelope, "reattached");
    }).catch((error) => {
      if (!existed) {
        if (info.kind === "terminal") markTerminalDetachPending(tabId);
        useAppStore.getState().commitRemoveTab(tabId);
        if (previousActive) useAppStore.getState().setActiveTab(previousActive);
      }
      signalPanelWindow({ ...info.envelope, errorCode: String(error) }, "failed");
    })
      .finally(() => returning.delete(info.envelope.operationId));
  });
}
export async function returnSessionWindowsBeforeExit() {
  for (const [tabId, info] of [...windows]) {
    signalPanelWindow(info.envelope, "request-reattach");
    await waitShellReady(() => !windows.has(tabId));
  }
}
