import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { clearDetachedHandoff, consumeDetachedHandoff, subscribePanelWindow, writeDetachedHandoff, type PanelWindowMessage } from "../detachedSession";
import { openDetachedWindow } from "../detachWindowing";
import { flushNotesEditor, restoreNotesView, snapshotNotesView, validateNotesView, type NotesViewSnapshot } from "../notes/notesViewState";
import { useNotesStore } from "../../stores/notesStore";
import { useTaoHubStore } from "../../stores/taoHubStore";
import { useChatStore } from "../../stores/chatStore";
import { isTauriRuntime } from "../runtime";
import { t } from "../i18n";
import { matchesPanelWindow, signalPanelWindow, waitPanelWindow } from "./panelWindowTransaction";
import { visibleShellNode, waitShellReady } from "./readiness";
import type { PanelWindowEnvelope } from "./types";

export interface NotesWindowPayload { envelope: PanelWindowEnvelope; snapshot: NotesViewSnapshot }
export const useNotesWindowStore = create<{ phase: "docked" | "preparing" | "committing" | "detached" | "returning"; error: string | null; recovery: string | null }>(() => ({ phase: "docked", error: null, recovery: null }));
let generation = 0, record: NotesWindowPayload | undefined, pending: Promise<void> | undefined, returning: Promise<void> | undefined;
let acknowledged: PanelWindowEnvelope | undefined;
let snapshotSeq = -1;
let preparing: { envelope: PanelWindowEnvelope; controller: AbortController; snapshot?: NotesViewSnapshot; seq: number } | undefined;
export function detachNotesPanel(title: string): Promise<void> {
  if (record) { signalPanelWindow(record.envelope, "request-focus"); return Promise.resolve(); }
  if (pending) return pending;
  const envelope: PanelWindowEnvelope = { version: 1, operationId: crypto.randomUUID(), panelId: "notes:hub", generation: ++generation, windowLabel: "notes-panel", event: "ready" };
  const controller = new AbortController();
  preparing = { envelope, controller, seq: -1 };
  useNotesWindowStore.setState({ phase: "preparing", error: null, recovery: null });
  const run = (async () => {
    try {
      await flushNotesEditor();
      const ready = waitPanelWindow(envelope, "ready", controller.signal);
      void ready.catch(() => undefined);
      const payload = { envelope, snapshot: snapshotNotesView() };
      writeDetachedHandoff("notes", "panel", payload);
      if (!consumeDetachedHandoff("notes", "panel")) throw new Error("Could not prepare the notes window");
      const pos = useNotesStore.getState().panelPosition;
      await openDetachedWindow({ kind: "notes", sessionId: "panel", title, operationId: envelope.operationId, ...pos });
      await ready;
      if (controller.signal.aborted) throw new Error("The notes window closed during preparation");
      useNotesWindowStore.setState({ phase: "committing" });
      await flushNotesEditor();
      if (controller.signal.aborted) throw new Error("The notes window closed during preparation");
      const committed = waitPanelWindow(envelope, "committed", controller.signal);
      void committed.catch(() => undefined);
      signalPanelWindow(envelope, "commit", snapshotNotesView());
      await committed;
      if (controller.signal.aborted) throw new Error("The notes window closed during preparation");
      record = { envelope, snapshot: preparing?.snapshot ?? snapshotNotesView() };
      snapshotSeq = preparing?.seq ?? -1;
      clearDetachedHandoff("notes", "panel");
      useNotesStore.getState().setPanelMode("floating");
      useNotesWindowStore.setState({ phase: "detached", error: null });
    } catch (error) {
      controller.abort(); signalPanelWindow(envelope, "cancel"); clearDetachedHandoff("notes", "panel");
      useNotesStore.getState().setPanelMode("hub");
      useNotesWindowStore.setState({ phase: "docked", error: String(error) });
      throw error;
    } finally { preparing = undefined; pending = undefined; }
  })();
  pending = run; return run;
}
async function receiveNotes(message: PanelWindowMessage, destroyed = false) {
  if (!record || !matchesPanelWindow(record.envelope, message.envelope)) return;
  const snapshot = validateNotesView(message.data);
  if (!snapshot) throw new Error("Invalid notes view snapshot");
  const envelope = record.envelope;
  useNotesWindowStore.setState({ phase: "returning", error: null });
  try {
    useNotesStore.getState().setPanelMode("hub");
    useTaoHubStore.getState().setHubTab("notes"); useChatStore.getState().setDrawerOpen(true);
    await restoreNotesView(snapshot);
    useNotesWindowStore.setState({ phase: "docked", error: null, recovery: destroyed ? t("shell.notesWindowRecovered") : null });
    await waitShellReady(() => visibleShellNode('[data-surface-id="notes"] [data-testid="notes-panel"]'));
    acknowledged = envelope; record = undefined;
    signalPanelWindow(envelope, "reattached");
  } catch (error) {
    if (destroyed) record = undefined;
    useNotesStore.getState().setPanelMode(destroyed ? "hub" : "floating");
    useNotesWindowStore.setState({ phase: destroyed ? "docked" : "detached", error: String(error) });
    throw error;
  }
}
export function requestNotesReturn() { if (record) signalPanelWindow(record.envelope, "request-reattach"); }
export function installNotesPanelWindowReceiver() {
  const off = subscribePanelWindow((message) => {
    if (acknowledged && matchesPanelWindow(acknowledged, message.envelope) && message.envelope.event === "request-reattach") { signalPanelWindow(acknowledged, "reattached"); return; }
    if (message.envelope.event === "snapshot") {
      const snapshot = validateNotesView(message.data);
      if (record && matchesPanelWindow(record.envelope, message.envelope) && snapshot && message.seq > snapshotSeq && !returning) { record.snapshot = snapshot; snapshotSeq = message.seq; }
      else if (preparing && matchesPanelWindow(preparing.envelope, message.envelope) && snapshot && message.seq > preparing.seq) { preparing.snapshot = snapshot; preparing.seq = message.seq; }
      return;
    }
    if (!record || !matchesPanelWindow(record.envelope, message.envelope)) return;
    if (message.envelope.event !== "request-reattach" || returning) return;
    returning = receiveNotes(message).catch((error) => signalPanelWindow({ ...message.envelope, errorCode: String(error) }, "failed")).finally(() => { returning = undefined; });
  });
  let disposed = false, unlisten: (() => void) | undefined;
  if (isTauriRuntime()) void listen<{ windowLabel: string; operationId: string | null }>("shell-detached-window-destroyed", ({ payload }) => {
    // A label may be reused. Bind the native event to this exact handoff so a
    // late Destroyed event from an old window cannot recover over a new owner.
    if (disposed) return;
    if (preparing?.envelope.windowLabel === payload.windowLabel && preparing.envelope.operationId === payload.operationId) {
      preparing.controller.abort();
      return;
    }
    if (!record || returning || record.envelope.windowLabel !== payload.windowLabel || record.envelope.operationId !== payload.operationId) return;
    const message: PanelWindowMessage = { type: "panel-window", from: "native-window-lifecycle", seq: 0, envelope: record.envelope, data: record.snapshot };
    returning = receiveNotes(message, true).catch(() => undefined).finally(() => { returning = undefined; });
  }).then((next) => { if (disposed) next(); else unlisten = next; }).catch((error) => {
    if (!disposed) useNotesWindowStore.setState({ error: String(error) });
  });
  return () => { disposed = true; off(); unlisten?.(); };
}
export async function returnNotesWindowBeforeExit() {
  if (pending) await pending;
  if (record) { requestNotesReturn(); await waitShellReady(() => !record); }
  await flushNotesEditor();
}
