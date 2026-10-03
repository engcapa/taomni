import { describe, expect, it } from "vitest";
import {
  formatShortcutLabel,
  keyDisplayLabel,
  selectPlatformBindings,
  shortcutKeyCaps,
} from "./workspaceKeymapPlatform";
import type { Shortcut } from "./workspaceKeymapScheme";

function keyboard(code: string, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } = {}, key?: string): Shortcut {
  return {
    kind: "keyboard",
    strokes: [{ code, ...(key ? { key } : {}), ctrl: !!mods.ctrl, alt: !!mods.alt, shift: !!mods.shift, meta: !!mods.meta }],
  };
}

describe("ED-PARITY-013 platform keymap resolution", () => {
  it("drops Meta bindings on Windows/Linux and lists Cmd first on macOS", () => {
    const bindings = ["Ctrl+Shift+N", "Meta+Shift+N"];
    expect(selectPlatformBindings(bindings, undefined, "linux")).toEqual(["Ctrl+Shift+N"]);
    expect(selectPlatformBindings(bindings, undefined, "windows")).toEqual(["Ctrl+Shift+N"]);
    expect(selectPlatformBindings(bindings, undefined, "mac")).toEqual(["Meta+Shift+N", "Ctrl+Shift+N"]);
    // Two-stroke Meta chords count as Meta bindings as well.
    expect(selectPlatformBindings(["Ctrl+Alt+/", "Meta+K Meta+S"], undefined, "linux")).toEqual(["Ctrl+Alt+/"]);
  });

  it("lets an explicit platform set replace the defaults", () => {
    const overrides = { linux: ["Shift+Alt+9"], mac: ["Ctrl+Q", "F1"] };
    expect(selectPlatformBindings(["Alt+F9"], overrides, "linux")).toEqual(["Shift+Alt+9"]);
    expect(selectPlatformBindings(["Alt+F9"], overrides, "windows")).toEqual(["Alt+F9"]);
    expect(selectPlatformBindings(["Ctrl+Q"], overrides, "mac")).toEqual(["Ctrl+Q", "F1"]);
  });
});

describe("ED-PARITY-013 shared shortcut formatter", () => {
  it("never renders raw upper-case key names", () => {
    expect(formatShortcutLabel(keyboard("ArrowLeft", { ctrl: true, alt: true }, "ARROWLEFT"), "linux", "en")).toBe("Ctrl+Alt+Left");
    expect(formatShortcutLabel(keyboard("Enter", { ctrl: true, shift: true }, "ENTER"), "linux", "en")).toBe("Ctrl+Shift+Enter");
    expect(formatShortcutLabel(keyboard("Space", { ctrl: true }, "SPACE"), "linux", "en")).toBe("Ctrl+Space");
    expect(formatShortcutLabel(keyboard("KeyN", { ctrl: true, shift: true }, "n"), "linux", "en")).toBe("Ctrl+Shift+N");
    expect(formatShortcutLabel(keyboard("Slash", { ctrl: true }), "linux", "en")).toBe("Ctrl+/");
    expect(formatShortcutLabel(keyboard("NumpadSubtract", { ctrl: true, shift: true }), "linux", "en")).toBe("Ctrl+Shift+NumPad -");
    expect(formatShortcutLabel(keyboard("Escape", { shift: true }), "linux", "en")).toBe("Shift+Esc");
  });

  it("uses Option/Cmd on macOS and localizes arrows in zh-CN", () => {
    expect(formatShortcutLabel(keyboard("KeyA", { meta: true, shift: true }), "mac", "en")).toBe("Shift+Cmd+A");
    expect(formatShortcutLabel(keyboard("KeyR", { alt: true, shift: true }), "mac", "en")).toBe("Option+Shift+R");
    expect(keyDisplayLabel("ArrowLeft", "zh-CN")).toBe("向左箭头");
    expect(keyDisplayLabel("ArrowLeft", "en")).toBe("Left");
  });

  it("splits key caps per stroke and labels mouse shortcuts", () => {
    const chord: Shortcut = {
      kind: "keyboard",
      strokes: [
        { code: "KeyK", ctrl: true, alt: false, shift: false, meta: false },
        { code: "KeyS", ctrl: true, alt: false, shift: false, meta: false },
      ],
    };
    expect(shortcutKeyCaps(chord, "linux", "en")).toEqual([["Ctrl", "K"], ["Ctrl", "S"]]);
    expect(formatShortcutLabel(chord, "linux", "en")).toBe("Ctrl+K Ctrl+S");
    const mouse: Shortcut = { kind: "mouse", button: 0, clickCount: 2, modifiers: { ctrl: true, alt: false, shift: false, meta: false } };
    expect(formatShortcutLabel(mouse, "linux", "en")).toBe("Ctrl+Double Click");
  });
});
