import type { SftpTabInfo } from "../../types";
import type { PanelPlacement, PanelWindowEnvelope } from "./types";
import { useAppStore } from "../../stores/appStore";
import { useSftpStore } from "../../stores/sftpStore";
import { useShellLayoutStore } from "../../stores/shellLayoutStore";
import { clearDetachedHandoff, consumeDetachedHandoff, subscribePanelWindow, writeDetachedHandoff } from "../detachedSession";
import { openDetachedWindow } from "../detachWindowing";
import { detachedWindowLabel, matchesPanelWindow, signalPanelWindow, waitPanelWindow } from "./panelWindowTransaction";
import { visibleShellNode, waitShellReady } from "./readiness";

export interface SftpWindowPayload extends SftpTabInfo {
  parentSessionId: string; title: string; envelope: PanelWindowEnvelope; localPath?: string;
}
interface WindowRecord { envelope: PanelWindowEnvelope; source: PanelPlacement; params: SftpTabInfo; title: string }
const windows = new Map<string, WindowRecord>(), pending = new Map<string, Promise<void>>();
const completed = new Map<string, PanelWindowEnvelope>();
export function focusSftpPanelWindow(panelId: string) { const record = windows.get(panelId); if (record) signalPanelWindow(record.envelope, "request-focus"); }
export function detachSftpPanel(panelId: string, params: SftpTabInfo, title: string): Promise<void> {
  if (windows.has(panelId)) { focusSftpPanelWindow(panelId); return Promise.resolve(); }
  const running = pending.get(panelId); if (running) return running;
  const shell = useShellLayoutStore.getState(), panel = shell.panels[panelId];
  if (!panel) return Promise.reject(new Error("The SFTP panel is unavailable"));
  const id = `${params.sessionId}__detached`, controller = new AbortController();
  const envelope: PanelWindowEnvelope = { version: 1, panelId, generation: panel.generation, operationId: crypto.randomUUID(), windowLabel: detachedWindowLabel("sftp", id), event: "ready" };
  shell.patchPanel(panelId, { operation: { id: envelope.operationId, type: "detach" }, error: null });
  const off = useShellLayoutStore.subscribe((s) => { if (s.panels[panelId]?.generation !== panel.generation) controller.abort(); });
  const task = (async () => {
    try {
      const sourceView = useSftpStore.getState().sessions[params.sessionId];
      const ready = waitPanelWindow(envelope, "ready", controller.signal); void ready.catch(() => undefined);
      writeDetachedHandoff<SftpWindowPayload>("sftp", id, { ...params, sessionId: id, parentSessionId: params.sessionId, title, envelope, initialPath: sourceView?.remote.path ?? params.initialPath, localPath: sourceView?.local.path });
      if (!consumeDetachedHandoff("sftp", id)) throw new Error("Could not write the SFTP handoff");
      await openDetachedWindow({ kind: "sftp", sessionId: id, title });
      await ready;
      if (controller.signal.aborted) throw new Error("The owner changed while preparing the window");
      windows.set(panelId, { envelope, source: panel.placement, params, title });
      shell.patchPanel(panelId, { placement: { kind: "detached", windowLabel: envelope.windowLabel }, operation: null });
      signalPanelWindow(envelope, "commit");
    } catch (error) {
      controller.abort(); signalPanelWindow(envelope, "cancel"); clearDetachedHandoff("sftp", id);
      useShellLayoutStore.getState().patchPanel(panelId, { operation: null, error: { code: "detach", message: String(error), retryable: true } }, panel.generation);
      throw error;
    } finally { off(); pending.delete(panelId); }
  })();
  pending.set(panelId, task); return task;
}
export function reattachSftpPanel(panelId: string) { const record = windows.get(panelId); if (record) signalPanelWindow(record.envelope, "request-reattach"); }
export function installSftpPanelWindowReceiver() {
  const operations = new Map<string, Promise<void>>();
  return subscribePanelWindow((message) => {
    const acknowledged = completed.get(message.envelope.operationId);
    if (acknowledged && message.envelope.event === "request-reattach" && matchesPanelWindow(acknowledged, message.envelope)) { signalPanelWindow(acknowledged, "reattached"); return; }
    const record = windows.get(message.envelope.panelId);
    if (!record || !matchesPanelWindow(record.envelope, message.envelope) || message.envelope.event !== "request-reattach" || operations.has(record.envelope.operationId)) return;
    let createdTab: string | null = null;
    const previousActive = useAppStore.getState().activeTabId;
    const run = (async () => {
      const shell = useShellLayoutStore.getState(), panel = shell.panels[record.envelope.panelId];
      if (!panel || panel.generation !== record.envelope.generation) throw new Error("The original panel is unavailable");
      const state = message.data as { localPath?: string; remotePath?: string } | undefined;
      if (state?.localPath) await useSftpStore.getState().navigate(record.params.sessionId, "local", state.localPath);
      if (state?.remotePath) await useSftpStore.getState().navigate(record.params.sessionId, "remote", state.remotePath);
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
}
export async function returnSftpWindowsBeforeExit() {
  for (const record of [...windows.values()]) {
    signalPanelWindow(record.envelope, "request-reattach");
    await waitShellReady(() => !windows.has(record.envelope.panelId));
  }
}
