import { afterEach, expect, it, vi } from "vitest";
import { registerZoomTarget, zoomFromMenu } from "./pageZoom";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  document.body.replaceChildren();
});

function surface(parent: Element, visible = true, pageKeyboard = true) {
  const root = document.createElement("div");
  const input = document.createElement("input");
  root.append(input);
  parent.append(root);
  vi.spyOn(root, "getClientRects").mockImplementation(() => (visible ? [{}] : []) as unknown as DOMRectList);
  const change = vi.fn();
  cleanups.push(registerZoomTarget({ element: () => root, pageKeyboard, change }));
  return { root, input, change, hide: () => { visible = false; } };
}

it("sends the menu to the last visible pane after focus moves to the toolbar", () => {
  const page = surface(document.body);
  const first = surface(page.root, true, false);
  const second = surface(page.root, true, false);
  const button = document.createElement("button");
  document.body.append(button);
  second.input.focus();
  button.focus();
  expect(zoomFromMenu("in")).toBe(true);
  expect(second.change).toHaveBeenCalledExactlyOnceWith("in", second.input);
  expect(first.change).not.toHaveBeenCalled();
  expect(page.change).not.toHaveBeenCalled();
  second.hide();
  expect(zoomFromMenu("reset")).toBe(true);
  expect(second.change).toHaveBeenCalledTimes(1);
});

it("only consumes ordinary page chords when the focused surface has no private keymap", () => {
  const ordinary = surface(document.body);
  const editor = surface(ordinary.root, true, false);
  function press(element: HTMLElement, extra = {}) {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "=", ctrlKey: true, ...extra });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  }
  expect(press(editor.input)).toBe(false);
  expect(press(ordinary.input, { isComposing: true })).toBe(false);
  expect(press(ordinary.input, { altKey: true })).toBe(false);
  expect(press(ordinary.input)).toBe(true);
  expect(ordinary.change).toHaveBeenCalledExactlyOnceWith("in", ordinary.input);
  ordinary.hide();
  editor.hide();
  expect(zoomFromMenu("out")).toBe(false);
});
