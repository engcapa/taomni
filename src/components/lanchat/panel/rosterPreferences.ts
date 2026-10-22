import { type LanEdgeSide } from "../../../stores/lanChatStore";

export const ROSTER_WIDTH_KEY = "taomni.lanchat.rosterWidth.v1";

export const ROSTER_COLLAPSED_KEY = "taomni.lanchat.rosterCollapsed.v1";

export const ROSTER_DEFAULT_WIDTH = 236;

export const ROSTER_MIN_WIDTH = 156;

export const ROSTER_MAX_WIDTH = 560;

export const ROSTER_COLLAPSE_WIDTH = 132;

export function clampRosterWidth(width: number): number {
  return Math.max(ROSTER_MIN_WIDTH, Math.min(ROSTER_MAX_WIDTH, Math.round(width)));
}

export function loadRosterWidth(): number {
  try {
    const raw = window.localStorage.getItem(ROSTER_WIDTH_KEY);
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? clampRosterWidth(parsed) : ROSTER_DEFAULT_WIDTH;
  } catch {
    return ROSTER_DEFAULT_WIDTH;
  }
}

export function loadRosterCollapsed(): boolean {
  try {
    return window.localStorage.getItem(ROSTER_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function nearestWindowEdge(clientX: number, clientY: number): LanEdgeSide {
  const width = window.innerWidth || 1;
  const height = window.innerHeight || 1;
  const distances: Array<[LanEdgeSide, number]> = [
    ["left", clientX],
    ["right", width - clientX],
    ["top", clientY],
    ["bottom", height - clientY],
  ];
  distances.sort((a, b) => a[1] - b[1]);
  return distances[0][0];
}

export function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("button,a,input,select,textarea,[role='button']"));
}
