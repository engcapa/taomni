/** In-window clipboard writes invalidate private destructive cut intents.
 * This is not a substitute for the OS file list or a persisted clipboard. */
const listeners = new Set<() => void>();
export function notifyClipboardWritten(): void {
  for (const listener of listeners) listener();
}
export function subscribeClipboardWrites(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
