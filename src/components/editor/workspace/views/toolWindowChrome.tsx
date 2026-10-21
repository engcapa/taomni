import { type ReactNode } from "react";
import { type PanelImperativeHandle } from "react-resizable-panels";
import { type RightPaneTabId } from "../../../../stores/codeWorkspaceStore";
import type { MenuItem } from "../../../ContextMenu";
import { BOTTOM_DOCK_MIN_HEIGHT, type BottomDockTab } from "../panels/BottomDock";
import { MoreToolWindowsButton, type ToolWindowRailItem } from "../panels/ToolWindowRail";
import { ToolWindowPane, ToolWindowSlot, ToolWindowSplitArea } from "../panels/ToolWindowHost";
import { TOOL_WINDOW_ANCHORS, TOOL_WINDOW_ANCHOR_LABELS, anchorSide, type ToolWindowAnchor } from "../toolWindowLayout";

export interface CreateToolWindowChromeContext {
  toolWindowContents: { id: string; label: string; content: ReactNode; }[];
  toolWindowLayout: import("../useToolWindowLayout").ToolWindowLayoutController;
  currentBottomDockHeight: number;
  handleBottomDockHeightChange: (height: number) => void;
  maxBottomDockHeight: number;
  projectPanelRef: import("react").RefObject<PanelImperativeHandle | null>;
  rightPanelRef: import("react").RefObject<PanelImperativeHandle | null>;
  handleReturnToEditor: () => void;
  handleRestoreToolWindowLayout: () => void;
  toolWindowNodes: import("../panels/ToolWindowHost").ToolWindowNodes;
  leftToolRailItems: ToolWindowRailItem[];
  rightToolRailItems: ToolWindowRailItem[];
  bottomDockTabs: BottomDockTab[];
  rightPaneTabRef: import("react").RefObject<RightPaneTabId>;
}

