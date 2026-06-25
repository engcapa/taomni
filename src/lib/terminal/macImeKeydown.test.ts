import { describe, it, expect } from "vitest";
import { shouldSuppressMacImeKeydown } from "./macImeKeydown";

// Faithful model of the relevant xterm.js 6.0 text-input path:
//   _keyDown(): _keyDownSeen = true   (for EVERY keydown, incl. keyCode 229)
//   _keyUp():   _keyDownSeen = false
//   _inputEvent(insertText): emit `data` iff (!composed || !_keyDownSeen)
// Our fix decides whether a keydown is allowed to reach xterm (and set the flag).
class XtermInputModel {
  keyDownSeen = false;
  emitted: string[] = [];
  constructor(private readonly applyFix: boolean) {}

  keydown(e: { keyCode: number; ctrlKey?: boolean; metaKey?: boolean }) {
    if (
      this.applyFix &&
      shouldSuppressMacImeKeydown({ keyCode: e.keyCode, ctrlKey: !!e.ctrlKey, metaKey: !!e.metaKey })
    ) {
      return; // suppressed before reaching xterm — flag not set
    }
    this.keyDownSeen = true;
  }
  keyup() {
    this.keyDownSeen = false;
  }
  input(data: string, composed: boolean) {
    if (data && (!composed || !this.keyDownSeen)) this.emitted.push(data);
  }
}

// Replays the observed macOS Sogou sequence: Shift held, "2"(→@), "3"(→#).
// Real per-char order is input → keydown → keyup; Shift is held (no keyup until end).
function replayShiftHeldAtAndHash(model: XtermInputModel) {
  model.keydown({ keyCode: 229 }); // Shift down (held), keyCode 229
  model.input("@", true); // committed "@" (composed)
  model.keydown({ keyCode: 229 });
  model.keyup(); // "@" key down+up
  model.input("#", true); // committed "#"
  model.keydown({ keyCode: 229 });
  model.keyup(); // "#" key down+up
  model.keyup(); // Shift up
}

describe("shouldSuppressMacImeKeydown", () => {
  it("suppresses bare/Shift IME-routed (229) keydowns", () => {
    expect(shouldSuppressMacImeKeydown({ keyCode: 229, ctrlKey: false, metaKey: false })).toBe(true);
  });
  it("does NOT suppress Ctrl/Cmd combos (shortcuts must survive)", () => {
    expect(shouldSuppressMacImeKeydown({ keyCode: 229, ctrlKey: true, metaKey: false })).toBe(false);
    expect(shouldSuppressMacImeKeydown({ keyCode: 67, ctrlKey: false, metaKey: true })).toBe(false);
  });
  it("does NOT suppress normal (non-229) keys like Enter", () => {
    expect(shouldSuppressMacImeKeydown({ keyCode: 13, ctrlKey: false, metaKey: false })).toBe(false);
  });
});

describe("xterm input model — macOS Sogou Shift+digit", () => {
  it("reproduces the bug WITHOUT the fix (first '@' is dropped)", () => {
    const m = new XtermInputModel(false);
    replayShiftHeldAtAndHash(m);
    expect(m.emitted).toEqual(["#"]); // '@' lost
  });
  it("emits every character WITH the fix", () => {
    const m = new XtermInputModel(true);
    replayShiftHeldAtAndHash(m);
    expect(m.emitted).toEqual(["@", "#"]);
  });
});
