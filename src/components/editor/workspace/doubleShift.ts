/**
 * IDEA-style double-Shift detector: two clean Shift taps (no other key or
 * modifier in between) within the time window trigger the callback.
 */
export interface DoubleShiftDetector {
  handleKeyDown(event: KeyboardEvent): void;
  handleKeyUp(event: KeyboardEvent): void;
  /** Any pointer press between two Shift taps cancels the gesture, like IDEA. */
  handlePointerDown(): void;
}

export function createDoubleShiftDetector(
  onTrigger: () => void,
  windowMs = 400,
  now: () => number = () => Date.now(),
): DoubleShiftDetector {
  let pureShiftPress = false;
  let lastTapAt: number | null = null;

  return {
    handlePointerDown() {
      pureShiftPress = false;
      lastTapAt = null;
    },
    handleKeyDown(event: KeyboardEvent) {
      if (
        event.key === "Shift" &&
        !event.repeat &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey
      ) {
        pureShiftPress = true;
        return;
      }
      pureShiftPress = false;
      lastTapAt = null;
    },
    handleKeyUp(event: KeyboardEvent) {
      if (event.key !== "Shift") return;
      if (!pureShiftPress) {
        lastTapAt = null;
        return;
      }
      pureShiftPress = false;
      const at = now();
      if (lastTapAt !== null && at - lastTapAt <= windowMs) {
        lastTapAt = null;
        onTrigger();
        return;
      }
      lastTapAt = at;
    },
  };
}
