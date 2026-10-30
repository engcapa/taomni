import { AlertTriangle } from "lucide-react";
import { createPortal } from "react-dom";
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle, type PanelImperativeHandle } from "react-resizable-panels";
import { type BottomDockTabId } from "../../../../stores/codeWorkspaceStore";
import { WorkspaceObservationBoundary } from "../WorkspaceObservationBoundary";
import { useWorkspaceClipboard } from "../hooks/useWorkspaceClipboard";
import { useWorkspaceEditorCommands } from "../hooks/useWorkspaceEditorCommands";
import { useWorkspaceRecoveryState } from "../hooks/useWorkspaceRecoveryState";
import { useWorkspaceTabPolicy } from "../hooks/useWorkspaceTabPolicy";
import { useWorkspaceToolWindowRouting } from "../hooks/useWorkspaceToolWindowRouting";
import { useWorkspaceToolWindows } from "../hooks/useWorkspaceToolWindows";
import { BottomDock } from "../panels/BottomDock";
import { ToolWindowPortal } from "../panels/ToolWindowHost";
import { ToolWindowRail, type ToolWindowRailItem } from "../panels/ToolWindowRail";
import { WorkspaceClipboardSessionContext } from "../workspaceClipboardSession";
import { WorkspaceObservationBridge } from "../workspaceObservationBridge";
import { type ClosedTabEntry } from "../workspaceTabPolicy";
import { WorkspaceConfigurationPopups } from "./WorkspaceConfigurationPopups";
import { WorkspaceDebugPopups } from "./WorkspaceDebugPopups";
import { WorkspaceDocumentPopups } from "./WorkspaceDocumentPopups";
import { WorkspaceEditingPopups } from "./WorkspaceEditingPopups";
import { WorkspaceGenerationPopups } from "./WorkspaceGenerationPopups";
import { WorkspaceNavigationPopups } from "./WorkspaceNavigationPopups";
import { WorkspaceOperationObservations } from "./WorkspaceOperationObservations";
import { WorkspaceCommandPublication, type WorkspaceCommandPublicationProps } from "./WorkspaceCommandPublication";
import { WorkspaceRefactoringPopups } from "./WorkspaceRefactoringPopups";
import { WorkspaceToolbar } from "./WorkspaceToolbar";
import { createWorkspaceDockContents } from "./createWorkspaceDockContents";
import { createWorkspaceLayoutRenderer } from "./createWorkspaceLayoutRenderer";
import { createWorkspaceSideContents } from "./createWorkspaceSideContents";
import { createRenderEditorGroup } from "./editorGroupView";
import { useWorkspaceHost } from "../workspaceHostIntegration";
import { useEffect, useRef } from "react";


