import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import source from "../../src-tauri/src/qa_driver_keyboard.js?raw";

type Activate = (el: HTMLButtonElement, type: string, key: string, event: { defaultPrevented: boolean }, modifiers: Record<string, boolean>) => void;
const createKeyboard = new Function(source + "\nreturn createQaButtonKeyboard;")() as () => Activate;

describe("macOS QA button keyboard defaults", () => {
  let button: HTMLButtonElement;
  let activate: Activate;
  const clicked = vi.fn();
  const modifiers = { Control: false, Meta: false, Alt: false };
  const event = { defaultPrevented: false };

  beforeEach(() => {
    button = document.createElement("button");
    document.body.appendChild(button);
    button.focus();
    button.addEventListener("click", clicked);
    activate = createKeyboard();
    clicked.mockClear();
  });
  afterEach(() => button.remove());

  it("activates Enter on keydown once and Space only on release", () => {
    activate(button, "keydown", "Enter", event, modifiers);
    activate(button, "keyup", "Enter", event, modifiers);
    expect(clicked).toHaveBeenCalledTimes(1);
    activate(button, "keydown", " ", event, modifiers);
    expect(clicked).toHaveBeenCalledTimes(1);
    activate(button, "keyup", " ", event, modifiers);
    activate(button, "keyup", " ", event, modifiers);
    expect(clicked).toHaveBeenCalledTimes(2);
  });

  it("respects canceled keydowns, shortcuts and disabled buttons", () => {
    const canceled = { defaultPrevented: true };
    activate(button, "keydown", "Enter", canceled, modifiers);
    activate(button, "keydown", " ", canceled, modifiers);
    activate(button, "keyup", " ", event, modifiers);
    activate(button, "keydown", "Enter", event, { ...modifiers, Control: true });
    button.disabled = true;
    activate(button, "keydown", "Enter", event, modifiers);
    expect(clicked).not.toHaveBeenCalled();
  });

  it("cancels Space if focus leaves the pressed button", () => {
    activate(button, "keydown", " ", event, modifiers);
    button.blur();
    activate(button, "keyup", " ", event, modifiers);
    expect(clicked).not.toHaveBeenCalled();
  });
});
