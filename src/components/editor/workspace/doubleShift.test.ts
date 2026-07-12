import { describe, expect, it, vi } from "vitest";
import { createDoubleShiftDetector } from "./doubleShift";

function shiftDown(): KeyboardEvent {
  return new KeyboardEvent("keydown", { key: "Shift" });
}

function shiftUp(): KeyboardEvent {
  return new KeyboardEvent("keyup", { key: "Shift" });
}

describe("createDoubleShiftDetector", () => {
  it("triggers on two clean shift taps within the window", () => {
    const onTrigger = vi.fn();
    let time = 0;
    const detector = createDoubleShiftDetector(onTrigger, 400, () => time);

    detector.handleKeyDown(shiftDown());
    detector.handleKeyUp(shiftUp());
    time = 300;
    detector.handleKeyDown(shiftDown());
    detector.handleKeyUp(shiftUp());

    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it("does not trigger when the taps are too far apart", () => {
    const onTrigger = vi.fn();
    let time = 0;
    const detector = createDoubleShiftDetector(onTrigger, 400, () => time);

    detector.handleKeyDown(shiftDown());
    detector.handleKeyUp(shiftUp());
    time = 900;
    detector.handleKeyDown(shiftDown());
    detector.handleKeyUp(shiftUp());

    expect(onTrigger).not.toHaveBeenCalled();
  });

  it("ignores shift used as a modifier for another key", () => {
    const onTrigger = vi.fn();
    const detector = createDoubleShiftDetector(onTrigger, 400, () => 0);

    // Shift+A (typing a capital letter), then a clean shift tap.
    detector.handleKeyDown(shiftDown());
    detector.handleKeyDown(new KeyboardEvent("keydown", { key: "A", shiftKey: true }));
    detector.handleKeyUp(shiftUp());
    detector.handleKeyDown(shiftDown());
    detector.handleKeyUp(shiftUp());

    expect(onTrigger).not.toHaveBeenCalled();
  });

  it("ignores ctrl+shift chords", () => {
    const onTrigger = vi.fn();
    const detector = createDoubleShiftDetector(onTrigger, 400, () => 0);

    detector.handleKeyDown(new KeyboardEvent("keydown", { key: "Shift", ctrlKey: true }));
    detector.handleKeyUp(shiftUp());
    detector.handleKeyDown(shiftDown());
    detector.handleKeyUp(shiftUp());

    expect(onTrigger).not.toHaveBeenCalled();
  });
});