export interface WorkspaceShellViewProps {
  commandPublication: WorkspaceCommandPublicationProps;
  workspaceGenerationPopupsProps: import("react").ComponentProps<typeof WorkspaceGenerationPopups>;
  workspaceDebugPopupsProps: import("react").ComponentProps<typeof WorkspaceDebugPopups>;
  workspaceEditingPopupsProps: import("react").ComponentProps<typeof WorkspaceEditingPopups>;
  workspaceRefactoringPopupsProps: import("react").ComponentProps<typeof WorkspaceRefactoringPopups>;
  workspaceConfigurationPopupsProps: import("react").ComponentProps<typeof WorkspaceConfigurationPopups>;
  workspaceDocumentPopupsProps: import("react").ComponentProps<typeof WorkspaceDocumentPopups>;
  workspaceNavigationPopupsProps: import("react").ComponentProps<typeof WorkspaceNavigationPopups>;
  workspaceToolbarProps: import("react").ComponentProps<typeof WorkspaceToolbar>;
  workspaceOperationObservationsProps: import("react").ComponentProps<typeof WorkspaceOperationObservations>;
  clipboard: ReturnType<typeof useWorkspaceClipboard>;
  rootRef: import("react").RefObject<HTMLDivElement | null>;
  observationBridge: WorkspaceObservationBridge;
  tabPolicyOwner: ReturnType<typeof useWorkspaceTabPolicy>;
  openFiles: Record<string, import("../editorGroupTypes").OpenFileViewModel>;
  activeKey: string | null;
  recoveryState: ReturnType<typeof useWorkspaceRecoveryState>;
  closedTabsStack: readonly ClosedTabEntry[];
  visible: boolean;
  workspaceInstanceId: string;
  toolWindowRouting: ReturnType<typeof useWorkspaceToolWindowRouting>;
  mainRailMergeActive: boolean;
  mainRailHost: HTMLElement | null;
  leftStripeTop: ToolWindowRailItem[];
  stripeItemsAt: (anchor: import("../toolWindowLayout").ToolWindowAnchor) => ToolWindowRailItem[];
  moreToolWindowsButton: import("react").JSX.Element;
  stripeCallbacks: { showNames: boolean; onToggleShowNames: () => void; onMove: (id: string, anchor: import("../toolWindowLayout").ToolWindowAnchor) => void; onHide: (id: string) => void; onRemoveFromSidebar: (id: string) => void; };
  lastProjectPanelSizeRef: import("react").RefObject<number>;
  setShellChromeState: (instanceId: string, patch: Partial<import("../../../../stores/codeWorkspaceStore").ShellChromeState>) => void;
  projectPanelRef: import("react").RefObject<PanelImperativeHandle | null>;
  initialProjectPanelSize: string;
  toolWindowActions: ReturnType<typeof useWorkspaceToolWindows>;
  renderToolWindowSideArea: (side: "left" | "right") => import("react").JSX.Element;
  languagePanelOpen: boolean;
  workspaceUi: Omit<import("../../../../stores/codeWorkspaceStore").CodeWorkspaceInstanceUi, "treeSelection">;
  editorLayout: ReturnType<typeof createWorkspaceLayoutRenderer>;
  renderEditorGroup: ReturnType<typeof createRenderEditorGroup>;
  sideContents: ReturnType<typeof createWorkspaceSideContents>;
  editorCommands: ReturnType<typeof useWorkspaceEditorCommands>;
  renderToolWindowPane: (id: string, options?: { legacyTestIds?: boolean; }) => import("react").JSX.Element;
  bottomDockOpen: boolean;
  bottomDockTab: BottomDockTabId;
  dockContents: ReturnType<typeof createWorkspaceDockContents>;
  rightStripeTop: ToolWindowRailItem[];
}

