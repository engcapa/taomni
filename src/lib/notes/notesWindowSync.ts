import { isTauriRuntime } from "../runtime";

const NOTES_DOCK_SIGNAL_KEY = "taomni.notes.dockSignal.v1";
const NOTES_DOCK_CHANNEL = "taomni.notes.sync.v1";
const NOTES_DOCK_EVENT = "taomni://notes-dock";

function emitBroadcastDockSignal(sentAt: number): void {
  try {
    const channel = new BroadcastChannel(NOTES_DOCK_CHANNEL);
    channel.postMessage({ type: "dock", sentAt });
    channel.close();
  } catch {
    /* BroadcastChannel unavailable */
  }
}

function emitTauriDockSignal(sentAt: number): void {
  if (!isTauriRuntime()) return;
  void import("@tauri-apps/api/event")
    .then(({ emit }) => emit(NOTES_DOCK_EVENT, { sentAt }))
    .catch(() => {
      /* event bus unavailable */
    });
}

export function emitNotesDockSignal(): void {
  const sentAt = Date.now();
  try {
    localStorage.setItem(NOTES_DOCK_SIGNAL_KEY, String(sentAt));
  } catch {
    /* storage unavailable */
  }
  emitBroadcastDockSignal(sentAt);
  emitTauriDockSignal(sentAt);
}

export function isNotesDockSignal(event: StorageEvent): boolean {
  return event.key === NOTES_DOCK_SIGNAL_KEY;
}

function isNotesDockBroadcast(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { type?: unknown }).type === "dock"
  );
}

export function subscribeNotesDockSignal(onDock: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (isNotesDockSignal(event)) onDock();
  };
  window.addEventListener("storage", onStorage);

  let channel: BroadcastChannel | null = null;
  try {
    channel = new BroadcastChannel(NOTES_DOCK_CHANNEL);
    channel.addEventListener("message", (event) => {
      if (isNotesDockBroadcast(event.data)) onDock();
    });
  } catch {
    /* BroadcastChannel unavailable */
  }

  let disposed = false;
  let unlistenTauri: (() => void) | null = null;
  if (isTauriRuntime()) {
    void import("@tauri-apps/api/event")
      .then(({ listen }) => listen(NOTES_DOCK_EVENT, () => onDock()))
      .then((unlisten) => {
        if (disposed) unlisten();
        else unlistenTauri = unlisten;
      })
      .catch(() => {
        /* event bus unavailable */
      });
  }

  return () => {
    disposed = true;
    window.removeEventListener("storage", onStorage);
    channel?.close();
    unlistenTauri?.();
  };
}
