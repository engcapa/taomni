import type { SftpTabInfo } from "../../types";
import type { PanelPlacement, PanelWindowEnvelope } from "./types";
import { useAppStore } from "../../stores/appStore";
import { useSftpStore } from "../../stores/sftpStore";
import { useShellLayoutStore } from "../../stores/shellLayoutStore";
import { clearDetachedHandoff, consumeDetachedHandoff, subscribePanelWindow, writeDetachedHandoff } from "../detachedSession";
import { openDetachedWindow } from "../detachWindowing";
import { detachedWindowLabel, matchesPanelWindow, signalPanelWindow, waitPanelWindow } from "./panelWindowTransaction";
import { visibleShellNode, waitShellReady } from "./readiness";
import { installPanelWindowLifecycle } from "./panelWindowLifecycle";
import { readSftpWindowSnapshot, receiveWindowTransfers, type SftpWindowSnapshot } from "./sftpWindowState";
import { adoptWindowTransfers, useTransferStore, isTransferActive } from "../../stores/transferStore";
import { sftpCancelTransfer, sftpDetach } from "../sftp";
import { t } from "../i18n";
import { prepareSurfaceClose } from "./closeCoordinator";
import { waitTransferTerminal } from "./sftpShellAdapter";

export interface SftpWindowPayload extends SftpTabInfo {
  parentSessionId: string; title: string; envelope: PanelWindowEnvelope; localPath?: string; localSelection?: string[]; remoteSelection?: string[];
}
interface WindowRecord { envelope: PanelWindowEnvelope; source: PanelPlacement; params: SftpTabInfo; title: string; snapshot: SftpWindowSnapshot; seq: number }
const windows = new Map<string, WindowRecord>(), pending = new Map<string, Promise<void>>();
const completed = new Map<string, PanelWindowEnvelope>();
const preparing = new Map<string, { envelope: PanelWindowEnvelope; controller: AbortController }>();
export function focusSftpPanelWindow(panelId: string) { const record = windows.get(panelId); if (record) signalPanelWindow(record.envelope, "request-focus"); }
export function detachSftpPanel(panelId: string, params: SftpTabInfo, title: string): Promise<void> {
  if (windows.has(panelId)) { focusSftpPanelWindow(panelId); return Promise.resolve(); }
  const running = pending.get(panelId); if (running) return running;
  const shell = useShellLayoutStore.getState(), panel = shell.panels[panelId];
  if (!panel) return Promise.reject(new Error("The SFTP panel is unavailable"));
  const id = `${params.sessionId}__detached`, controller = new AbortController();
  const envelope: PanelWindowEnvelope = { version: 1, panelId, generation: panel.generation, operationId: crypto.randomUUID(), windowLabel: detachedWindowLabel("sftp", id), event: "ready" };
  preparing.set(panelId, { envelope, controller });
  shell.patchPanel(panelId, { operation: { id: envelope.operationId, type: "detach" }, error: null });
  const off = useShellLayoutStore.subscribe((s) => { if (s.panels[panelId]?.generation !== panel.generation) controller.abort(); });
  const task = (async () => {
    try {
      const sourceView = useSftpStore.getState().sessions[params.sessionId];
      const ready = waitPanelWindow(envelope, "ready", controller.signal); void ready.catch(() => undefined);
      writeDetachedHandoff<SftpWindowPayload>("sftp", id, { ...params, sessionId: id, parentSessionId: params.sessionId, title, envelope, initialPath: sourceView?.remote.path ?? params.initialPath, localPath: sourceView?.local.path, localSelection: sourceView?.local.selection, remoteSelection: sourceView?.remote.selection });
      if (!consumeDetachedHandoff("sftp", id)) throw new Error("Could not write the SFTP handoff");
      await openDetachedWindow({ kind: "sftp", sessionId: id, title, operationId: envelope.operationId });
      await ready;
      if (controller.signal.aborted) throw new Error("The owner changed while preparing the window");
      const committed = waitPanelWindow(envelope, "committed", controller.signal); void committed.catch(() => undefined);
      signalPanelWindow(envelope, "commit");
      await committed;
      if (controller.signal.aborted) throw new Error("The SFTP window closed during preparation");
      windows.set(panelId, { envelope, source: panel.placement, params, title, snapshot: { localPath: sourceView?.local.path, remotePath: sourceView?.remote.path, jobs: [] }, seq: -1 });
      shell.patchPanel(panelId, { placement: { kind: "detached", windowLabel: envelope.windowLabel }, operation: null });
    } catch (error) {
      controller.abort(); signalPanelWindow(envelope, "cancel"); clearDetachedHandoff("sftp", id);
      useShellLayoutStore.getState().patchPanel(panelId, { operation: null, error: { code: "detach", message: String(error), retryable: true } }, panel.generation);
      throw error;
    } finally { off(); pending.delete(panelId); preparing.delete(panelId); }
  })();
  pending.set(panelId, task); return task;
}
export function reattachSftpPanel(panelId: string) { const record = windows.get(panelId); if (record) signalPanelWindow(record.envelope, "request-reattach"); }
export function installSftpPanelWindowReceiver() {
  const operations = new Map<string, Promise<void>>();
  const off = subscribePanelWindow((message) => {
    const acknowledged = completed.get(message.envelope.operationId);
    if (acknowledged && message.envelope.event === "request-reattach" && matchesPanelWindow(acknowledged, message.envelope)) { signalPanelWindow(acknowledged, "reattached"); return; }
    const record = windows.get(message.envelope.panelId);
    if (!record || !matchesPanelWindow(record.envelope, message.envelope)) return;
    if (message.envelope.event === "snapshot") {
      const snapshot = readSftpWindowSnapshot(message.data, `${record.params.sessionId}__detached`);
      if (snapshot && message.seq > record.seq) {
        record.snapshot = snapshot; record.seq = message.seq;
        void receiveWindowTransfers(snapshot, record.envelope).catch((error) => useAppStore.getState().setStatusMessage(String(error)));
      }
      return;
    }
    if (message.envelope.event !== "request-reattach" || operations.has(record.envelope.operationId)) return;
    let createdTab: string | null = null;
    const previousActive = useAppStore.getState().activeTabId;
    const run = (async () => {
      const shell = useShellLayoutStore.getState(), panel = shell.panels[record.envelope.panelId];
      if (!panel || panel.generation !== record.envelope.generation) throw new Error("The original panel is unavailable");
      const state = message.data as { localPath?: string; remotePath?: string; localSelection?: string[]; remoteSelection?: string[] } | undefined;
      if (state?.localPath) await useSftpStore.getState().navigate(record.params.sessionId, "local", state.localPath);
      if (state?.remotePath) await useSftpStore.getState().navigate(record.params.sessionId, "remote", state.remotePath);
      if (state?.localSelection) useSftpStore.getState().setSelection(record.params.sessionId, "local", state.localSelection);
      if (state?.remoteSelection) useSftpStore.getState().setSelection(record.params.sessionId, "remote", state.remoteSelection);
      const app = useAppStore.getState(), owner = panel.owner.kind === "background" ? null : panel.owner.tabId;
      const destination: PanelPlacement = owner && app.tabs.some((tab) => tab.id === owner) ? record.source : { kind: "primary", tabId: `shell-primary:${panel.id}` };
      if (destination.kind === "primary" && !app.tabs.some((tab) => tab.id === destination.tabId)) { createdTab = destination.tabId; app.addTab({ id: destination.tabId, type: "sftp", title: record.title, closable: true, shellPanelId: panel.id }); }
      shell.patchPanel(panel.id, { placement: destination, requestedOpen: true, operation: null });
      if (destination.kind === "primary") app.setActiveTab(destination.tabId); else if (owner) app.setActiveTab(owner);
      shell.openPanel(panel.id);
      await waitShellReady(() => visibleShellNode(`[data-surface-id="${CSS.escape(panel.id)}"]`));
      completed.set(record.envelope.operationId, record.envelope);
      if (completed.size > 100) completed.delete(completed.keys().next().value!);
      signalPanelWindow(record.envelope, "reattached"); windows.delete(panel.id);
    })().catch((error) => {
      useShellLayoutStore.getState().patchPanel(record.envelope.panelId, { placement: { kind: "detached", windowLabel: record.envelope.windowLabel }, error: { code: "reattach", message: String(error), retryable: true } });
      if (createdTab) useAppStore.getState().commitRemoveTab(createdTab);
      if (previousActive) useAppStore.getState().setActiveTab(previousActive);
      signalPanelWindow({ ...record.envelope, errorCode: String(error) }, "failed");
    }).finally(() => operations.delete(record.envelope.operationId));
    operations.set(record.envelope.operationId, run);
  });
  const offDestroyed = installPanelWindowLifecycle((window) => {
    const pendingWindow = [...preparing.values()].find((item) => item.envelope.windowLabel === window.windowLabel && item.envelope.operationId === window.operationId);
    if (pendingWindow) { pendingWindow.controller.abort(); return; }
    const record = [...windows.values()].find((item) => item.envelope.windowLabel === window.windowLabel && item.envelope.operationId === window.operationId);
    if (!record || operations.has(record.envelope.operationId)) return;
    let recoveryFailure: unknown;
    const run = (async () => {
      adoptWindowTransfers(record.envelope.windowLabel);
      const childSessionId = `${record.params.sessionId}__detached`;
      if (!useTransferStore.getState().bySession(childSessionId).some((job) => isTransferActive(job.state))) await sftpDetach(childSessionId);
      const view = record.snapshot;
      if (view.localPath) await useSftpStore.getState().navigate(record.params.sessionId, "local", view.localPath);
      if (view.remotePath) await useSftpStore.getState().navigate(record.params.sessionId, "remote", view.remotePath);
      if (view.localSelection) useSftpStore.getState().setSelection(record.params.sessionId, "local", view.localSelection);
      if (view.remoteSelection) useSftpStore.getState().setSelection(record.params.sessionId, "remote", view.remoteSelection);
      const shell = useShellLayoutStore.getState(), panel = shell.panels[record.envelope.panelId], app = useAppStore.getState();
      if (!panel || panel.generation !== record.envelope.generation) return;
      const owner = panel.owner.kind === "background" ? null : panel.owner.tabId;
      const source = record.source;
      const sourceExists = source.kind === "primary" ? app.tabs.some((tab) => tab.id === source.tabId) : !!owner && app.tabs.some((tab) => tab.id === owner);
      const destination: PanelPlacement = sourceExists ? record.source : { kind: "primary", tabId: `shell-primary:${panel.id}` };
      if (destination.kind === "primary") {
        if (!app.tabs.some((tab) => tab.id === destination.tabId)) app.addTab({ id: destination.tabId, type: "sftp", title: record.title, closable: true, shellPanelId: panel.id });
        app.setActiveTab(destination.tabId);
      } else if (owner) app.setActiveTab(owner);
      shell.patchPanel(panel.id, { placement: destination, requestedOpen: true, operation: null });
      shell.openPanel(panel.id);
      await waitShellReady(() => visibleShellNode(`[data-surface-id="${CSS.escape(panel.id)}"]`));
    })().catch((error) => { recoveryFailure = error; useAppStore.getState().setStatusMessage(String(error)); }).finally(() => {
      windows.delete(record.envelope.panelId); operations.delete(record.envelope.operationId);
      const shell = useShellLayoutStore.getState(), panel = shell.panels[record.envelope.panelId];
      if (panel && panel.generation === record.envelope.generation) shell.patchPanel(panel.id, { ...(panel.placement.kind === "detached" ? { placement: record.source } : {}), requestedOpen: true, operation: null, error: recoveryFailure ? { code: "window-recovery", message: String(recoveryFailure), retryable: true } : { code: "window-recovered", message: t("shell.panelWindowRecovered"), retryable: false } });
    });
    operations.set(record.envelope.operationId, run);
  }, (error) => useAppStore.getState().setStatusMessage(String(error)));
  return () => { off(); offDestroyed(); };
}
export async function returnSftpWindowsBeforeExit() {
  for (const record of [...windows.values()]) {
    signalPanelWindow(record.envelope, "request-reattach");
    await waitShellReady(() => !windows.has(record.envelope.panelId));
  }
}
export async function prepareSftpWindowsBeforeExit(): Promise<boolean> {
  const targets = [...windows.values()].map((record) => {
    const channelId = `${record.params.sessionId}__detached`;
    return { id: `window:${record.envelope.windowLabel}`, title: record.title, commit: () => undefined, adapter: {
      getRisks: async () => {
        const jobs = useTransferStore.getState().bySession(channelId).filter((job) => isTransferActive(job.state));
        return jobs.length ? [{ kind: "job" as const, id: `${record.envelope.panelId}:window-jobs`, ownerId: record.envelope.panelId, revision: jobs.map((job) => job.id).sort().join(","), detail: t("shell.transferCloseRisk", { count: jobs.length }), choices: ["cancel-job" as const, "cancel" as const] }] : [];
      },
      resolve: async (_risk: unknown, choice: string, signal: AbortSignal) => {
        if (choice !== "cancel-job") throw new Error("Unsupported window close decision");
        for (const job of useTransferStore.getState().bySession(channelId).filter((job) => isTransferActive(job.state))) { await sftpCancelTransfer(job.id); await waitTransferTerminal(job.id, signal); }
      },
      flush: async () => undefined,
    } };
  }).filter((target) => useTransferStore.getState().items.some((job) => job.viewWindowLabel === target.id.slice(7) && isTransferActive(job.state)));
  if (!targets.length) return true;
  const result = await prepareSurfaceClose(targets, true);
  return result.status === "closed";
}
