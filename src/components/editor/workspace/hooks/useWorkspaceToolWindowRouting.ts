import { useCallback, useRef } from "react";
import { type PanelImperativeHandle } from "react-resizable-panels";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore, type BottomDockTabId, type RightPaneTabId } from "../../../../stores/codeWorkspaceStore";
import { WORKSPACE_TOOL_WINDOW_LAYOUT_ENTRIES } from "../controller/model";
import { useToolWindowNodes } from "../panels/ToolWindowHost";
import { useToolWindowLayout } from "../useToolWindowLayout";


export interface UseWorkspaceToolWindowRoutingContext {
  patchWorkspaceUi: (instanceId: string, patch: Partial<import("../../../../stores/codeWorkspaceStore").CodeWorkspaceInstanceUi>) => void;
  workspaceInstanceId: string;
  languagePanelOpen: boolean;
  bottomDockOpen: boolean;
  bottomDockTab: BottomDockTabId;
  rightPaneOpenStored: boolean;
  rightPaneTab: RightPaneTabId;
}

export function useWorkspaceToolWindowRouting(context: UseWorkspaceToolWindowRoutingContext) {
  const { patchWorkspaceUi, workspaceInstanceId, languagePanelOpen, bottomDockOpen, bottomDockTab, rightPaneOpenStored, rightPaneTab } = context;

  const setBottomDockOpenRaw = useCallback((open: boolean) => {
    patchWorkspaceUi(workspaceInstanceId, { bottomDockOpen: open });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setBottomDockTabRaw = useCallback((tab: string) => {
    patchWorkspaceUi(workspaceInstanceId, { bottomDockTab: tab as BottomDockTabId });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setLanguagePanelOpen = useCallback((open: boolean | ((prev: boolean) => boolean)) => {
    const prev = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId).languagePanelOpen;
    patchWorkspaceUi(workspaceInstanceId, {
      languagePanelOpen: typeof open === "function" ? open(prev) : open,
    });
  }, [patchWorkspaceUi, workspaceInstanceId]);

  // ED-PARITY-024: IDEA tool window placement. Project and the bottom-left
  // dock keep their persisted flags; moved windows (and Structure/Docs) live
  // in the layout controller. Legacy "open the dock on tab X" call sites are
  // routed to X's current anchor below.
  const toolWindowLayout = useToolWindowLayout(
    workspaceInstanceId,
    WORKSPACE_TOOL_WINDOW_LAYOUT_ENTRIES,
    {
      projectOpen: languagePanelOpen,
      setProjectOpen: (open) => setLanguagePanelOpen(open),
      bottomDockOpen,
      bottomDockTab,
      setBottomDockOpen: setBottomDockOpenRaw,
      setBottomDockTab: setBottomDockTabRaw,
    },
    rightPaneOpenStored ? [rightPaneTab === "documentation" ? "documentation" : "structure"] : [],
  );
  const toolWindowLayoutRef = useRef(toolWindowLayout);
  toolWindowLayoutRef.current = toolWindowLayout;
  const toolWindowNodes = useToolWindowNodes();
  const leftToolAreaOpen = toolWindowLayout.sideOpen("left");
  const rightToolAreaOpen = toolWindowLayout.sideOpen("right");
  /** A routed tab request suppresses the dock open that accompanies it. */
  const routedDockRequestRef = useRef<{ tab: string; dockWasOpen: boolean; } | null>(null);
  const pendingDockOpenRef = useRef<{ tab: string; dockWasOpen: boolean; } | null>(null);
  const setBottomDockOpen = useCallback((open: boolean | ((prev: boolean) => boolean)) => {
    const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
    const next = typeof open === "function" ? open(ui.bottomDockOpen) : open;
    if (next && routedDockRequestRef.current) return;
    if (next && !ui.bottomDockOpen) {
      // The tab request of the same call site may follow; remember that the
      // dock was closed so a routed tab can undo this open.
      const request = { tab: "", dockWasOpen: false };
      pendingDockOpenRef.current = request;
      queueMicrotask(() => {
        if (pendingDockOpenRef.current === request) pendingDockOpenRef.current = null;
      });
    }
    setBottomDockOpenRaw(next);
  }, [setBottomDockOpenRaw, workspaceInstanceId]);
  const setBottomDockTab = useCallback((tab: BottomDockTabId | ((prev: BottomDockTabId) => BottomDockTabId)) => {
    const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
    const next = typeof tab === "function" ? tab(ui.bottomDockTab) : tab;
    const layout = toolWindowLayoutRef.current;
    if (layout.anchorOf(next) !== "bottom-left") {
      // A dock open issued just before this request (same call site) is undone.
      if (pendingDockOpenRef.current) {
        pendingDockOpenRef.current = null;
        setBottomDockOpenRaw(false);
      }
      const request = { tab: next, dockWasOpen: ui.bottomDockOpen };
      routedDockRequestRef.current = request;
      queueMicrotask(() => {
        if (routedDockRequestRef.current === request) routedDockRequestRef.current = null;
      });
      layout.show(next);
      return;
    }
    setBottomDockTabRaw(next);
  }, [setBottomDockOpenRaw, setBottomDockTabRaw, workspaceInstanceId]);
  const rightPanelRef = useRef<PanelImperativeHandle>(null);
  const lastRightPanelSizeRef = useRef(20);
  /** Legacy right-pane API (Outline / Documentation) mapped onto tool windows. */
  const rightPaneTabRef = useRef<RightPaneTabId>(rightPaneTab);
  const setRightPaneOpen = useCallback((open: boolean | ((prev: boolean) => boolean)) => {
    const layout = toolWindowLayoutRef.current;
    const tool = rightPaneTabRef.current === "documentation" ? "documentation" : "structure";
    const next = typeof open === "function" ? open(layout.isVisible(tool)) : open;
    if (next) layout.show(tool);
    else layout.hide(tool);
    patchWorkspaceUi(workspaceInstanceId, { rightPaneOpen: next });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  const setRightPaneTab = useCallback((tab: RightPaneTabId) => {
    const layout = toolWindowLayoutRef.current;
    const previous = rightPaneTabRef.current === "documentation" ? "documentation" : "structure";
    const nextTool = tab === "documentation" ? "documentation" : "structure";
    rightPaneTabRef.current = tab;
    if (previous !== nextTool && layout.isVisible(previous)) layout.show(nextTool);
    patchWorkspaceUi(workspaceInstanceId, { rightPaneTab: tab });
  }, [patchWorkspaceUi, workspaceInstanceId]);
  // Readers of the legacy flag see whether the right-pane tool is visible.
  const rightPaneOpen = toolWindowLayout.isVisible(rightPaneTab === "documentation" ? "documentation" : "structure");
  void rightPaneOpenStored;
  return { setBottomDockTab, setBottomDockOpen, rightPaneOpen, setLanguagePanelOpen, setRightPaneTab, setRightPaneOpen, leftToolAreaOpen, toolWindowLayoutRef, rightPaneTabRef, rightPanelRef, rightToolAreaOpen, lastRightPanelSizeRef, toolWindowLayout, toolWindowNodes };
}
