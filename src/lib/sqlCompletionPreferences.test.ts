import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SQL_COMPLETION_PREFERENCES,
  displaySqlShortcut,
  loadSqlCompletionPreferences,
  normalizeSqlCompletionPreferences,
  normalizeSqlShortcut,
  saveSqlCompletionPreferences,
  SQL_COMPLETION_PREFERENCES_EVENT,
  SQL_COMPLETION_PREFERENCES_STORAGE_KEY,
  sqlShortcutFromKeyboardEvent,
  sqlShortcutValidationError,
  subscribeSqlCompletionPreferences,
} from "./sqlCompletionPreferences";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("SQL completion shortcut preferences", () => {
  it("normalizes user-facing and CodeMirror shortcut forms", () => {
    expect(normalizeSqlShortcut("Ctrl+Space")).toBe("Ctrl-Space");
    expect(normalizeSqlShortcut("option+i")).toBe("Alt-i");
    expect(normalizeSqlShortcut("Cmd+Shift+P")).toBe("Meta-Shift-p");
    expect(normalizeSqlShortcut("F8")).toBe("F8");
    expect(normalizeSqlShortcut("Space")).toBeNull();
    expect(normalizeSqlShortcut("Ctrl+Alt")).toBeNull();
  });

  it("captures a real keyboard event without accepting modifier-only presses", () => {
    expect(sqlShortcutFromKeyboardEvent(new KeyboardEvent("keydown", {
      key: " ",
      code: "Space",
      ctrlKey: true,
    }))).toBe("Ctrl-Space");
    expect(sqlShortcutFromKeyboardEvent(new KeyboardEvent("keydown", {
      key: "i",
      altKey: true,
    }))).toBe("Alt-i");
    expect(sqlShortcutFromKeyboardEvent(new KeyboardEvent("keydown", {
      key: "Control",
      ctrlKey: true,
    }))).toBeNull();
  });

  it("detects shortcuts reserved by SQL editor commands per platform", () => {
    expect(sqlShortcutValidationError("F5", false)).toBe("reserved");
    expect(sqlShortcutValidationError("Ctrl+Enter", false)).toBe("reserved");
    expect(sqlShortcutValidationError("Meta+Enter", true)).toBe("reserved");
    expect(sqlShortcutValidationError("Ctrl+Space", false)).toBeNull();
    expect(sqlShortcutValidationError("", false)).toBe("required");
  });

  it("normalizes malformed stored preferences and keeps an accept key", () => {
    expect(normalizeSqlCompletionPreferences({
      activateOnTyping: false,
      triggerShortcut: "F5",
      acceptWithTab: false,
      acceptWithEnter: false,
    })).toEqual({
      activateOnTyping: false,
      triggerShortcut: DEFAULT_SQL_COMPLETION_PREFERENCES.triggerShortcut,
      acceptWithTab: false,
      acceptWithEnter: true,
    });
  });

  it("persists preferences and emits same-window updates", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSqlCompletionPreferences(listener);
    saveSqlCompletionPreferences({
      activateOnTyping: false,
      triggerShortcut: "Alt-i",
      acceptWithTab: true,
      acceptWithEnter: false,
    });

    expect(JSON.parse(localStorage.getItem(SQL_COMPLETION_PREFERENCES_STORAGE_KEY) ?? "null"))
      .toEqual({
        activateOnTyping: false,
        triggerShortcut: "Alt-i",
        acceptWithTab: true,
        acceptWithEnter: false,
      });
    expect(loadSqlCompletionPreferences().triggerShortcut).toBe("Alt-i");
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ triggerShortcut: "Alt-i" }));
    unsubscribe();
  });

  it("subscribes to cross-window storage changes and formats platform labels", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSqlCompletionPreferences(listener);
    localStorage.setItem(SQL_COMPLETION_PREFERENCES_STORAGE_KEY, JSON.stringify({
      ...DEFAULT_SQL_COMPLETION_PREFERENCES,
      triggerShortcut: "Meta-Space",
    }));
    window.dispatchEvent(new StorageEvent("storage", {
      key: SQL_COMPLETION_PREFERENCES_STORAGE_KEY,
    }));

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ triggerShortcut: "Meta-Space" }));
    expect(displaySqlShortcut("Meta-Space", true)).toBe("Cmd+Space");
    expect(displaySqlShortcut("Alt-i", true)).toBe("Option+I");
    unsubscribe();
  });

  it("ignores unrelated custom event payloads only after normalization", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSqlCompletionPreferences(listener);
    window.dispatchEvent(new CustomEvent(SQL_COMPLETION_PREFERENCES_EVENT, {
      detail: { triggerShortcut: "invalid shortcut" },
    }));

    expect(listener).toHaveBeenCalledWith(DEFAULT_SQL_COMPLETION_PREFERENCES);
    unsubscribe();
  });
});
