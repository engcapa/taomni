import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type PanelImperativeHandle, type PanelSize } from "react-resizable-panels";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore, type BottomDockTabId, type RightPaneTabId } from "../../../../stores/codeWorkspaceStore";
import { BOTTOM_DOCK_MIN_HEIGHT, BOTTOM_DOCK_MAX_HEIGHT } from "../panels/BottomDock";

export interface UseWorkspaceToolWindowsContext {
  setLanguagePanelOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  projectPanelRef: import("react").RefObject<PanelImperativeHandle | null>;
  leftToolAreaOpen: boolean;
  lastProjectPanelSizeRef: import("react").RefObject<number>;
  toolWindowLayoutRef: import("react").RefObject<import("../useToolWindowLayout").ToolWindowLayoutController>;
  rootRef: import("react").RefObject<HTMLDivElement | null>;
  workspaceUi: import("../../../../stores/codeWorkspaceStore").CodeWorkspaceInstanceUi;
  bottomDockTab: BottomDockTabId;
  setBottomDockHeightForTool: (instanceId: string, toolId: BottomDockTabId, height: number) => void;
  workspaceInstanceId: string;
  treePaneRef: import("react").RefObject<HTMLElement | null>;
  rightPaneTabRef: import("react").RefObject<RightPaneTabId>;
  handleReturnToEditor: () => void;
  restoreDefaultToolWindowLayout: (instanceId: string) => void;
  setStatusMessage: (message: string) => void;
  bottomDockOpen: boolean;
  rightPaneOpen: boolean;
  rightPaneTab: RightPaneTabId;
  setRightPaneTab: (tab: RightPaneTabId) => void;
  setRightPaneOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  setBottomDockTab: (tab: BottomDockTabId | ((prev: BottomDockTabId) => BottomDockTabId)) => void;
  setBottomDockOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  rightPanelRef: import("react").RefObject<PanelImperativeHandle | null>;
  rightToolAreaOpen: boolean;
  lastRightPanelSizeRef: import("react").RefObject<number>;
}

