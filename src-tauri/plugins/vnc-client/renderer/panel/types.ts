import type { VncPointerState } from "../vncPointerScheduler";
export type DelayedPointerDown = {
  pointerId: number;
  down: VncPointerState;
  up: VncPointerState | null;
};
