import { describe, it, expect } from "vitest";
import {
  shouldSuppressMacImeKeydown,
  clearStaleKeyDownSeen,
  clearStaleKeyDownSeenIfActive,
} from "./macImeKeydown";

// Faithful model of the relevant xterm.js 6.0 text-input path:
//   _keyDown(): _keyDownSeen = true   (for EVERY keydown, incl. keyCode 229)
//   _keyUp():   _keyDownSeen = false
//   _inputEvent(insertText): emit `data` iff (!composed || !_keyDownSeen)
// Our fix decides whether a keydown is allowed to reach xterm (and set the flag).
class XtermInputModel {
  // Mirror the xterm internals our fixes touch, so the refocus tests below exercise
  // the REAL reset helpers (clearStaleKeyDownSeen / …IfActive) rather than a copy.
  _core = { _keyDownSeen: false };
  // Stand-in for the helper textarea element; identity is all the guard compares.
  readonly textarea = { id: "xterm-helper-textarea" };
  emitted: string[] = [];
  constructor(private readonly applyFix: boolean) {}

  keydown(e: { key?: string; keyCode: number; ctrlKey?: boolean; metaKey?: boolean }) {
    if (
      this.applyFix &&
      shouldSuppressMacImeKeydown({ key: e.key, keyCode: e.keyCode, ctrlKey: !!e.ctrlKey, metaKey: !!e.metaKey })
    ) {
      return; // suppressed before reaching xterm — flag not set
    }
    this._core._keyDownSeen = true;
  }
  keyup() {
    this._core._keyDownSeen = false;
  }
  // Element-level focus — fires only when element focus actually changes (clicking
  // back in), NOT on a plain app/Space switch where the textarea stays activeElement.
  textareaFocus() {
    if (this.applyFix) clearStaleKeyDownSeen(this);
  }
  // window 'focus' / document 'visibilitychange' — these DO fire on an app/Space
  // switch even when the textarea stayed activeElement; guarded by activeElement.
  windowRefocus(activeElement: unknown) {
    if (this.applyFix) clearStaleKeyDownSeenIfActive(this, activeElement);
  }
  input(data: string, composed: boolean) {
    if (data && (!composed || !this._core._keyDownSeen)) this.emitted.push(data);
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
  it("suppresses a lone Meta/Control held through an app/Space switch (229 + modifier)", () => {
    // The Cmd still held when Cmd+Tab returns focus; its keyup is lost so the flag would stick.
    expect(shouldSuppressMacImeKeydown({ key: "Meta", keyCode: 229, metaKey: true })).toBe(true);
    expect(shouldSuppressMacImeKeydown({ key: "Control", keyCode: 229, ctrlKey: true })).toBe(true);
  });
  it("does NOT suppress a shortcut's action key (Cmd+C — the letter still reaches xterm)", () => {
    expect(shouldSuppressMacImeKeydown({ key: "c", keyCode: 67, ctrlKey: false, metaKey: true })).toBe(false);
    // A non-modifier 229 keydown with Ctrl/Cmd held (combo) also passes through.
    expect(shouldSuppressMacImeKeydown({ keyCode: 229, ctrlKey: true, metaKey: false })).toBe(false);
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

describe("clearStaleKeyDownSeen", () => {
  it("resets a stuck _keyDownSeen flag", () => {
    const term = { _core: { _keyDownSeen: true } };
    clearStaleKeyDownSeen(term);
    expect(term._core._keyDownSeen).toBe(false);
  });
  it("no-ops safely when the internal field is absent", () => {
    expect(() => clearStaleKeyDownSeen({})).not.toThrow();
    expect(() => clearStaleKeyDownSeen({ _core: {} })).not.toThrow();
  });
});

describe("clearStaleKeyDownSeenIfActive — window/visibility refocus guard", () => {
  const makeTerm = () => ({ textarea: { id: "ta" }, _core: { _keyDownSeen: true } });

  it("clears the flag when the terminal's textarea is still the active element", () => {
    const term = makeTerm();
    expect(clearStaleKeyDownSeenIfActive(term, term.textarea)).toBe(true);
    expect(term._core._keyDownSeen).toBe(false);
  });
  it("leaves the flag alone when focus is on another element (other pane/terminal)", () => {
    const term = makeTerm();
    expect(clearStaleKeyDownSeenIfActive(term, { id: "other-textarea" })).toBe(false);
    expect(term._core._keyDownSeen).toBe(true); // don't disturb unrelated terminals
  });
  it("no-ops when there is no active element or no textarea", () => {
    const term = makeTerm();
    expect(clearStaleKeyDownSeenIfActive(term, null)).toBe(false);
    expect(clearStaleKeyDownSeenIfActive({ _core: { _keyDownSeen: true } }, null)).toBe(false);
  });
});

describe("Cmd+Tab — the lone Meta keydown is suppressed, so the flag never sticks", () => {
  // On Cmd+Tab the Cmd is still held when focus returns, so the window delivers a fresh
  // `keydown key=Meta keyCode=229 metaKey` AFTER focus is restored — a refocus reset runs
  // too early and the keydown re-sets _keyDownSeen (confirmed on-device). The keydown
  // suppressor handles it instead: a lone Meta never reaches xterm.
  it("first symbol survives with no refocus reset at all", () => {
    const m = new XtermInputModel(true);
    m.keydown({ key: "Meta", keyCode: 229, metaKey: true }); // suppressed -> seen stays false
    m.input("@", true);
    expect(m.emitted).toEqual(["@"]);
  });
  it("would drop it WITHOUT the fix (lone Meta reaches xterm and sets the flag)", () => {
    const m = new XtermInputModel(false);
    m.keydown({ key: "Meta", keyCode: 229, metaKey: true });
    m.input("@", true);
    expect(m.emitted).toEqual([]);
  });
});

describe("Ctrl+arrow Space switch — arrow keydown sets the flag; refocus clears it", () => {
  // The arrow (keyCode 37, not a lone modifier) is NOT suppressed, so it sets the flag on
  // the way out and its keyup is lost to the other Space. Unlike Cmd+Tab there is no fresh
  // keydown on return, so a refocus reset can recover it.
  const arrow = { key: "ArrowLeft", keyCode: 37, ctrlKey: true };
  it("reproduces the drop with no reset", () => {
    const m = new XtermInputModel(true);
    m.keydown(arrow);
    m.input("@", true);
    expect(m.emitted).toEqual([]);
  });
  it("window refocus clears it though the textarea never re-fires focus", () => {
    const m = new XtermInputModel(true);
    m.keydown(arrow);
    m.windowRefocus(m.textarea); // textarea stayed activeElement; no textareaFocus()
    m.input("@", true);
    expect(m.emitted).toEqual(["@"]);
  });
  it("clicking back in (textarea focus) also clears it", () => {
    const m = new XtermInputModel(true);
    m.keydown(arrow);
    m.textareaFocus();
    m.input("@", true);
    expect(m.emitted).toEqual(["@"]);
  });
});
