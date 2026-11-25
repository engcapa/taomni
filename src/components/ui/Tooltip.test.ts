import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { installTooltips } from "./Tooltip";

let dispose: () => void;
beforeEach(() => {
  vi.useFakeTimers();
  dispose = installTooltips(document);
});
afterEach(() => {
  dispose();
  document.body.replaceChildren();
  vi.useRealTimers();
});

function button(label: string, parent: HTMLElement = document.body) {
  const control = document.createElement("button");
  control.dataset.taomniTooltip = label;
  vi.spyOn(control, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  parent.append(control);
  return control;
}

it("dwells once, switches immediately to the adjacent target and releases its description", () => {
  const first = button("Files");
  const second = button("Settings");
  second.setAttribute("aria-describedby", "help");
  fireEvent.pointerOver(first);
  vi.advanceTimersByTime(499);
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  vi.advanceTimersByTime(1);
  expect(document.querySelector('[role="tooltip"]')).toHaveTextContent("Files");
  fireEvent.pointerOut(first, { relatedTarget: second });
  fireEvent.pointerOver(second);
  expect(first).not.toHaveAttribute("aria-describedby");
  expect(second).toHaveAttribute("aria-describedby", "help taomni-control-tooltip");
  expect(document.querySelector('[role="tooltip"]')).toHaveTextContent("Settings");
  fireEvent.pointerDown(second);
  expect(second).toHaveAttribute("aria-describedby", "help");
});

it("puts keyboard hints inside their modal and clears them with Escape or when the trigger unmounts", async () => {
  const dialog = document.createElement("dialog");
  dialog.setAttribute("open", "");
  document.body.append(dialog);
  const control = button("Copy", dialog);
  control.focus();
  expect(dialog.querySelector('[role="tooltip"]')).toHaveTextContent("Copy");
  fireEvent.keyDown(control, { key: "Escape" });
  expect(control).not.toHaveAttribute("aria-describedby");
  fireEvent.pointerOver(control);
  vi.advanceTimersByTime(500);
  control.remove();
  await Promise.resolve();
  expect(dialog.querySelector('[role="tooltip"]')).toBeNull();
});

it("dismisses one visible layer per Escape and leaves composition and pending hints with the control", () => {
  const target = button("Close");
  const dialogKey = vi.fn();
  target.addEventListener("keydown", dialogKey);
  fireEvent.pointerOver(target);
  fireEvent.keyDown(target, { key: "Escape" });
  expect(dialogKey).toHaveBeenCalledTimes(1);
  fireEvent.pointerOver(target);
  vi.advanceTimersByTime(500);
  fireEvent.keyDown(target, { key: "Escape", keyCode: 229 });
  expect(document.querySelector('[role="tooltip"]')).toBeVisible();
  expect(dialogKey).toHaveBeenCalledTimes(2);
  expect(fireEvent.keyDown(target, { key: "Escape" })).toBe(false);
  expect(dialogKey).toHaveBeenCalledTimes(2);
  fireEvent.keyDown(target, { key: "Escape" });
  expect(dialogKey).toHaveBeenCalledTimes(3);
});