export function createToolWindowChrome(context: CreateToolWindowChromeContext) {
  const {
    toolWindowContents,
    toolWindowLayout,
    currentBottomDockHeight,
    handleBottomDockHeightChange,
    maxBottomDockHeight,
    projectPanelRef,
    rightPanelRef,
    handleReturnToEditor,
    handleRestoreToolWindowLayout,
    toolWindowNodes,
    leftToolRailItems,
    rightToolRailItems,
    bottomDockTabs,
    rightPaneTabRef,
  } = context;
  const toolWindowLabel = (id: string) => toolWindowContents.find((entry) => entry.id === id)?.label ?? id;
  // IDEA tool window ⋮ Options: View Mode, Move to, Resize, Remove from
  // Sidebar (ToolWindowImpl.GearActionGroup), plus Hide / Restore Layout.
  const stretchToolWindow = (id: string, direction: "left" | "right" | "up" | "down" | "maximize") => {
    const side = anchorSide(toolWindowLayout.anchorOf(id));
    const step = 40;
    if (side === "bottom") {
      const current = currentBottomDockHeight;
      if (direction === "maximize") {
        handleBottomDockHeightChange(current >= maxBottomDockHeight - 1 ? BOTTOM_DOCK_MIN_HEIGHT + 250 : maxBottomDockHeight);
      } else if (direction === "up" || direction === "down") {
        handleBottomDockHeightChange(current + (direction === "up" ? step : -step));
      }
      return;
    }
    const panel = side === "left" ? projectPanelRef.current : rightPanelRef.current;
    if (!panel) return;
    const size = panel.getSize();
    const widen = side === "left" ? direction === "right" : direction === "left";
    const narrow = side === "left" ? direction === "left" : direction === "right";
    if (direction === "maximize") {
      panel.resize("70%");
      return;
    }
    if (!widen && !narrow) return;
    panel.resize(`${Math.max(120, Math.round(size.inPixels + (widen ? step : -step)))}px`);
  };
  const toolWindowOptionsItems = (id: string): MenuItem[] => {
    const anchor = toolWindowLayout.anchorOf(id);
    const side = anchorSide(anchor);
    return [
      {
        label: "View Mode",
        testId: "code-workspace-tool-window-view-mode",
        children: [
          { label: "Dock Pinned", checked: true, onClick: () => undefined },
          { label: "Dock Unpinned", disabled: true },
          { label: "Undock", disabled: true },
          { label: "Float", disabled: true },
          { label: "Window", disabled: true },
        ],
      },
      {
        label: "Move to",
        testId: "code-workspace-tool-window-move",
        children: TOOL_WINDOW_ANCHORS.map((target) => ({
          label: TOOL_WINDOW_ANCHOR_LABELS[target],
          testId: `code-workspace-tool-window-move-${target}`,
          checked: target === anchor,
          onClick: () => toolWindowLayout.move(id, target),
        })),
      },
      {
        label: "Resize",
        testId: "code-workspace-tool-window-resize",
        children: [
          { label: "Stretch to Left", disabled: side === "bottom", onClick: () => stretchToolWindow(id, "left") },
          { label: "Stretch to Right", disabled: side === "bottom", onClick: () => stretchToolWindow(id, "right") },
          { label: "Stretch to Top", disabled: side !== "bottom", onClick: () => stretchToolWindow(id, "up") },
          { label: "Stretch to Bottom", disabled: side !== "bottom", onClick: () => stretchToolWindow(id, "down") },
          { label: "", separator: true },
          { label: "Maximize Tool Window", onClick: () => stretchToolWindow(id, "maximize") },
        ],
      },
      { label: "", separator: true },
      {
        label: "Remove from Sidebar",
        testId: "code-workspace-tool-window-remove",
        onClick: () => {
          toolWindowLayout.removeFromSidebar(id);
          handleReturnToEditor();
        },
      },
      { label: "", separator: true },
      {
        label: "Hide",
        testId: "code-workspace-tool-window-options-hide",
        shortcut: "Shift+Esc",
        onClick: () => {
          toolWindowLayout.hide(id);
          handleReturnToEditor();
        },
      },
      {
        label: "Restore Default Layout",
        testId: "code-workspace-tool-window-options-restore",
        shortcut: "Shift+F12",
        onClick: handleRestoreToolWindowLayout,
      },
    ];
  };
  const renderToolWindowPane = (id: string, options: { legacyTestIds?: boolean } = {}) => {
    // Project keeps its own IDEA header (title, toolbar, ⋮, —) in FileTreePane.
    if (id === "project") {
      return <ToolWindowSlot nodes={toolWindowNodes} id="project" label="Project" />;
    }
    const title = toolWindowLabel(id);
    return (
      <ToolWindowPane
        nodes={toolWindowNodes}
        toolId={id}
        title={title}
        legacyTestIds={options.legacyTestIds}
        optionsItems={toolWindowOptionsItems(id)}
        onHide={() => {
          toolWindowLayout.hide(id);
          handleReturnToEditor();
        }}
      />
    );
  };
  // ED-PARITY-024 stripes: every tool window's button sits on the stripe of
  // its anchor (IDEA new UI), so a moved window's button moves with it.
  const stripeMeta = new Map<string, { label: string; icon: ReactNode; badge?: ReactNode; shortcut?: string }>();
  for (const item of [...leftToolRailItems, ...rightToolRailItems]) {
    stripeMeta.set(item.id, { label: item.id === "documentation" ? "Documentation" : item.label, icon: item.icon, shortcut: item.shortcut });
  }
  for (const tab of bottomDockTabs) stripeMeta.set(tab.id, { label: tab.label, icon: tab.icon, badge: tab.badge });
  const stripeToolIds = ["project", "structure", "documentation", ...bottomDockTabs.map((tab) => tab.id)];
  const toggleToolWindowFromStripe = (id: string) => {
    if (toolWindowLayout.isVisible(id)) {
      toolWindowLayout.hide(id);
      handleReturnToEditor();
      return;
    }
    if (id === "structure") rightPaneTabRef.current = "outline";
    if (id === "documentation") rightPaneTabRef.current = "documentation";
    toolWindowLayout.show(id);
  };
  const stripeItem = (id: string): ToolWindowRailItem | null => {
    const meta = stripeMeta.get(id);
    if (!meta || !toolWindowLayout.onStripe(id)) return null;
    const bottomTool = bottomDockTabs.some((tab) => tab.id === id);
    return {
      id,
      label: meta.label,
      icon: meta.icon,
      badge: meta.badge,
      shortcut: meta.shortcut,
      anchor: toolWindowLayout.anchorOf(id),
      active: toolWindowLayout.isVisible(id),
      testId: bottomTool ? `code-workspace-bottom-tab-${id}` : `code-workspace-tool-rail-${id}`,
      onSelect: () => toggleToolWindowFromStripe(id),
    };
  };
  const stripeItemsAt = (anchor: ToolWindowAnchor) => stripeToolIds
    .filter((id) => toolWindowLayout.anchorOf(id) === anchor)
    .map(stripeItem)
    .filter((item): item is ToolWindowRailItem => item !== null);
  const commitStripeItem = leftToolRailItems.find((item) => item.id === "commit");
  const leftStripeTop = [
    ...stripeItemsAt("left-top"),
    ...(commitStripeItem ? [{ ...commitStripeItem, active: toolWindowLayout.isVisible("git") }] : []),
    ...stripeItemsAt("left-bottom"),
  ];
  const rightStripeTop = [...stripeItemsAt("right-top"), ...stripeItemsAt("right-bottom")];
  const stripeCallbacks = {
    showNames: toolWindowLayout.stripes.showNames,
    onToggleShowNames: toolWindowLayout.toggleShowNames,
    onMove: toolWindowLayout.move,
    onHide: (id: string) => {
      toolWindowLayout.hide(id);
      handleReturnToEditor();
    },
    onRemoveFromSidebar: (id: string) => toolWindowLayout.removeFromSidebar(id),
  };
  const moreToolWindowsButton = (
    <MoreToolWindowsButton
      tools={stripeToolIds.map((id) => ({ id, label: stripeMeta.get(id)?.label ?? id, icon: stripeMeta.get(id)?.icon }))}
      onPick={(id) => {
        toolWindowLayout.restoreToSidebar(id);
        if (!toolWindowLayout.isVisible(id)) toggleToolWindowFromStripe(id);
      }}
    />
  );
  const renderToolWindowSideArea = (side: "left" | "right") => {
    const primary = toolWindowLayout.visibleAt(side === "left" ? "left-top" : "right-top");
    const secondary = toolWindowLayout.visibleAt(side === "left" ? "left-bottom" : "right-bottom");
    return (
      <ToolWindowSplitArea
        side={side}
        primary={primary ? renderToolWindowPane(primary) : null}
        secondary={secondary ? renderToolWindowPane(secondary) : null}
      />
    );
  };
  return {
    toolWindowOptionsItems,
    leftStripeTop,
    stripeItemsAt,
    moreToolWindowsButton,
    stripeCallbacks,
    renderToolWindowSideArea,
    renderToolWindowPane,
    rightStripeTop,
  };
}
