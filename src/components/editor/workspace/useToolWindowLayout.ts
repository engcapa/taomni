import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  TOOL_WINDOW_ANCHORS,
  anchorSide,
  effectiveStripeWidth,
  markToolWindowUsed,
  moveToolWindow,
  readStripeSettings,
  readToolWindowLayout,
  removeToolWindowFromSidebar,
  restoreToolWindowToSidebar,
  resolveToolWindowAnchor,
  writeStripeSettings,
  writeToolWindowLayout,
  type ToolWindowAnchor,
  type ToolWindowLayoutV1,
  type ToolWindowSide,
  type ToolWindowStripeSettings,
} from "./toolWindowLayout";

/** Tool windows whose visibility lives in legacy workspace state. */
export interface LegacyToolWindowState {
  /** "project" visible (store `languagePanelOpen`). */
  projectOpen: boolean;
  setProjectOpen: (open: boolean) => void;
  /** Bottom-left dock (store `bottomDockOpen` / `bottomDockTab`). */
  bottomDockOpen: boolean;
  bottomDockTab: string;
  setBottomDockOpen: (open: boolean) => void;
  setBottomDockTab: (tab: string) => void;
}

export interface ToolWindowLayoutEntry {
  id: string;
  defaultAnchor: ToolWindowAnchor;
  /** Bottom-dock tools use the legacy dock state while docked bottom-left. */
  bottomDock?: boolean;
  /** IDEA on-demand window: no stripe button until first shown. */
  hiddenUntilUsed?: boolean;
}

export interface ToolWindowLayoutController {
  layout: ToolWindowLayoutV1;
  stripes: ToolWindowStripeSettings;
  stripeWidth: (side: "left" | "right") => number;
  setStripeWidth: (side: "left" | "right", width: number) => void;
  toggleShowNames: () => void;
  anchorOf: (id: string) => ToolWindowAnchor;
  isVisible: (id: string) => boolean;
  visibleAt: (anchor: ToolWindowAnchor) => string | null;
  sideOpen: (side: ToolWindowSide) => boolean;
  show: (id: string) => void;
  hide: (id: string) => void;
  /** Hide every tool window on one side (drag-collapse of an area). */
  hideSide: (side: ToolWindowSide) => void;
  move: (id: string, anchor: ToolWindowAnchor) => void;
  removeFromSidebar: (id: string) => void;
  restoreToSidebar: (id: string) => void;
  isRemoved: (id: string) => boolean;
  /** Whether the stripe carries a button for this window. */
  onStripe: (id: string) => boolean;
  restoreDefaultLayout: () => void;
}

/**
 * ED-PARITY-024: one owner for "where is each tool window and which one is
 * visible". Project and the bottom-left dock keep their persisted workspace
 * flags (every existing entry point keeps working); every other placement is
 * tracked here per anchor. Showing a window hides the one sharing its anchor,
 * like IDEA.
 */
