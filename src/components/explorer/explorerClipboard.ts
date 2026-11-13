import { useSyncExternalStore } from "react";
import { subscribeClipboardWrites } from "../../lib/clipboardOwnership";

export interface ExplorerClipboard { paths: string[]; cut: boolean }
let current: ExplorerClipboard | null = null;
const listeners = new Set<() => void>();
export function getExplorerClipboard() { return current; }
export function setExplorerClipboard(value: ExplorerClipboard | null) {
  current = value;
  listeners.forEach((listener) => listener());
}
// A Copy in another surface cancels the private destructive intent even if the
// newly published file list happens to contain exactly the same paths.
subscribeClipboardWrites(() => setExplorerClipboard(null));
if (typeof window !== "undefined") {
  const clear = () => setExplorerClipboard(null);
  window.addEventListener("copy", clear, true);
  window.addEventListener("cut", clear, true);
}
export function useExplorerClipboard() {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, getExplorerClipboard, getExplorerClipboard);
}
export function clipboardMatches(paths: string[], clipboard: ExplorerClipboard | null) {
  return !!clipboard && paths.length === clipboard.paths.length && paths.every((path, i) => path === clipboard.paths[i]);
}
