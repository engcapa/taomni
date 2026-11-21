import { beforeEach, describe, expect, it, vi } from "vitest";
import { NOTEPAD_COMMAND_CATALOG } from "./catalog";
import {
  KEYMAP_STORAGE_KEY,
  formatShortcutDisplay,
  isImeComposing,
  keyboardEventToShortcut,
  normalizeShortcut,
  useNotepadKeymap,
} from "./keymap";
import { NotepadCommandRegistry } from "./registry";
import type { RecordedMacroStep } from "./types";

describe("notepad keymap & command registry (V-07, V-08)", () => {
  beforeEach(() => {
    localStorage.clear();
    useNotepadKeymap.getState().resetAll();
  });

  it("normalizes Mod shortcuts differently for macOS vs Windows/Linux and avoids macOS Alt mnemonics", () => {
    expect(normalizeShortcut("Mod+S", false)).toBe("Control+S");
    expect(normalizeShortcut("Mod+S", true)).toBe("Meta+S");
    expect(useNotepadKeymap.getState().resolveShortcut("edit.redo", false)).toBe("Control+Y");
    expect(useNotepadKeymap.getState().resolveShortcut("edit.redo", true)).toBe("Meta+Shift+Z");
    expect(formatShortcutDisplay("Mod+Shift+Z", true)).toBe("⌘⇧Z");
  });

  it("detects conflicts, persists overrides, and resets cleanly (V-07)", () => {
    const keymap = useNotepadKeymap.getState();
    expect(keymap.getConflicts(false)).toHaveLength(0);

    keymap.setBinding("edit.duplicateLine", "Control+F");
    const conflicts = keymap.getConflicts(false);
    expect(conflicts).toEqual([
      { shortcut: "Control+F", commandIds: expect.arrayContaining(["edit.duplicateLine", "search.find"]) },
    ]);
    expect(JSON.parse(localStorage.getItem(KEYMAP_STORAGE_KEY) || "{}")).toMatchObject({
      "edit.duplicateLine": "Control+F",
    });

    keymap.resetBinding("edit.duplicateLine");
    expect(keymap.getConflicts(false)).toHaveLength(0);
    expect(keymap.resolveShortcut("edit.duplicateLine", false)).toBe("Control+D");
  });

  it("suppresses shortcut resolution during IME composition (V-08)", () => {
    expect(isImeComposing({ isComposing: true, keyCode: 65 })).toBe(true);
    expect(isImeComposing({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(
      keyboardEventToShortcut({
        key: "s",
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        isComposing: true,
        keyCode: 229,
      }),
    ).toBe("");
    const matched = useNotepadKeymap.getState().findCommandByEvent(
      {
        key: "s",
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        isComposing: false,
        keyCode: 83,
      },
      false,
    );
    expect(matched).toBe("file.save");
  });

  it("enforces DEC-07 recordable whitelist during macro recording (V-08)", async () => {
    const registry = new NotepadCommandRegistry();
    const steps: RecordedMacroStep[] = [];
    const unsub = registry.onRecordStep((step) => steps.push(step));
    const saveFn = vi.fn();
    const upperFn = vi.fn();
    const openTermFn = vi.fn();

    registry.registerMany({
      "file.save": saveFn,
      "edit.toUpperCase": upperFn,
      "file.openTerminalDir": openTermFn,
    });

    await registry.execute("file.save");
    await registry.execute("edit.toUpperCase");
    await registry.execute("file.openTerminalDir");
    registry.recordTextInsert("hello");
    unsub();

    expect(saveFn).toHaveBeenCalledOnce();
    expect(upperFn).toHaveBeenCalledOnce();
    expect(openTermFn).toHaveBeenCalledOnce();
    expect(steps).toEqual([
      { type: "command", commandId: "edit.toUpperCase", args: undefined },
      { type: "insertText", text: "hello" },
    ]);

    // Ensure dangerous / non-recordable categories are marked recordable: false
    const nonRecordable = NOTEPAD_COMMAND_CATALOG.filter((c) => c.category === "file" || c.category === "macro" || c.category === "encoding");
    expect(nonRecordable.every((c) => c.recordable === false)).toBe(true);
  });
});
