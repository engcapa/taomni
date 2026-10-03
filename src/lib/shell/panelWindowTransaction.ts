import { broadcastPanelWindow, subscribePanelWindow, type PanelWindowMessage } from "../detachedSession";
import type { PanelWindowEnvelope } from "./types";

export function matchesPanelWindow(expected: PanelWindowEnvelope, actual: PanelWindowEnvelope): boolean {
  return actual.version === 1 && expected.operationId === actual.operationId && expected.panelId === actual.panelId && expected.generation === actual.generation && expected.windowLabel === actual.windowLabel;
}
export function waitPanelWindow(expected: PanelWindowEnvelope, event: PanelWindowEnvelope["event"], signal?: AbortSignal, timeout = 10000): Promise<PanelWindowMessage> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error, message?: PanelWindowMessage) => { clearTimeout(timer); off(); signal?.removeEventListener("abort", abort); if (error) reject(error); else resolve(message!); };
    const off = subscribePanelWindow((message) => {
      if (!matchesPanelWindow(expected, message.envelope)) return;
      if (message.envelope.event === "failed" || message.envelope.event === "cancel") finish(new Error(message.envelope.errorCode ?? "Window preparation failed"));
      else if (message.envelope.event === event) finish(undefined, message);
    });
    const timer = setTimeout(() => finish(new Error(`Window ${event} acknowledgement timed out`)), timeout);
    const abort = () => finish(new Error("Window operation cancelled"));
    signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
  });
}
export function signalPanelWindow(envelope: PanelWindowEnvelope, event: PanelWindowEnvelope["event"], data?: unknown) { broadcastPanelWindow({ ...envelope, event }, data); }
export function detachedWindowLabel(kind: string, id: string) { return `${kind}-${id.replace(/[^\p{L}\p{N}]/gu, "-")}`; }
