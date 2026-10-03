/**
 * IDEA tool window placement and stripe settings (ED-PARITY-024).
 *
 * IDEA's new UI docks every tool window at one of six anchors. Its stripe
 * button lives on the left stripe (left top / left bottom / bottom left) or
 * the right stripe (right top / right bottom / bottom right), and each side
 * area shows at most one window per anchor: two windows on the same side
 * split that area. Stripe width is user-resizable (40–100 px) while tool
 * window names are shown (ResizeStripeManager), 59 px when names are first
 * enabled.
 */

export type ToolWindowAnchor =
  | "left-top"
  | "left-bottom"
  | "bottom-left"
  | "bottom-right"
  | "right-top"
  | "right-bottom";

export const TOOL_WINDOW_ANCHORS: readonly ToolWindowAnchor[] = [
  "left-top",
  "left-bottom",
  "bottom-left",
  "bottom-right",
  "right-top",
  "right-bottom",
];

/** IDEA Move submenu labels, in IDEA's order. */
export const TOOL_WINDOW_ANCHOR_LABELS: Record<ToolWindowAnchor, string> = {
  "left-top": "Left Top",
  "left-bottom": "Left Bottom",
  "bottom-left": "Bottom Left",
  "bottom-right": "Bottom Right",
  "right-top": "Right Top",
  "right-bottom": "Right Bottom",
};

export type ToolWindowSide = "left" | "right" | "bottom";

export function anchorSide(anchor: ToolWindowAnchor): ToolWindowSide {
  return anchor.startsWith("left") ? "left" : anchor.startsWith("right") ? "right" : "bottom";
}

/** Which stripe carries the button (bottom windows split left/right stripes). */
export function anchorStripe(anchor: ToolWindowAnchor): "left" | "right" {
  return anchor === "left-top" || anchor === "left-bottom" || anchor === "bottom-left" ? "left" : "right";
}

/** Top group of a stripe = side windows; bottom group = bottom windows. */
export function anchorStripeGroup(anchor: ToolWindowAnchor): "top" | "bottom" {
  return anchor === "bottom-left" || anchor === "bottom-right" ? "bottom" : "top";
}

/** Secondary anchors split an area next to the primary one. */
export function isSecondaryAnchor(anchor: ToolWindowAnchor): boolean {
  return anchor === "left-bottom" || anchor === "right-bottom" || anchor === "bottom-right";
}

export function isToolWindowAnchor(value: unknown): value is ToolWindowAnchor {
  return typeof value === "string" && (TOOL_WINDOW_ANCHORS as readonly string[]).includes(value);
}

export interface ToolWindowLayoutV1 {
  version: 1;
  /** Only tool windows the user moved; others use their default anchor. */
  anchors: Record<string, ToolWindowAnchor>;
  /** Tool windows removed from the sidebar (IDEA "Remove from Sidebar"). */
  removed: string[];
  /**
   * Tool windows shown at least once. IDEA adds the stripe button of an
   * on-demand window (Find, hierarchies, coverage…) the first time it opens.
   */
  used?: string[];
}

const LAYOUT_KEY_PREFIX = "taomni.codeWorkspace.toolWindowLayout.v1";

export function emptyToolWindowLayout(): ToolWindowLayoutV1 {
  return { version: 1, anchors: {}, removed: [] };
}

function layoutKey(workspaceKey: string): string {
  return `${LAYOUT_KEY_PREFIX}:${workspaceKey}`;
}

export function readToolWindowLayout(workspaceKey: string): ToolWindowLayoutV1 {
  try {
    const raw = window.localStorage.getItem(layoutKey(workspaceKey));
    if (!raw) return emptyToolWindowLayout();
    const parsed = JSON.parse(raw) as Partial<ToolWindowLayoutV1>;
    const anchors: Record<string, ToolWindowAnchor> = {};
    for (const [id, anchor] of Object.entries(parsed.anchors ?? {})) {
      if (isToolWindowAnchor(anchor)) anchors[id] = anchor;
    }
    const removed = Array.isArray(parsed.removed)
      ? parsed.removed.filter((id): id is string => typeof id === "string")
      : [];
    const used = Array.isArray(parsed.used)
      ? parsed.used.filter((id): id is string => typeof id === "string")
      : [];
    return { version: 1, anchors, removed, used };
  } catch {
    return emptyToolWindowLayout();
  }
}

