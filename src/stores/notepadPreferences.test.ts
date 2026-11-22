import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_NOTEPAD_PREFERENCES,
  NOTEPAD_PREFERENCES_KEY,
  resetNotepadPreferences,
  setNotepadPreferences,
  useNotepadPreferences,
} from "./notepadPreferences";

function storedPreferences(): Record<string, unknown> {
  const raw = localStorage.getItem(NOTEPAD_PREFERENCES_KEY);
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}

beforeEach(() => {
  localStorage.clear();
  resetNotepadPreferences();
});

describe("notepadPreferences.lastSaveDir (U2)", () => {
  it("defaults to an empty directory", () => {
    expect(DEFAULT_NOTEPAD_PREFERENCES.lastSaveDir).toBe("");
    expect(useNotepadPreferences.getState().lastSaveDir).toBe("");
  });

  it("persists a trimmed last save directory", () => {
    setNotepadPreferences({ lastSaveDir: "  C:\\Users\\qa\\Documents  " });
    expect(useNotepadPreferences.getState().lastSaveDir).toBe("C:\\Users\\qa\\Documents");
    expect(storedPreferences().lastSaveDir).toBe("C:\\Users\\qa\\Documents");
  });

  it("accepts POSIX directories and keeps a single leading separator", () => {
    setNotepadPreferences({ lastSaveDir: "/home/qa/notes" });
    expect(useNotepadPreferences.getState().lastSaveDir).toBe("/home/qa/notes");
    expect(storedPreferences().lastSaveDir).toBe("/home/qa/notes");
  });

  it("rejects non-string values by falling back to empty", () => {
    setNotepadPreferences({ lastSaveDir: 42 as unknown as string });
    expect(useNotepadPreferences.getState().lastSaveDir).toBe("");
    expect(storedPreferences().lastSaveDir).toBe("");
  });

  it("does not disturb unrelated preferences when recording a save directory", () => {
    setNotepadPreferences({ wrap: true, fontSize: 18, lastSaveDir: "/tmp/out" });
    const state = useNotepadPreferences.getState();
    expect(state.wrap).toBe(true);
    expect(state.fontSize).toBe(18);
    expect(state.lastSaveDir).toBe("/tmp/out");
  });

  it("restores a persisted last save directory from cross-window storage sync", () => {
    const payload = { ...DEFAULT_NOTEPAD_PREFERENCES, lastSaveDir: "/mnt/shared", fontSize: 16 };
    // Real cross-window sync: the other window already wrote localStorage and
    // fires a storage event; the listener re-reads the persisted payload.
    localStorage.setItem(NOTEPAD_PREFERENCES_KEY, JSON.stringify(payload));
    window.dispatchEvent(new StorageEvent("storage", {
      key: NOTEPAD_PREFERENCES_KEY,
      newValue: JSON.stringify(payload),
    }));
    expect(useNotepadPreferences.getState().lastSaveDir).toBe("/mnt/shared");
    expect(useNotepadPreferences.getState().fontSize).toBe(16);
  });

  it("resets the last save directory", () => {
    setNotepadPreferences({ lastSaveDir: "/tmp/out" });
    resetNotepadPreferences();
    expect(useNotepadPreferences.getState().lastSaveDir).toBe("");
    expect(localStorage.getItem(NOTEPAD_PREFERENCES_KEY)).toBeNull();
  });
});