export function useWorkspaceToolWindows(context: UseWorkspaceToolWindowsContext) {
  const {
    setLanguagePanelOpen,
    projectPanelRef,
    leftToolAreaOpen,
    lastProjectPanelSizeRef,
    toolWindowLayoutRef,
    rootRef,
    workspaceUi,
    bottomDockTab,
    setBottomDockHeightForTool,
    workspaceInstanceId,
    treePaneRef,
    rightPaneTabRef,
    handleReturnToEditor,
    restoreDefaultToolWindowLayout,
    setStatusMessage,
    bottomDockOpen,
    rightPaneOpen,
    rightPaneTab,
    setRightPaneTab,
    setRightPaneOpen,
    setBottomDockTab,
    setBottomDockOpen,
    rightPanelRef,
    rightToolAreaOpen,
    lastRightPanelSizeRef,
  } = context;

  const toggleProjectTree = useCallback(() => {
    setLanguagePanelOpen((open) => !open);
  }, [setLanguagePanelOpen]);

  // Keep the resizable project panel in sync with the persisted open flag.
  // Drag-to-min collapses via onResize; toolbar / Alt+1 toggles go through this effect.
  useEffect(() => {
    const panel = projectPanelRef.current;
    if (!panel) return;
    const frame = requestAnimationFrame(() => {
      if (!leftToolAreaOpen) {
        panel.collapse();
      } else {
        panel.resize(`${lastProjectPanelSizeRef.current}px`);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [leftToolAreaOpen]);

  const handleProjectPanelResize = useCallback((size: PanelSize) => {
    const pixels = size.inPixels > 0 ? Math.round(size.inPixels) : 0;
    if (pixels > 40) {
      // Only record the live width here. Writing it to the store on every
      // pointer move re-renders the shell, changes the Panel's `defaultSize`
      // and kills the in-flight drag session inside react-resizable-panels;
      // persistence happens on release via the group's onLayoutChanged.
      lastProjectPanelSizeRef.current = pixels;
    }
    // Dragging the area closed hides its tool windows; dragging it open
    // shows Project (IDEA restores the last left window).
    const next = size.asPercentage > 2 && (pixels > 40 || size.inPixels === 0);
    const layout = toolWindowLayoutRef.current;
    const areaOpen = layout.sideOpen("left");
    if (next === areaOpen) return;
    if (!next) layout.hideSide("left");
    else layout.show(layout.visibleAt("left-top") ?? "project");
  }, []);

  const [workspaceContainerHeight, setWorkspaceContainerHeight] = useState<number>(() => {
    return typeof window !== "undefined" ? window.innerHeight : 800;
  });

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setWorkspaceContainerHeight(entry.contentRect.height);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const maxBottomDockHeight = useMemo(() => {
    // 40px top toolbar header + 37px minimum reserved editor sliver = 77px
    const available = Math.max(BOTTOM_DOCK_MIN_HEIGHT, workspaceContainerHeight - 77);
    return Math.min(BOTTOM_DOCK_MAX_HEIGHT, available);
  }, [workspaceContainerHeight]);

  const currentBottomDockHeight = useMemo(() => {
    const chrome = workspaceUi.shellChromeState;
    if (!chrome) return 323;
    if (chrome.bottomHeightByTool && bottomDockTab in chrome.bottomHeightByTool) {
      return chrome.bottomHeightByTool[bottomDockTab] ?? 323;
    }
    return chrome.bottomHeightPx ?? 323;
  }, [workspaceUi.shellChromeState, bottomDockTab]);

  const handleBottomDockHeightChange = useCallback((height: number) => {
    setBottomDockHeightForTool(workspaceInstanceId, bottomDockTab, height);
  }, [bottomDockTab, setBottomDockHeightForTool, workspaceInstanceId]);

  const focusToolWindowSoon = useCallback((toolId: string) => {
    requestAnimationFrame(() => {
      if (toolId === "project") {
        treePaneRef.current?.focus();
        return;
      }
      const pane = document.querySelector(`[data-testid="code-workspace-tool-window-${toolId}"]`);
      const target = pane?.querySelector<HTMLElement>('[data-tool-window-content] [tabindex="0"], [data-tool-window-content] button, [data-tool-window-content] input, [data-tool-window-content] textarea')
        ?? pane?.querySelector<HTMLElement>("button");
      target?.focus();
    });
  }, []);

  /**
   * IDEA Activate<Tool>Window (Alt+N, stripe clicks): a hidden window is
   * shown at its anchor and focused; a visible unfocused one takes focus; a
   * focused one hides and returns focus to the editor.
   */
  const handleActivateToolWindow = useCallback((requestedId: string) => {
    const toolId = requestedId === "outline" ? "structure" : requestedId;
    const layout = toolWindowLayoutRef.current;
    const pane = toolId === "project"
      ? treePaneRef.current
      : document.querySelector(`[data-testid="code-workspace-tool-window-${toolId}"]`);
    const hasFocus = !!pane && pane.contains(document.activeElement);
    if (!layout.isVisible(toolId)) {
      if (toolId === "structure") rightPaneTabRef.current = "outline";
      if (toolId === "documentation") rightPaneTabRef.current = "documentation";
      layout.show(toolId);
      focusToolWindowSoon(toolId);
    } else if (hasFocus) {
      layout.hide(toolId);
      handleReturnToEditor();
    } else {
      focusToolWindowSoon(toolId);
    }
  }, [focusToolWindowSoon, handleReturnToEditor]);

  const handleRestoreToolWindowLayout = useCallback(() => {
    // IDEA Window | Restore Default Layout: default anchors, Project only.
    toolWindowLayoutRef.current.restoreDefaultLayout();
    toolWindowLayoutRef.current.hideSide("right");
    toolWindowLayoutRef.current.hide("structure");
    restoreDefaultToolWindowLayout(workspaceInstanceId);
    lastProjectPanelSizeRef.current = 452;
    try {
      projectPanelRef.current?.resize("452px");
    } catch {
      // ignore
    }
    requestAnimationFrame(() => {
      handleReturnToEditor();
    });
    setStatusMessage("Restored default tool window layout");
  }, [handleReturnToEditor, restoreDefaultToolWindowLayout, setStatusMessage, workspaceInstanceId]);

  // ED-PARITY-013 DEC-013-05: IDEA F12 / Shift+Esc / Ctrl+Shift+F12. The last
  // tool window is the most recently opened one; Project is the fallback.
  const lastToolWindowIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (bottomDockOpen) lastToolWindowIdRef.current = bottomDockTab;
  }, [bottomDockOpen, bottomDockTab]);
  useEffect(() => {
    if (rightPaneOpen && rightPaneTab === "outline") lastToolWindowIdRef.current = "structure";
  }, [rightPaneOpen, rightPaneTab]);
  const hiddenToolWindowsRef = useRef<{ project: boolean; bottom: boolean; right: boolean } | null>(null);

  const focusBottomDockSoon = useCallback(() => {
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(
        '[data-testid="code-workspace-bottom-dock"] [tabindex="0"], [data-testid="code-workspace-bottom-dock"] button, [data-testid="code-workspace-bottom-dock"] input',
      );
      el?.focus();
    });
  }, []);

  const jumpToLastToolWindow = useCallback(() => {
    const toolId = lastToolWindowIdRef.current ?? "project";
    hiddenToolWindowsRef.current = null;
    if (toolId === "project") {
      setLanguagePanelOpen(true);
      requestAnimationFrame(() => treePaneRef.current?.focus());
      return;
    }
    if (toolId === "structure") {
      setRightPaneTab("outline");
      setRightPaneOpen(true);
      return;
    }
    setBottomDockTab(toolId as BottomDockTabId);
    setBottomDockOpen(true);
    focusBottomDockSoon();
  }, [focusBottomDockSoon, setBottomDockOpen, setBottomDockTab, setLanguagePanelOpen, setRightPaneOpen, setRightPaneTab]);

  const hideActiveToolWindow = useCallback((): boolean => {
    const active = document.activeElement;
    const bottomDock = document.querySelector('[data-testid="code-workspace-bottom-dock"]');
    const rightPane = document.querySelector('[data-testid="code-workspace-right-pane"]');
    const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
    let hid = false;
    if (active && treePaneRef.current?.contains(active)) {
      setLanguagePanelOpen(false);
      hid = true;
    } else if (active && bottomDock?.contains(active)) {
      setBottomDockOpen(false);
      hid = true;
    } else if (active && rightPane?.contains(active)) {
      setRightPaneOpen(false);
      hid = true;
    } else {
      // Editor focus: hide the last active tool window when it is open.
      const last = lastToolWindowIdRef.current;
      if (last === "structure" && ui.rightPaneOpen) {
        setRightPaneOpen(false);
        hid = true;
      } else if (last && last !== "project" && last !== "structure" && ui.bottomDockOpen) {
        setBottomDockOpen(false);
        hid = true;
      }
    }
    if (hid) {
      // IDEA moves focus to the editor as the tool window hides; the frame
      // retry covers a layout that was still settling.
      handleReturnToEditor();
      requestAnimationFrame(() => handleReturnToEditor());
    }
    return hid;
  }, [handleReturnToEditor, setBottomDockOpen, setLanguagePanelOpen, setRightPaneOpen, workspaceInstanceId]);

  const toggleAllToolWindows = useCallback(() => {
    const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
    const anyOpen = ui.languagePanelOpen || ui.bottomDockOpen || ui.rightPaneOpen;
    if (anyOpen) {
      hiddenToolWindowsRef.current = {
        project: ui.languagePanelOpen,
        bottom: ui.bottomDockOpen,
        right: ui.rightPaneOpen,
      };
      setLanguagePanelOpen(false);
      setBottomDockOpen(false);
      setRightPaneOpen(false);
      handleReturnToEditor();
      requestAnimationFrame(() => handleReturnToEditor());
      return;
    }
    const restore = hiddenToolWindowsRef.current;
    hiddenToolWindowsRef.current = null;
    if (!restore) return;
    if (restore.project) setLanguagePanelOpen(true);
    if (restore.bottom) setBottomDockOpen(true);
    if (restore.right) setRightPaneOpen(true);
  }, [handleReturnToEditor, setBottomDockOpen, setLanguagePanelOpen, setRightPaneOpen, workspaceInstanceId]);

  const toggleOutlinePane = useCallback(() => {
    if (rightPaneOpen && rightPaneTab === "outline") {
      setRightPaneOpen(false);
      return;
    }
    setRightPaneTab("outline");
    setRightPaneOpen(true);
  }, [rightPaneOpen, rightPaneTab, setRightPaneOpen, setRightPaneTab]);

  // Keep the resizable right pane panel in sync with the persisted open flag.
  // Follows the same collapse/expand pattern as the project tree panel.
  useEffect(() => {
    const panel = rightPanelRef.current;
    if (!panel) return;
    const frame = requestAnimationFrame(() => {
      if (!rightToolAreaOpen) {
        panel.collapse();
      } else {
        panel.resize(`${lastRightPanelSizeRef.current}%`);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [rightToolAreaOpen]);

  const handleRightPanelResize = useCallback((size: PanelSize) => {
    const percentage = size.asPercentage;
    if (percentage > 2) {
      lastRightPanelSizeRef.current = percentage;
    }
    const layout = toolWindowLayoutRef.current;
    const next = percentage > 2;
    if (next === layout.sideOpen("right")) return;
    if (!next) layout.hideSide("right");
  }, []);
  return {
    handleActivateToolWindow,
    handleRestoreToolWindowLayout,
    jumpToLastToolWindow,
    hideActiveToolWindow,
    toggleAllToolWindows,
    toggleOutlinePane,
    toggleProjectTree,
    currentBottomDockHeight,
    handleBottomDockHeightChange,
    maxBottomDockHeight,
    handleProjectPanelResize,
    handleRightPanelResize,
  };
}