export function useToolWindowLayout(
  workspaceKey: string,
  entries: readonly ToolWindowLayoutEntry[],
  legacy: LegacyToolWindowState,
  /** Non-legacy windows restored as visible (e.g. a persisted right pane). */
  initiallyVisible: readonly string[] = [],
): ToolWindowLayoutController {
  const [layout, setLayout] = useState<ToolWindowLayoutV1>(() => readToolWindowLayout(workspaceKey));
  const [stripes, setStripes] = useState<ToolWindowStripeSettings>(readStripeSettings);
  const [slots, setSlots] = useState<Partial<Record<ToolWindowAnchor, string | null>>>(() => {
    const restored = readToolWindowLayout(workspaceKey);
    const initial: Partial<Record<ToolWindowAnchor, string | null>> = {};
    for (const id of initiallyVisible) {
      const entry = entries.find((candidate) => candidate.id === id);
      if (!entry || entry.id === "project") continue;
      const anchor = resolveToolWindowAnchor(restored, id, entry.defaultAnchor);
      if (entry.bottomDock && anchor === "bottom-left") continue;
      initial[anchor] = id;
    }
    return initial;
  });

  const layoutKeyRef = useRef(workspaceKey);
  useEffect(() => {
    if (layoutKeyRef.current === workspaceKey) return;
    layoutKeyRef.current = workspaceKey;
    setLayout(readToolWindowLayout(workspaceKey));
    setSlots({});
  }, [workspaceKey]);

  const entryById = useMemo(() => new Map(entries.map((entry) => [entry.id, entry])), [entries]);
  const legacyRef = useRef(legacy);
  legacyRef.current = legacy;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const slotsRef = useRef(slots);
  slotsRef.current = slots;

  const anchorOf = useCallback((id: string): ToolWindowAnchor => {
    const entry = entryById.get(id);
    return resolveToolWindowAnchor(layoutRef.current, id, entry?.defaultAnchor ?? "bottom-left");
  }, [entryById]);

  const usesDock = useCallback((id: string) => (
    !!entryById.get(id)?.bottomDock && anchorOf(id) === "bottom-left"
  ), [anchorOf, entryById]);

  const isVisibleWith = useCallback((
    id: string,
    currentSlots: Partial<Record<ToolWindowAnchor, string | null>>,
    current: LegacyToolWindowState,
  ): boolean => {
    if (id === "project") return current.projectOpen;
    if (usesDock(id)) return current.bottomDockOpen && current.bottomDockTab === id;
    return currentSlots[anchorOf(id)] === id;
  }, [anchorOf, usesDock]);

  const isVisible = useCallback(
    (id: string) => isVisibleWith(id, slots, legacy),
    [isVisibleWith, legacy, slots],
  );

  const visibleAt = useCallback((anchor: ToolWindowAnchor): string | null => {
    for (const entry of entries) {
      if (anchorOf(entry.id) === anchor && isVisibleWith(entry.id, slots, legacy)) return entry.id;
    }
    return null;
  }, [anchorOf, entries, isVisibleWith, legacy, slots]);

  const sideOpen = useCallback((side: ToolWindowSide) => (
    TOOL_WINDOW_ANCHORS.some((anchor) => anchorSide(anchor) === side && visibleAt(anchor) !== null)
  ), [visibleAt]);

  const hideNow = useCallback((id: string) => {
    const current = legacyRef.current;
    if (id === "project") {
      if (current.projectOpen) current.setProjectOpen(false);
      return;
    }
    if (usesDock(id)) {
      if (current.bottomDockOpen && current.bottomDockTab === id) current.setBottomDockOpen(false);
      return;
    }
    const anchor = anchorOf(id);
    if (slotsRef.current[anchor] === id) {
      const next = { ...slotsRef.current, [anchor]: null };
      slotsRef.current = next;
      setSlots(next);
    }
  }, [anchorOf, usesDock]);

  const show = useCallback((id: string) => {
    const entry = entryById.get(id);
    const currentLayout = layoutRef.current;
    let nextLayout = currentLayout;
    if (entry?.hiddenUntilUsed) nextLayout = markToolWindowUsed(nextLayout, id);
    // Activating a removed window puts its button back (IDEA).
    if (nextLayout.removed.includes(id)) nextLayout = restoreToolWindowToSidebar(nextLayout, id);
    if (nextLayout !== currentLayout) {
      layoutRef.current = nextLayout;
      setLayout(nextLayout);
      writeToolWindowLayout(workspaceKey, nextLayout);
    }
    const anchor = anchorOf(id);
    const targetUsesDock = usesDock(id);
    // IDEA: one visible window per anchor; showing replaces its neighbour.
    // Dock tools replace each other by switching the dock tab instead.
    for (const entry of entries) {
      if (entry.id === id || anchorOf(entry.id) !== anchor) continue;
      if (targetUsesDock && usesDock(entry.id)) continue;
      if (isVisibleWith(entry.id, slotsRef.current, legacyRef.current)) hideNow(entry.id);
    }
    const current = legacyRef.current;
    if (id === "project") {
      current.setProjectOpen(true);
      return;
    }
    if (targetUsesDock) {
      current.setBottomDockTab(id);
      current.setBottomDockOpen(true);
      return;
    }
    if (slotsRef.current[anchor] !== id) {
      const next = { ...slotsRef.current, [anchor]: id };
      slotsRef.current = next;
      setSlots(next);
    }
  }, [anchorOf, entries, entryById, hideNow, isVisibleWith, usesDock, workspaceKey]);

  const hideSide = useCallback((side: ToolWindowSide) => {
    for (const entry of entries) {
      if (anchorSide(anchorOf(entry.id)) !== side) continue;
      if (isVisibleWith(entry.id, slotsRef.current, legacyRef.current)) hideNow(entry.id);
    }
  }, [anchorOf, entries, hideNow, isVisibleWith]);

  const persist = useCallback((next: ToolWindowLayoutV1) => {
    layoutRef.current = next;
    setLayout(next);
    writeToolWindowLayout(workspaceKey, next);
  }, [workspaceKey]);

  const move = useCallback((id: string, anchor: ToolWindowAnchor) => {
    const entry = entryById.get(id);
    if (!entry || anchorOf(id) === anchor) return;
    const wasVisible = isVisibleWith(id, slotsRef.current, legacyRef.current);
    if (wasVisible) hideNow(id);
    persist(moveToolWindow(layoutRef.current, id, anchor, entry.defaultAnchor));
    // layoutRef already holds the new anchor, so show() docks it there.
    if (wasVisible) show(id);
  }, [anchorOf, entryById, hideNow, isVisibleWith, persist, show]);

  const removeFromSidebar = useCallback((id: string) => {
    if (isVisibleWith(id, slotsRef.current, legacyRef.current)) hideNow(id);
    persist(removeToolWindowFromSidebar(layoutRef.current, id));
  }, [hideNow, isVisibleWith, persist]);

  const restoreToSidebar = useCallback((id: string) => {
    persist(restoreToolWindowToSidebar(layoutRef.current, id));
  }, [persist]);

  const isRemoved = useCallback((id: string) => layout.removed.includes(id), [layout.removed]);
  const onStripe = useCallback((id: string) => {
    if (layout.removed.includes(id)) return false;
    const entry = entryById.get(id);
    if (!entry?.hiddenUntilUsed) return true;
    return !!layout.used?.includes(id) || isVisibleWith(id, slots, legacy);
  }, [entryById, isVisibleWith, layout.removed, layout.used, legacy, slots]);

  const restoreDefaultLayout = useCallback(() => {
    for (const entry of entries) {
      if (anchorOf(entry.id) !== entry.defaultAnchor && isVisibleWith(entry.id, slotsRef.current, legacyRef.current)) {
        hideNow(entry.id);
      }
    }
    persist({ version: 1, anchors: {}, removed: [], used: layoutRef.current.used ?? [] });
  }, [anchorOf, entries, hideNow, isVisibleWith, persist]);

  const setStripeWidth = useCallback((side: "left" | "right", width: number) => {
    setStripes((current) => {
      const next = side === "left" ? { ...current, leftWidth: width } : { ...current, rightWidth: width };
      writeStripeSettings(next);
      return next;
    });
  }, []);
  const toggleShowNames = useCallback(() => {
    setStripes((current) => {
      const next = { ...current, showNames: !current.showNames };
      writeStripeSettings(next);
      return next;
    });
  }, []);

  const stripeWidth = useCallback((side: "left" | "right") => effectiveStripeWidth(stripes, side), [stripes]);

  return {
    layout,
    stripes,
    stripeWidth,
    setStripeWidth,
    toggleShowNames,
    anchorOf,
    isVisible,
    visibleAt,
    sideOpen,
    show,
    hide: hideNow,
    hideSide,
    move,
    removeFromSidebar,
    restoreToSidebar,
    isRemoved,
    onStripe,
    restoreDefaultLayout,
  };
}