export function WorkspaceShellView(props: WorkspaceShellViewProps) {
  const host = useWorkspaceHost();
  // defaultSize is a mount-time input. Changing it re-registers the panel;
  // when a terminal hides this group, every panel has zero geometry and the
  // library can put the re-registered editor after Documentation. Its separator
  // then targets a nonexistent panel. Live tool visibility uses panel refs.
  const initialEditorPanelSize = useRef(props.languagePanelOpen ? "56%" : "80%").current;
  // A group mounted behind a terminal first measures zero. The library
  // reapplies these defaults when it becomes measurable, so an already closed
  // side must also start collapsed rather than claim hidden editor space.
  const initialRightPanelSize = useRef(props.toolWindowRouting.rightToolAreaOpen ? "20%" : "0%").current;
  const previousLeftOpen = useRef<boolean | null>(null);
  useEffect(() => {
    const open = props.toolWindowRouting.leftToolAreaOpen;
    if (host?.active && previousLeftOpen.current !== null && previousLeftOpen.current !== open) {
      host.onLeftToolAreaChange(open);
    }
    previousLeftOpen.current = open;
  }, [host, props.toolWindowRouting.leftToolAreaOpen]);
  const {
    clipboard,
    rootRef,
    observationBridge,
    tabPolicyOwner,
    openFiles,
    activeKey,
    recoveryState,
    closedTabsStack,
    visible,
    workspaceInstanceId,
    toolWindowRouting,
    mainRailMergeActive,
    mainRailHost,
    leftStripeTop,
    stripeItemsAt,
    moreToolWindowsButton,
    stripeCallbacks,
    lastProjectPanelSizeRef,
    setShellChromeState,
    projectPanelRef,
    initialProjectPanelSize,
    toolWindowActions,
    renderToolWindowSideArea,
    workspaceUi,
    editorLayout,
    renderEditorGroup,
    sideContents,
    editorCommands,
    renderToolWindowPane,
    bottomDockOpen,
    bottomDockTab,
    dockContents,
    rightStripeTop,
    workspaceOperationObservationsProps,
    workspaceToolbarProps,
    workspaceNavigationPopupsProps,
    workspaceDocumentPopupsProps,
    workspaceConfigurationPopupsProps,
    workspaceRefactoringPopupsProps,
    workspaceEditingPopupsProps,
    workspaceDebugPopupsProps,
    workspaceGenerationPopupsProps,
  } = props;
  return ((
    <WorkspaceClipboardSessionContext.Provider value={clipboard.clipboardHandle}>
      <WorkspaceCommandPublication {...props.commandPublication} />
      <WorkspaceObservationBoundary
        ref={rootRef}
        bridge={observationBridge}
        clipboardHandle={clipboard.clipboardHandle}
        data-testid="code-workspace-tab"
        data-layout-revision={tabPolicyOwner.layoutRevision}
        data-tab-policy-limit={tabPolicyOwner.tabPolicy.limitPerLeaf}
        data-tab-policy-order={tabPolicyOwner.tabPolicy.order}
        data-tab-policy-receipt-status={tabPolicyOwner.tabPolicyReceipt?.status}
        data-tab-policy-receipt-layout-revision={tabPolicyOwner.tabPolicyReceipt?.layoutRevision}
        data-tab-policy-receipt-active-key={tabPolicyOwner.tabPolicyReceipt?.activeKey ?? undefined}
        data-tab-policy-receipt-evicted-count={tabPolicyOwner.tabPolicyReceipt?.evictedCount}
        data-tab-policy-receipt-cleanup-count={tabPolicyOwner.tabPolicyReceipt?.cleanupCount}
        data-tab-policy-receipt-cleanup-committed-count={tabPolicyOwner.tabPolicyReceipt?.cleanupCommittedCount}
        data-tab-policy-receipt-cleanup-recovery-count={tabPolicyOwner.tabPolicyReceipt?.cleanupRecoveryCount}
        data-tab-policy-receipt-open-resource-count={tabPolicyOwner.tabPolicyReceipt?.openResourceCount}
        data-open-resource-count={Object.keys(openFiles).length}
        data-active-editor-key={activeKey ?? undefined}
        data-resource-recovery-count={recoveryState.resourceCleanupRecoveries.length}
        data-reopen-stack-count={closedTabsStack.length}
        className="relative h-full w-full min-h-0 flex flex-col overflow-hidden bg-[var(--taomni-code-bg)] text-[var(--taomni-code-text)]"
      >
        <WorkspaceOperationObservations {...workspaceOperationObservationsProps} /><WorkspaceToolbar {...workspaceToolbarProps} />
        {host?.leftToolAreaHost && createPortal(
          <div data-testid="code-workspace-left-tool-area" className="h-full min-h-0" style={toolWindowRouting.leftToolAreaOpen ? undefined : { display: "none" }}>
            {renderToolWindowSideArea("left")}
          </div>, host.leftToolAreaHost,
        )}

        {recoveryState.resourceCleanupRecoveries.length > 0 && (
          <div
            data-testid="workspace-resource-cleanup-recovery"
            role="status"
            aria-live="polite"
            className="shrink-0 border-b border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-[11px]"
          >
            {recoveryState.resourceCleanupRecoveries.map((recovery) => (
              <div
                key={recovery.recoveryId}
                data-testid="workspace-resource-cleanup-recovery-item"
                data-recovery-id={recovery.recoveryId}
                data-next-stage={recovery.nextStage}
                data-completed-stage-count={recovery.completedStageCount}
                data-attempt-count={recovery.attemptCount}
                className="flex min-w-0 items-center gap-2"
              >
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-400" />
                <span className="min-w-0 flex-1 truncate">
                  Cleanup paused at {recovery.nextStage} for {recovery.fileKey}: {recovery.error}
                </span>
                <button
                  type="button"
                  data-testid="workspace-resource-cleanup-retry"
                  className="taomni-btn h-6 shrink-0 px-2"
                  aria-label={`Retry resource cleanup for ${recovery.fileKey}`}
                  onClick={() => void recoveryState.replayResourceCleanup(recovery.recoveryId)}
                >
                  Retry
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex-1 min-h-0 flex">
          {(() => {
            const merged = (host ? host.active : visible) && mainRailMergeActive && !!mainRailHost;
            const leftStripe = (
              <ToolWindowRail
                side="left"
                embedded={merged}
                top={leftStripeTop}
                bottom={stripeItemsAt("bottom-left")}
                footer={moreToolWindowsButton}
                width={toolWindowRouting.toolWindowLayout.stripeWidth("left")}
                onResize={(width) => toolWindowRouting.toolWindowLayout.setStripeWidth("left", width)}
                {...stripeCallbacks}
              />
            );
            return merged && mainRailHost ? createPortal(leftStripe, mainRailHost) : leftStripe;
          })()}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex-1 min-h-0 flex">
              <PanelGroup
                orientation="horizontal"
                id={`code-workspace-${workspaceInstanceId}`}
                className="flex-1 min-h-0 min-w-0"
                onLayoutChanged={() => {
                  // Pointer drags report here only on release (never per move), which
                  // is the library's intended persistence point for saved layouts.
                  if (lastProjectPanelSizeRef.current > 40) {
                    setShellChromeState(workspaceInstanceId, {
                      projectWidthPx: lastProjectPanelSizeRef.current,
                    });
                  }
                }}
              >
                {!host && <Panel
                  panelRef={projectPanelRef}
                  id="project"
                  defaultSize={initialProjectPanelSize}
                  // IDEA tool windows keep their width when the frame resizes, e.g.
                  // when the main sidebar collapses into its rail (ED-PARITY-027).
                  groupResizeBehavior="preserve-pixel-size"
                  minSize={0}
                  collapsible
                  collapsedSize={0}
                  onResize={toolWindowActions.handleProjectPanelResize}
                  className="min-w-0"
                >
                  <div
                    className="h-full min-h-0 overflow-hidden"
                    data-testid="code-workspace-left-tool-area"
                    style={toolWindowRouting.leftToolAreaOpen ? undefined : { display: "none" }}
                  >
                    {renderToolWindowSideArea("left")}
                  </div>
                </Panel>}
                {!host && <PanelResizeHandle
                  id="code-workspace-project-resize-handle"
                  data-testid="code-workspace-project-resize-handle"
                  disabled={!toolWindowRouting.leftToolAreaOpen}
                  className={toolWindowRouting.leftToolAreaOpen
                    ? "w-[3px] bg-[var(--taomni-code-border)] hover:bg-[var(--taomni-accent)] active:bg-[var(--taomni-accent)] transition-colors cursor-col-resize shrink-0 relative after:absolute after:inset-y-0 after:-left-1.5 after:-right-1.5 after:z-20"
                    : "hidden"}
                />}
                <Panel
                  id="editor"
                  defaultSize={initialEditorPanelSize}
                  minSize="37px"
                  className="min-w-0"
                >
                  {workspaceUi.layoutTreeV2.type === "split" ? (
                    <div data-testid="code-workspace-editor-split" className="h-full min-h-0">
                      {editorLayout.renderRecursiveLayoutNode(workspaceUi.layoutTreeV2, renderEditorGroup)}
                    </div>
                  ) : editorLayout.renderRecursiveLayoutNode(workspaceUi.layoutTreeV2, renderEditorGroup)}
                </Panel>
                <PanelResizeHandle
                  className={toolWindowRouting.rightToolAreaOpen
                    ? "w-1 bg-[var(--taomni-code-border)] hover:bg-[var(--taomni-accent)] transition-colors cursor-col-resize"
                    : "hidden"}
                />
                <Panel
                  panelRef={toolWindowRouting.rightPanelRef}
                  id="documentation"
                  defaultSize={initialRightPanelSize}
                  groupResizeBehavior="preserve-pixel-size"
                  minSize="12%"
                  maxSize="40%"
                  collapsible
                  collapsedSize={0}
                  onResize={toolWindowActions.handleRightPanelResize}
                  className="min-w-0"
                >
                  <aside
                    data-testid="code-workspace-right-pane"
                    className="h-full min-h-0 flex flex-col border-l border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)]"
                    style={toolWindowRouting.rightToolAreaOpen ? undefined : { display: "none" }}
                  >
                    {renderToolWindowSideArea("right")}
                  </aside>
                </Panel>
              </PanelGroup>
            </div>
            <div ref={toolWindowRouting.toolWindowNodes.setParking} hidden data-testid="code-workspace-tool-window-parking" />
            {sideContents.toolWindowContents.map((entry) => (
              <ToolWindowPortal
                key={entry.id}
                nodes={toolWindowRouting.toolWindowNodes}
                id={entry.id}
                label={entry.label}
                active={toolWindowRouting.toolWindowLayout.isVisible(entry.id)}
                renderContent={entry.renderContent}
                // The terminal keeps Esc for the shell and the tree handles its own.
                onEscape={entry.id === "terminal" || entry.id === "project" ? undefined : editorCommands.handleReturnToEditor}
              >
                {entry.content}
              </ToolWindowPortal>
            ))}
            <BottomDock
              onRestoreLayout={toolWindowActions.handleRestoreToolWindowLayout}
              renderPane={(id, placement) => renderToolWindowPane(id, { legacyTestIds: placement === "primary" })}
              secondaryTab={toolWindowRouting.toolWindowLayout.visibleAt("bottom-right")}
              open={bottomDockOpen && toolWindowRouting.toolWindowLayout.anchorOf(bottomDockTab) === "bottom-left"}
              height={toolWindowActions.currentBottomDockHeight}
              maxHeight={toolWindowActions.maxBottomDockHeight}
              onHeightChange={toolWindowActions.handleBottomDockHeightChange}
              onEscape={editorCommands.handleReturnToEditor}
              activeTab={bottomDockTab}
              tabs={dockContents.bottomDockTabs}
              onOpenChange={toolWindowRouting.setBottomDockOpen}
              onActiveTabChange={(tab) => toolWindowRouting.setBottomDockTab(tab as BottomDockTabId)}
            />
          </div>
          <ToolWindowRail
            side="right"
            top={rightStripeTop}
            bottom={stripeItemsAt("bottom-right")}
            width={toolWindowRouting.toolWindowLayout.stripeWidth("right")}
            onResize={(width) => toolWindowRouting.toolWindowLayout.setStripeWidth("right", width)}
            {...stripeCallbacks}
          />
        </div>
        <WorkspaceNavigationPopups {...workspaceNavigationPopupsProps} /><WorkspaceDocumentPopups {...workspaceDocumentPopupsProps} /><WorkspaceConfigurationPopups {...workspaceConfigurationPopupsProps} /><WorkspaceRefactoringPopups {...workspaceRefactoringPopupsProps} /><WorkspaceEditingPopups {...workspaceEditingPopupsProps} /><WorkspaceDebugPopups {...workspaceDebugPopupsProps} /><WorkspaceGenerationPopups {...workspaceGenerationPopupsProps} /></WorkspaceObservationBoundary>
    </WorkspaceClipboardSessionContext.Provider>
  ));
}
