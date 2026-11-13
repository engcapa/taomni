import { useSyncExternalStore } from "react";

export interface ExplorerClipboard { paths: string[]; cut: boolean }
let current: ExplorerClipboard | null = null;
const listeners = new Set<() => void>();
export function getExplorerClipboard() { return current; }
export function setExplorerClipboard(value: ExplorerClipboard | null) {
  current = value;
  listeners.forEach((listener) => listener());
}
export function useExplorerClipboard() {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, getExplorerClipboard, getExplorerClipboard);
}
export function clipboardMatches(paths: string[], clipboard: ExplorerClipboard | null) {
  return !!clipboard && paths.length === clipboard.paths.length && paths.every((path, i) => path === clipboard.paths[i]);
}
