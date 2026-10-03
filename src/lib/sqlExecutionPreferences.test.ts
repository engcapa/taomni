import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SQL_COMPLETION_PREFERENCES,
  SQL_COMPLETION_PREFERENCES_STORAGE_KEY,
  saveSqlCompletionPreferences,
} from "./sqlCompletionPreferences";
import {
  DEFAULT_SQL_EXECUTION_PREFERENCES,
  SQL_EXECUTION_PREFERENCES_EVENT,
  SQL_EXECUTION_PREFERENCES_STORAGE_KEY,
  completionShortcutConflictingWithExecutionCandidate,
  displaySqlShortcut,
  executionShortcutsConflictingWithCompletionCandidate,
  loadSqlExecutionPreferences,
  normalizeSqlExecutionPreferences,
  saveSqlExecutionPreferences,
  sqlExecutionConflictField,
  sqlExecutionShortcutValidationError,
  subscribeSqlExecutionPreferences,
} from "./sqlExecutionPreferences";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("SQL execution shortcut preferences", () => {
  it("uses the planned defaults", () => {
    expect(DEFAULT_SQL_EXECUTION_PREFERENCES).toEqual({
      runAll: "F5",
      runSelection: "Mod-Enter",
      runCurrent: "Mod-Shift-Enter",
    });
    expect(loadSqlExecutionPreferences()).toEqual(DEFAULT_SQL_EXECUTION_PREFERENCES);
  });

  it("validates hard-reserved multi-cursor bindings only", () => {
    expect(sqlExecutionShortcutValidationError("F8", false)).toBeNull();
    expect(sqlExecutionShortcutValidationError("F5", false)).toBeNull();
    expect(sqlExecutionShortcutValidationError("Mod-Enter", false)).toBeNull();
    expect(sqlExecutionShortcutValidationError("Shift-Alt-ArrowUp", false)).toBe("reserved");
    expect(sqlExecutionShortcutValidationError("", false)).toBe("required");
    expect(sqlExecutionShortcutValidationError("Space", false)).toBe("invalid");
  });

  it("detects conflicts among the three execution fields", () => {
    expect(
      sqlExecutionConflictField(DEFAULT_SQL_EXECUTION_PREFERENCES, "runCurrent", "F5", false),
    ).toBe("runAll");
    expect(
      sqlExecutionConflictField(DEFAULT_SQL_EXECUTION_PREFERENCES, "runCurrent", "Mod-Shift-Enter", false),
    ).toBeNull();
  });

  it("normalizes malformed stored preferences back to defaults", () => {
    expect(normalizeSqlExecutionPreferences({
      runAll: "invalid",
      runSelection: "Mod-Enter",
      runCurrent: "Shift-Alt-ArrowUp",
    })).toEqual({
      runAll: "F5",
      runSelection: "Mod-Enter",
      runCurrent: "Mod-Shift-Enter",
    });
  });

  it("persists preferences and emits same-window updates", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSqlExecutionPreferences(listener);
    const next = {
      runAll: "F8",
      runSelection: "Mod-Enter",
      runCurrent: "Mod-Shift-Enter",
    };
    saveSqlExecutionPreferences(next);

    expect(JSON.parse(localStorage.getItem(SQL_EXECUTION_PREFERENCES_STORAGE_KEY) ?? "null"))
      .toEqual(next);
    expect(loadSqlExecutionPreferences()).toEqual(next);
    expect(listener).toHaveBeenCalledWith(next);
    unsubscribe();
  });

  it("subscribes to cross-window storage changes and formats platform labels", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSqlExecutionPreferences(listener);
    localStorage.setItem(SQL_EXECUTION_PREFERENCES_STORAGE_KEY, JSON.stringify({
      ...DEFAULT_SQL_EXECUTION_PREFERENCES,
      runCurrent: "Alt-Enter",
    }));
    window.dispatchEvent(new StorageEvent("storage", {
      key: SQL_EXECUTION_PREFERENCES_STORAGE_KEY,
    }));

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ runCurrent: "Alt-Enter" }));
    expect(displaySqlShortcut("Mod-Shift-Enter", true)).toBe("Cmd+Shift+Enter");
    expect(displaySqlShortcut("Mod-Shift-Enter", false)).toBe("Ctrl+Shift+Enter");
    unsubscribe();
  });

  it("cross-checks completion ↔ execution conflicts", () => {
    saveSqlCompletionPreferences({
      ...DEFAULT_SQL_COMPLETION_PREFERENCES,
      triggerShortcut: "Alt-i",
    });
    expect(completionShortcutConflictingWithExecutionCandidate("Alt-i", false)).toBe(true);
    expect(completionShortcutConflictingWithExecutionCandidate("F8", false)).toBe(false);

    saveSqlExecutionPreferences({
      runAll: "F8",
      runSelection: "Mod-Enter",
      runCurrent: "Mod-Shift-Enter",
    });
    expect(executionShortcutsConflictingWithCompletionCandidate("F8", false)).toBe(true);
    expect(executionShortcutsConflictingWithCompletionCandidate("Ctrl-Space", false)).toBe(false);

    // Defaults block F5 even when nothing is stored for execution.
    localStorage.removeItem(SQL_EXECUTION_PREFERENCES_STORAGE_KEY);
    expect(executionShortcutsConflictingWithCompletionCandidate("F5", false)).toBe(true);
  });

  it("ignores invalid custom-event payloads via normalization", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSqlExecutionPreferences(listener);
    window.dispatchEvent(new CustomEvent(SQL_EXECUTION_PREFERENCES_EVENT, {
      detail: { runAll: "not-a-shortcut" },
    }));
    expect(listener).toHaveBeenCalledWith(DEFAULT_SQL_EXECUTION_PREFERENCES);
    unsubscribe();
    // Silence unused import if tree-shaken in some tooling
    expect(SQL_COMPLETION_PREFERENCES_STORAGE_KEY).toBeTruthy();
  });
});
