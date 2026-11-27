import { describe, expect, it } from "vitest";
import { contentZoomShortcut, nextFontOffset } from "./contentZoomShortcut";

describe("content zoom bindings", () => {
  for (const mac of [false, true]) {
    it(`accepts the desktop modifier and preserves text input (macOS ${mac})`, () => {
      const modifiers = { ctrlKey: !mac, metaKey: mac };
      for (const [key, action] of [["+", "in"], ["=", "in"], ["-", "out"], ["0", "reset"]]) {
        expect(contentZoomShortcut(new KeyboardEvent("keydown", { ...modifiers, key }), mac)).toBe(action);
      }
      for (const extra of [{ altKey: true }, { isComposing: true }, { ctrlKey: true, metaKey: true }, { keyCode: 229 }]) {
        expect(contentZoomShortcut(new KeyboardEvent("keydown", { key: "=", ...modifiers, ...extra }), mac)).toBeUndefined();
      }
      expect(contentZoomShortcut(new KeyboardEvent("keydown", { key: "0", ctrlKey: mac, metaKey: !mac }), mac)).toBeUndefined();
    });
  }

  it("reverses immediately at either limit even after the base size changes", () => {
    expect(nextFontOffset("in", 30, 6)).toBe(2);
    expect(nextFontOffset("out", 30, 6)).toBe(1);
    expect(nextFontOffset("out", 10, -6)).toBe(-2);
    expect(nextFontOffset("in", 10, -6)).toBe(-1);
    expect(nextFontOffset("reset", 24, -4)).toBe(0);
  });
});