export function writeToolWindowLayout(workspaceKey: string, layout: ToolWindowLayoutV1): void {
  try {
    if (Object.keys(layout.anchors).length === 0 && layout.removed.length === 0 && !(layout.used?.length)) {
      window.localStorage.removeItem(layoutKey(workspaceKey));
      return;
    }
    window.localStorage.setItem(layoutKey(workspaceKey), JSON.stringify(layout));
  } catch {
    // Storage is a convenience; the in-memory layout still applies.
  }
}

export function resolveToolWindowAnchor(
  layout: ToolWindowLayoutV1,
  id: string,
  defaultAnchor: ToolWindowAnchor,
): ToolWindowAnchor {
  return layout.anchors[id] ?? defaultAnchor;
}

export function moveToolWindow(
  layout: ToolWindowLayoutV1,
  id: string,
  anchor: ToolWindowAnchor,
  defaultAnchor: ToolWindowAnchor,
): ToolWindowLayoutV1 {
  const anchors = { ...layout.anchors };
  if (anchor === defaultAnchor) delete anchors[id];
  else anchors[id] = anchor;
  return { ...layout, anchors, removed: layout.removed.filter((removedId) => removedId !== id) };
}

export function removeToolWindowFromSidebar(layout: ToolWindowLayoutV1, id: string): ToolWindowLayoutV1 {
  if (layout.removed.includes(id)) return layout;
  return { ...layout, removed: [...layout.removed, id] };
}

export function markToolWindowUsed(layout: ToolWindowLayoutV1, id: string): ToolWindowLayoutV1 {
  if (layout.used?.includes(id)) return layout;
  return { ...layout, used: [...(layout.used ?? []), id] };
}

export function restoreToolWindowToSidebar(layout: ToolWindowLayoutV1, id: string): ToolWindowLayoutV1 {
  if (!layout.removed.includes(id)) return layout;
  return { ...layout, removed: layout.removed.filter((removedId) => removedId !== id) };
}

/* ---------------------------------------------------------------------- */
/* Stripe settings (IDEA UISettings: SHOW_TOOL_WINDOW_NAMES, side widths)  */
/* ---------------------------------------------------------------------- */

export const STRIPE_MIN_WIDTH = 40;
export const STRIPE_MAX_WIDTH = 100;
/** IDEA ResizeStripeManager.applyShowNames: width when names are enabled. */
export const STRIPE_NAMED_DEFAULT_WIDTH = 59;
/** Icon-only stripe (names hidden). */
export const STRIPE_ICON_WIDTH = 40;

export interface ToolWindowStripeSettings {
  showNames: boolean;
  leftWidth: number;
  rightWidth: number;
}

const STRIPE_SETTINGS_KEY = "taomni.codeWorkspace.toolWindowStripes.v1";

export function clampStripeWidth(width: number): number {
  if (!Number.isFinite(width)) return STRIPE_NAMED_DEFAULT_WIDTH;
  return Math.max(STRIPE_MIN_WIDTH, Math.min(STRIPE_MAX_WIDTH, Math.round(width)));
}

export function defaultStripeSettings(): ToolWindowStripeSettings {
  return { showNames: true, leftWidth: STRIPE_NAMED_DEFAULT_WIDTH, rightWidth: STRIPE_NAMED_DEFAULT_WIDTH };
}

export function readStripeSettings(): ToolWindowStripeSettings {
  try {
    const raw = window.localStorage.getItem(STRIPE_SETTINGS_KEY);
    if (!raw) return defaultStripeSettings();
    const parsed = JSON.parse(raw) as Partial<ToolWindowStripeSettings>;
    return {
      showNames: typeof parsed.showNames === "boolean" ? parsed.showNames : true,
      leftWidth: clampStripeWidth(typeof parsed.leftWidth === "number" ? parsed.leftWidth : STRIPE_NAMED_DEFAULT_WIDTH),
      rightWidth: clampStripeWidth(typeof parsed.rightWidth === "number" ? parsed.rightWidth : STRIPE_NAMED_DEFAULT_WIDTH),
    };
  } catch {
    return defaultStripeSettings();
  }
}

export function writeStripeSettings(settings: ToolWindowStripeSettings): void {
  try {
    window.localStorage.setItem(STRIPE_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage failures.
  }
}

/** Rendered stripe width: icon-only when names are hidden (not resizable). */
export function effectiveStripeWidth(settings: ToolWindowStripeSettings, side: "left" | "right"): number {
  if (!settings.showNames) return STRIPE_ICON_WIDTH;
  return clampStripeWidth(side === "left" ? settings.leftWidth : settings.rightWidth);
}
