import { create } from "zustand";
import { documentPathKey, isUntitledKey } from "../../lib/openFile/pathIdentity";
import { useNotepadPreferences } from "../notepadPreferences";

export interface RecentFileEntry {
  path: string;
  name: string;
  lastOpenedAt: number;
}

export interface ClosedFileEntry {
  path: string;
  name: string;
  closedAt: number;
}

export const RECENT_FILES_KEY = "taomni.notepad.recentFiles.v1";

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function readRecentFiles(): RecentFileEntry[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_FILES_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    return parsed
      .filter((item): item is RecentFileEntry => Boolean(item && typeof item.path === "string" && item.path.trim()))
      .filter((item) => {
        const key = documentPathKey(item.path);
        if (seen.has(key) || isUntitledKey(key)) return false;
        seen.add(key);
        return true;
      })
      .map((item) => ({
        path: item.path,
        name: typeof item.name === "string" && item.name.trim() ? item.name : baseName(item.path),
        lastOpenedAt: typeof item.lastOpenedAt === "number" ? item.lastOpenedAt : Date.now(),
      }));
  } catch {
    return [];
  }
}

function persistRecentFiles(entries: RecentFileEntry[]): void {
  try {
    localStorage.setItem(RECENT_FILES_KEY, JSON.stringify(entries));
  } catch {
    // Ignore storage quota errors.
  }
}

export interface RecentFilesStoreState {
  recentFiles: RecentFileEntry[];
  closedStack: ClosedFileEntry[];
  recordRecent: (path: string, name?: string) => void;
  removeRecent: (path: string) => void;
  renameRecent: (oldPath: string, newPath: string) => void;
  clearRecent: () => void;
  pushClosed: (path: string, name?: string) => void;
  popClosed: () => ClosedFileEntry | undefined;
  reloadFromStorage: () => void;
}

export const useRecentFilesStore = create<RecentFilesStoreState>((set, get) => ({
  recentFiles: readRecentFiles(),
  closedStack: [],

  recordRecent(path, name) {
    if (!path || isUntitledKey(path)) return;
    const key = documentPathKey(path);
    const limit = Math.max(1, useNotepadPreferences.getState().recentMax);
    const entry: RecentFileEntry = {
      path,
      name: name?.trim() || baseName(path),
      lastOpenedAt: Date.now(),
    };
    const next = [entry, ...get().recentFiles.filter((item) => documentPathKey(item.path) !== key)].slice(0, limit);
    persistRecentFiles(next);
    set({ recentFiles: next });
  },

  removeRecent(path) {
    const key = documentPathKey(path);
    const next = get().recentFiles.filter((item) => documentPathKey(item.path) !== key);
    persistRecentFiles(next);
    set({ recentFiles: next });
  },

  renameRecent(oldPath, newPath) {
    const oldKey = documentPathKey(oldPath);
    const newKey = documentPathKey(newPath);
    const next = get().recentFiles
      .filter((item) => documentPathKey(item.path) !== newKey)
      .map((item) =>
        documentPathKey(item.path) === oldKey
          ? { path: newPath, name: baseName(newPath), lastOpenedAt: Date.now() }
          : item,
      );
    persistRecentFiles(next);
    set({ recentFiles: next });
  },

  clearRecent() {
    persistRecentFiles([]);
    set({ recentFiles: [] });
  },

  pushClosed(path, name) {
    if (!path || isUntitledKey(path)) return;
    const entry: ClosedFileEntry = { path, name: name?.trim() || baseName(path), closedAt: Date.now() };
    const stack = [entry, ...get().closedStack.filter((item) => documentPathKey(item.path) !== documentPathKey(path))].slice(0, 30);
    set({ closedStack: stack });
  },

  popClosed() {
    const [head, ...rest] = get().closedStack;
    if (!head) return undefined;
    set({ closedStack: rest });
    return head;
  },

  reloadFromStorage() {
    set({ recentFiles: readRecentFiles() });
  },
}));
