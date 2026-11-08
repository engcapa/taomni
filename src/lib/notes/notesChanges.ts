import { isTauriRuntime } from "../runtime";

const CHANGE_EVENT = "taomni://notes-changed";
const CHANGE_CHANNEL = "taomni.notes.content.v1";
interface NotesChange { noteId: string; token: string }

/** Same-window observers run synchronously; other windows reload from storage. */
export function publishNotesChange(noteId: string): void {
  const change: NotesChange = { noteId, token: crypto.randomUUID() };
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: change }));
  if (isTauriRuntime()) {
    void import("@tauri-apps/api/event").then(({ emit }) => emit(CHANGE_EVENT, change)).catch(console.warn);
  } else {
    try {
      const channel = new BroadcastChannel(CHANGE_CHANNEL);
      channel.postMessage(change);
      channel.close();
    } catch { /* Cross-window messaging is unavailable in some test hosts. */ }
  }
}

export function subscribeNotesChanges(onChange: (noteId: string) => void): () => void {
  let disposed = false;
  const seen = new Set<string>();
  const accept = (change: NotesChange) => {
    if (disposed || typeof change?.noteId !== "string" || typeof change.token !== "string" || seen.has(change.token)) return;
    seen.add(change.token);
    if (seen.size > 100) seen.delete(seen.values().next().value!);
    onChange(change.noteId);
  };
  const onLocal = (event: Event) => accept((event as CustomEvent<NotesChange>).detail);
  window.addEventListener(CHANGE_EVENT, onLocal);
  let unlisten: (() => void) | undefined;
  let channel: BroadcastChannel | undefined;
  if (isTauriRuntime()) {
    void import("@tauri-apps/api/event").then(({ listen }) => listen<NotesChange>(CHANGE_EVENT, (event) => accept(event.payload)))
      .then((stop) => { if (disposed) stop(); else unlisten = stop; }).catch(console.warn);
  } else {
    try {
      channel = new BroadcastChannel(CHANGE_CHANNEL);
      channel.onmessage = (event) => accept(event.data as NotesChange);
    } catch { /* Same-window updates remain available. */ }
  }
  return () => {
    disposed = true;
    window.removeEventListener(CHANGE_EVENT, onLocal);
    unlisten?.();
    channel?.close();
  };
}
