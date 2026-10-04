import { t } from "../i18n";
import { consumeDetachedHandoff, writeDetachedHandoff, clearDetachedHandoff, subscribePanelWindow, type PanelWindowMessage } from "../detachedSession";
import { openDetachedWindow } from "../detachWindowing";
import { useShellLayoutStore } from "../../stores/shellLayoutStore";
import { useAppStore } from "../../stores/appStore";
import { getGitShellController, validateGitShellSnapshot } from "./gitShellState";
import { detachedWindowLabel, matchesPanelWindow, signalPanelWindow, waitPanelWindow } from "./panelWindowTransaction";
import type { PanelPlacement, PanelWindowEnvelope } from "./types";
import type { GitWorkspaceRootInfo } from "../../types";
import type { GitDetachedPayload } from "../../components/detached/GitDetachedWindow";
import { visibleShellNode, waitShellReady } from "./readiness";
import { installPanelWindowLifecycle } from "./panelWindowLifecycle";
import type { GitShellSnapshot } from "./gitShellState";

interface WindowRecord { id: string; envelope: PanelWindowEnvelope; source: PanelPlacement; title: string; snapshot: GitShellSnapshot | null; seq: number }
const windows = new Map<string, WindowRecord>(), pending = new Map<string, Promise<void>>();
const returning = new Map<string, Promise<void>>();
const completed = new Map<string, PanelWindowEnvelope>();
const preparing = new Map<string, { envelope: PanelWindowEnvelope; controller: AbortController; snapshot?: GitShellSnapshot; seq: number }>();
export function focusGitPanelWindow(panelId: string) { const record = windows.get(panelId); if (record) signalPanelWindow(record.envelope, "request-focus"); }
export function detachGitPanel(panelId: string, title: string, roots: GitWorkspaceRootInfo[], activeRepoRoot?: string, singleRepository = false): Promise<void> {
  if (windows.has(panelId)) { focusGitPanelWindow(panelId); return Promise.resolve(); }
  const existing = pending.get(panelId); if (existing) return existing;
  const shell = useShellLayoutStore.getState(), panel = shell.panels[panelId];
  if (!panel || !roots.length) return Promise.reject(new Error("No Git repository is available to detach"));
  const id = panelId, envelope: PanelWindowEnvelope = { version: 1, operationId: crypto.randomUUID(), panelId, generation: panel.generation, windowLabel: detachedWindowLabel("git", id), event: "ready" };
  const source = panel.placement, controller = new AbortController();
  preparing.set(panelId, { envelope, controller, seq: -1 });
  const off = useShellLayoutStore.subscribe((state) => { if (!state.panels[panelId] || state.panels[panelId].generation !== panel.generation) controller.abort(); });
  shell.patchPanel(panelId, { operation: { id: envelope.operationId, type: "detach" }, error: null });
  const run = (async () => {
    try {
      const ready = waitPanelWindow(envelope, "ready", controller.signal);
      // Observe rejection immediately even if the creation command fails first.
      void ready.catch(() => undefined);
      writeDetachedHandoff<GitDetachedPayload>("git", id, { title, roots, activeRepoRoot, singleRepository, envelope, snapshot: getGitShellController(panelId)?.snapshot() ?? null });
      if (!consumeDetachedHandoff("git", id)) throw new Error("Could not write the Git window handoff");
      await openDetachedWindow({ kind: "git", sessionId: id, title, width: 1100, height: 720, operationId: envelope.operationId });
      await ready;
      const current = useShellLayoutStore.getState().panels[panelId];
      if (!current || current.generation !== panel.generation) throw new Error("The panel owner changed");
      const committed = waitPanelWindow(envelope, "committed", controller.signal); void committed.catch(() => undefined);
      signalPanelWindow(envelope, "commit", getGitShellController(panelId)?.snapshot());
      await committed;
      if (controller.signal.aborted) throw new Error("The Git window closed during preparation");
      const prepared = preparing.get(panelId);
      windows.set(panelId, { id, envelope, source, title, snapshot: prepared?.snapshot ?? getGitShellController(panelId)?.snapshot() ?? null, seq: prepared?.seq ?? -1 });
      useShellLayoutStore.getState().patchPanel(panelId, { placement: { kind: "detached", windowLabel: envelope.windowLabel }, operation: null });
    } catch (failure) {
      controller.abort(); clearDetachedHandoff("git", id); signalPanelWindow(envelope, "cancel");
      useShellLayoutStore.getState().patchPanel(panelId, { operation: null, error: { code: "detach", message: String(failure), retryable: true } }, panel.generation);
      throw failure;
    } finally { off(); pending.delete(panelId); preparing.delete(panelId); }
  })();
  pending.set(panelId, run); return run;
}
async function receiveGitPanel(panelId: string, message: PanelWindowMessage) {
  const record = windows.get(panelId); if (!record) throw new Error("The detached window is no longer registered");
  if (!matchesPanelWindow(record.envelope, message.envelope)) return;
  const shell = useShellLayoutStore.getState(), panel = shell.panels[panelId];
  if (!panel || panel.generation !== record.envelope.generation) { signalPanelWindow({ ...record.envelope, errorCode: "The owner is unavailable. Keep this window open and retry." }, "failed"); return; }
  const snapshot = validateGitShellSnapshot(message.data); if (!snapshot) throw new Error("Invalid Git view snapshot");
  // Resolve the owner by identity; a closed owner returns to a surviving promoted view.
  const ownerId = panel.owner.kind !== "background" ? panel.owner.tabId : null;
  const app = useAppStore.getState(), live = ownerId && app.tabs.some((tab) => tab.id === ownerId);
  const destination: PanelPlacement = live ? record.source : { kind: "primary", tabId: `shell-primary:${panelId}` };
  const created = destination.kind === "primary" && !app.tabs.some((tab) => tab.id === destination.tabId);
  const original = getGitShellController(panelId)?.snapshot(), previousActive = app.activeTabId;
  try {
    if (created && destination.kind === "primary") app.addTab({ id: destination.tabId, type: "git", title: record.title, closable: true, shellPanelId: panelId });
    getGitShellController(panelId)?.restore(snapshot);
    shell.patchPanel(panelId, { placement: destination, requestedOpen: true, operation: null });
    if (destination.kind === "primary") app.setActiveTab(destination.tabId); else if (ownerId) app.setActiveTab(ownerId);
    shell.openPanel(panelId);
    await waitShellReady(() => visibleShellNode(`[data-surface-id="${CSS.escape(panelId)}"]`));
    completed.set(record.envelope.operationId, record.envelope);
    if (completed.size > 100) completed.delete(completed.keys().next().value!);
    signalPanelWindow(record.envelope, "reattached"); windows.delete(panelId); clearDetachedHandoff("git", record.id);
  } catch (error) {
    if (original) getGitShellController(panelId)?.restore(original);
    shell.patchPanel(panelId, { placement: panel.placement, operation: null, error: { code: "reattach", message: String(error), retryable: true } }, panel.generation);
    if (created && destination.kind === "primary") useAppStore.getState().commitRemoveTab(destination.tabId);
    if (previousActive) useAppStore.getState().setActiveTab(previousActive);
    throw error;
  }
}
export function reattachGitPanel(panelId: string, message?: PanelWindowMessage): Promise<void> {
  const record = windows.get(panelId);
  if (!record) return Promise.reject(new Error("The detached window is no longer registered"));
  if (!message) { signalPanelWindow(record.envelope, "request-reattach"); return Promise.resolve(); }
  const existing = returning.get(record.envelope.operationId); if (existing) return existing;
  const run = receiveGitPanel(panelId, message).finally(() => returning.delete(record.envelope.operationId));
  returning.set(record.envelope.operationId, run); return run;
}
export function installGitPanelWindowReceiver() {
  const off = subscribePanelWindow((message) => {
    const acknowledged = completed.get(message.envelope.operationId);
    if (acknowledged && message.envelope.event === "request-reattach" && matchesPanelWindow(acknowledged, message.envelope)) { signalPanelWindow(acknowledged, "reattached"); return; }
    const record = windows.get(message.envelope.panelId);
    const prepared = preparing.get(message.envelope.panelId);
    if (prepared && message.envelope.event === "snapshot" && matchesPanelWindow(prepared.envelope, message.envelope)) {
      const snapshot = validateGitShellSnapshot(message.data);
      if (snapshot && message.seq > prepared.seq) { prepared.snapshot = snapshot; prepared.seq = message.seq; }
      return;
    }
    if (!record || !matchesPanelWindow(record.envelope, message.envelope)) return;
    if (message.envelope.event === "snapshot") {
      const snapshot = validateGitShellSnapshot(message.data);
      if (snapshot && message.seq > record.seq) { record.snapshot = snapshot; record.seq = message.seq; }
      return;
    }
    if (message.envelope.event === "request-reattach") void reattachGitPanel(message.envelope.panelId, message).catch((error) => signalPanelWindow({ ...record.envelope, errorCode: String(error) }, "failed"));
  });
  const offDestroyed = installPanelWindowLifecycle((window) => {
    const pendingWindow = [...preparing.values()].find((item) => item.envelope.windowLabel === window.windowLabel && item.envelope.operationId === window.operationId);
    if (pendingWindow) { pendingWindow.controller.abort(); return; }
    const record = [...windows.values()].find((item) => item.envelope.windowLabel === window.windowLabel && item.envelope.operationId === window.operationId);
    if (!record || returning.has(record.envelope.operationId)) return;
    const snapshot = record.snapshot ?? getGitShellController(record.id)?.snapshot();
    if (!snapshot) return;
    const message: PanelWindowMessage = { type: "panel-window", from: "native-window-lifecycle", seq: record.seq + 1, envelope: record.envelope, data: snapshot };
    void reattachGitPanel(record.id, message).then(() => {
      useShellLayoutStore.getState().patchPanel(record.id, { error: { code: "window-recovered", message: t("shell.panelWindowRecovered"), retryable: false } });
    }).catch((error) => {
      windows.delete(record.id);
      useShellLayoutStore.getState().patchPanel(record.id, { placement: record.source, operation: null, requestedOpen: true, error: { code: "window-recovery", message: String(error), retryable: true } });
    });
  }, (error) => useAppStore.getState().setStatusMessage(String(error)));
  return () => { off(); offDestroyed(); };
}
export async function returnGitWindowsBeforeExit() {
  for (const record of [...windows.values()]) {
    signalPanelWindow(record.envelope, "request-reattach");
    await waitShellReady(() => !windows.has(record.envelope.panelId));
  }
}
