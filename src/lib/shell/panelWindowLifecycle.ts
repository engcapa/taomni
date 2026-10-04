import { listen } from "@tauri-apps/api/event";
import { isTauriRuntime } from "../runtime";

export interface DestroyedPanelWindow { windowLabel: string; operationId: string | null }
export function installPanelWindowLifecycle(onDestroyed: (window: DestroyedPanelWindow) => void, onError: (error: unknown) => void): () => void {
  let disposed = false;
  let unlisten: (() => void) | undefined;
  if (isTauriRuntime()) void listen<DestroyedPanelWindow>("shell-detached-window-destroyed", ({ payload }) => {
    if (!disposed) onDestroyed(payload);
  }).then((off) => { if (disposed) off(); else unlisten = off; }).catch((error) => { if (!disposed) onError(error); });
  return () => { disposed = true; unlisten?.(); };
}
