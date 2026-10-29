import { useCallback, useEffect, useRef, useState } from "react";
import { type BottomDockTabId, type CodeWorkspaceEditorGroupState, type EditorGroupId } from "../../../../stores/codeWorkspaceStore";
import { listToolWindowsForCycle, syncBottomDockToolWindows, unregisterAllToolWindows } from "../toolWindowRegistry";
import { getAllLeafNodes } from "../recursiveLayoutTree";
import { type EditorCommandPort } from "../host/types";
import { switcherArrowIndex, type TabSwitcherEntry, type TabSwitcherToolWindow } from "../TabSwitcher";
import { disabledReasonLabel } from "../workspaceCodeMirrorKeymap";
import { eventLogicalKey } from "../workspaceCommands";
import type { CodeWorkspaceFileRef } from "../../../../types";

export interface UseWorkspaceKeyboardContext {
  activeKey: string | null;
  workspaceInstanceId: string;
  bottomDockOpen: boolean;
  bottomDockTab: BottomDockTabId;
  workspaceUi: Omit<import("../../../../stores/codeWorkspaceStore").CodeWorkspaceInstanceUi, "treeSelection">;
  openFiles: Record<string, import("../editorGroupTypes").OpenFileViewModel>;
  editorGroups: Record<string, CodeWorkspaceEditorGroupState>;
  setStatusMessage: (message: string) => void;
  closeFile: (key: string, groupId?: EditorGroupId, options?: { discard?: boolean; }) => Promise<void>;
  activeEditorGroupId: string;
  setBottomDockOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  setBottomDockTab: (tab: BottomDockTabId | ((prev: BottomDockTabId) => BottomDockTabId)) => void;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  setStoreActiveEditorGroup: (instanceId: string, groupId: EditorGroupId) => void;
  setLeafActiveTab: (instanceId: string, leafId: string, fileKey: string | null) => void;
  openFile: (ref: CodeWorkspaceFileRef, options?: { preview?: boolean; groupId?: EditorGroupId; activate?: boolean; restoring?: boolean; isCurrent?: () => boolean; }) => Promise<{ canonicalFileKey: string; groupId: string; error: string | null; } | null>;
  actionsController: import("../useWorkspaceActionsController").WorkspaceActionsController;
  visible: boolean;
  isSurfaceOwnedKeyEvent: (target: EventTarget | null) => boolean;
  isNativeTextInputTarget: (target: EventTarget | null) => boolean;
  isEditorSurfaceKeyEvent: (target: EventTarget | null) => boolean;
  onCommandsChange: ((tabId: string, registration: import("../workspaceCommands").WorkspaceCommandRegistration | null) => void) | undefined;
  activeEditorCommandOwner: () => { fileKey: string; token: object; port: EditorCommandPort; } | null;
  activeEditorGroupIdRef: import("react").RefObject<string>;
}

export function useWorkspaceKeyboard(context: UseWorkspaceKeyboardContext) {
  const {
    activeKey,
    workspaceInstanceId,
    bottomDockOpen,
    bottomDockTab,
    workspaceUi,
    openFiles,
    editorGroups,
    setStatusMessage,
    closeFile,
    activeEditorGroupId,
    setBottomDockOpen,
    setBottomDockTab,
    openFilesRef,
    setStoreActiveEditorGroup,
    setLeafActiveTab,
    openFile,
    actionsController,
    visible,
    isSurfaceOwnedKeyEvent,
    isNativeTextInputTarget,
    isEditorSurfaceKeyEvent,
    onCommandsChange,
    activeEditorCommandOwner,
    activeEditorGroupIdRef,
  } = context;

  // §8.16.5 N2.6: Ctrl+Tab MRU Switcher state. Hold-to-cycle, release-to-commit,
  // Esc cancels; hovering an entry previews without mutating MRU order.
  const [tabSwitcherOpen, setTabSwitcherOpen] = useState(false);
  const [tabSwitcherIndex, setTabSwitcherIndex] = useState(0);
  const activeKeyRef = useRef(activeKey);
  activeKeyRef.current = activeKey;
  const tabSwitcherOpenRef = useRef(false);
  const tabSwitcherIndexRef = useRef(0);
  tabSwitcherOpenRef.current = tabSwitcherOpen;
  tabSwitcherIndexRef.current = tabSwitcherIndex;
  const mruFileKeysRef = useRef<string[]>([]);
  useEffect(() => {
    if (!activeKey) return;
    mruFileKeysRef.current = [
      activeKey,
      ...mruFileKeysRef.current.filter((key) => key !== activeKey),
    ].slice(0, 24);
  }, [activeKey]);

  // §8.19.6: bottom-dock panels mirror their REAL dock state into the
  // workspace-scoped tool-window registry; the Switcher consumes registry
  // snapshots instead of constructing its own list.
  useEffect(() => {
    syncBottomDockToolWindows(workspaceInstanceId, { open: bottomDockOpen, activeTab: bottomDockTab });
  }, [workspaceInstanceId, bottomDockOpen, bottomDockTab]);
  useEffect(() => () => unregisterAllToolWindows(workspaceInstanceId), [workspaceInstanceId]);

  // §8.17.5 step 4 + §8.19.6: the popup cycles over ONE frozen snapshot
  // captured at open time — editor MRU entries plus registry cycle snapshots.
  // Tool windows opened/closed in the background cannot shift the index
  // space or reorder entries mid-cycle; release commits against the snapshot.
  const [switcherSnapshot, setSwitcherSnapshot] = useState<{
    editors: TabSwitcherEntry[];
    tools: TabSwitcherToolWindow[];
  } | null>(null);
  const switcherSnapshotRef = useRef(switcherSnapshot);
  switcherSnapshotRef.current = switcherSnapshot;

  const buildSwitcherSnapshot = useCallback(() => {
    // §8.18.5 leaf identity: resolve which layout leaf currently owns each
    // file so commit reactivates the ORIGINAL view instead of the active one.
    const ownerByFileKey = new Map<string, string>();
    for (const leaf of getAllLeafNodes(workspaceUi.layoutTreeV2)) {
      for (const key of leaf.openFileKeys) {
        if (!ownerByFileKey.has(key)) ownerByFileKey.set(key, leaf.id);
      }
    }
    const editors: TabSwitcherEntry[] = mruFileKeysRef.current
      .map((key) => openFiles[key])
      .filter((entry): entry is NonNullable<typeof entry> => !!entry)
      .map((entry) => {
        const owningGroup = Object.values(editorGroups).find(
          (group) => group.openOrder.includes(entry.key),
        );
        return {
          key: entry.key,
          title: entry.title,
          subtitle: entry.subtitle,
          dirty: entry.dirty,
          active: entry.key === activeKey,
          leafId: ownerByFileKey.get(entry.key) ?? owningGroup?.id ?? null,
          pinned: owningGroup?.pinnedKeys?.includes(entry.key) ?? false,
          preview: owningGroup?.previewKey === entry.key,
        };
      });
    const tools: TabSwitcherToolWindow[] = listToolWindowsForCycle(workspaceInstanceId).map((snapshot) => ({
      id: snapshot.id,
      label: snapshot.title,
      open: snapshot.state === "open",
    }));
    return { editors, tools };
  }, [activeKey, editorGroups, openFiles, workspaceInstanceId, workspaceUi.layoutTreeV2]);
  const buildSwitcherSnapshotRef = useRef(buildSwitcherSnapshot);
  buildSwitcherSnapshotRef.current = buildSwitcherSnapshot;

  const switcherTotalCountRef = useRef(0);
  switcherTotalCountRef.current = switcherSnapshot
    ? switcherSnapshot.editors.length + switcherSnapshot.tools.length
    : 0;

  /**
   * Leaf-aware switcher close, graded per §8.19.6: pinned tabs refuse with a
   * reason (protected work is never silently closed), dirty tabs go through
   * the same confirm path as the tab strip, and tool windows only hide.
   */
  const closeFromTabSwitcher = useCallback(async () => {
    const snapshot = switcherSnapshotRef.current;
    if (!snapshot) return;
    const index = Math.min(
      tabSwitcherIndexRef.current,
      snapshot.editors.length + snapshot.tools.length - 1,
    );
    const editorEntry = snapshot.editors[index];
    if (editorEntry) {
      if (editorEntry.pinned) {
        setStatusMessage(`${editorEntry.title} is pinned — unpin it before closing`);
        return;
      }
      setTabSwitcherOpen(false);
      setSwitcherSnapshot(null);
      await closeFile(editorEntry.key, editorEntry.leafId ?? activeEditorGroupId);
      return;
    }
    setTabSwitcherOpen(false);
    setSwitcherSnapshot(null);
    const toolWindow = snapshot.tools[index - snapshot.editors.length];
    if (toolWindow) {
      // Single-tab dock: hiding the dock IS hiding this window; it stays
      // registered as hidden and reopens through the Switcher.
      setBottomDockOpen(false);
    }
  }, [activeEditorGroupId, closeFile, setBottomDockOpen, setStatusMessage]);

  const commitTabSwitcher = useCallback((index: number) => {
    const snapshot = switcherSnapshotRef.current;
    setTabSwitcherOpen(false);
    setSwitcherSnapshot(null);
    if (!snapshot) return;
    const toolWindow = snapshot.tools[index - snapshot.editors.length];
    if (toolWindow) {
      setBottomDockOpen(true);
      setBottomDockTab(toolWindow.id as BottomDockTabId);
      return;
    }
    const target = snapshot.editors[index];
    if (!target) return;
    const targetRef = openFilesRef.current[target.key]?.ref ?? null;
    if (target.key === activeKeyRef.current && target.leafId) {
      setStoreActiveEditorGroup(workspaceInstanceId, target.leafId as EditorGroupId);
      return;
    }
    if (target.leafId) {
      const leafStillExists = getAllLeafNodes(workspaceUi.layoutTreeV2).some((leaf) => leaf.id === target.leafId);
      if (leafStillExists) {
        // Original leaf activation (§8.18.5): never reroute through the
        // currently active group.
        setStoreActiveEditorGroup(workspaceInstanceId, target.leafId as EditorGroupId);
        setLeafActiveTab(workspaceInstanceId, target.leafId, target.key);
        return;
      }
      setStatusMessage(`${target.title}: its split was closed — reopened in the current editor`);
    }
    if (targetRef) void openFile(targetRef);
  }, [workspaceUi.layoutTreeV2, openFile, setStoreActiveEditorGroup, setLeafActiveTab, setStatusMessage, setBottomDockOpen, setBottomDockTab, workspaceInstanceId]);
  const commitTabSwitcherRef = useRef(commitTabSwitcher);
  commitTabSwitcherRef.current = commitTabSwitcher;
  const closeFromTabSwitcherRef = useRef(closeFromTabSwitcher);
  closeFromTabSwitcherRef.current = closeFromTabSwitcher;
  const dispatchWorkspaceKeydownV2 = actionsController.dispatchKeydownV2;

  useEffect(() => {
    if (!visible) return;
    // §8.17.3 step 2: ONE capture keydown listener for the whole workspace.
    // The Ctrl+Tab switcher runs inside this listener through the action
    // host's normalized key identity (`eventLogicalKey`), so macOS Meta+Tab
    // and Windows/Linux Ctrl+Tab share one code path and no second window
    // listener competes with the host dispatch below.
    const handleWorkspaceCommand = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      // Navigation bar and popup controls own their keyboard state. They are
      // rendered in the workspace or a portal, so the window capture listener
      // must not turn Home/arrows/Enter/Escape into editor actions first.
      if (isSurfaceOwnedKeyEvent(event.target)) return;
      const logicalKey = eventLogicalKey(event);
      const targetElement = event.target instanceof Element ? event.target : null;
      if (
        !event.ctrlKey && !event.metaKey && !event.altKey
        && targetElement?.closest('[data-testid="code-workspace-find-file-group"]')
        && ["delete", "arrowup", "arrowdown", "enter"].includes(logicalKey)
      ) return;
      // IDEA debugger trees own their navigation and value keys (F2 Set
      // Value, Delete removes a watch, Ctrl+C copies the value); stepping keys
      // such as F7/F8/F9 still reach the workspace dispatcher.
      if (
        targetElement?.closest('[data-testid="debug-variables-tree"], [data-testid="debug-frames-list"]')
        && !event.altKey
        && (
          (!event.ctrlKey && !event.metaKey
            && ["f2", "f4", "delete", "insert", "enter", "arrowup", "arrowdown", "arrowleft", "arrowright", "home", "end"].includes(logicalKey))
          || ((event.ctrlKey || event.metaKey) && !event.shiftKey && logicalKey === "c")
        )
      ) return;
      // Native text controls own their character history. A workspace journal
      // must never consume Ctrl/Cmd+Z, redo, or Ctrl/Cmd+Y while an input is
      // focused, otherwise replacing files would be undone from the query box.
      if (
        isNativeTextInputTarget(event.target)
        && (event.ctrlKey || event.metaKey)
        && !event.altKey
        && ["z", "y"].includes(logicalKey)
      ) return;
      const switcherModifier = event.ctrlKey || event.metaKey;
      if (logicalKey === "tab" && switcherModifier && !event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        if (!tabSwitcherOpenRef.current) {
          // Openable when there are editor entries OR tool windows to list;
          // the snapshot is frozen here for the whole cycle (§8.19.6).
          const snapshot = buildSwitcherSnapshotRef.current();
          if (snapshot.editors.length + snapshot.tools.length === 0) return;
          setSwitcherSnapshot(snapshot);
          setTabSwitcherIndex(snapshot.editors.length > 1 ? 1 : 0);
          setTabSwitcherOpen(true);
          return;
        }
        setTabSwitcherIndex((index) => {
          const count = switcherTotalCountRef.current;
          if (count === 0) return 0;
          return event.shiftKey
            ? (index - 1 + count) % count
            : (index + 1) % count;
        });
        return;
      }
      if (logicalKey === "escape" && tabSwitcherOpenRef.current) {
        event.preventDefault();
        event.stopPropagation();
        setTabSwitcherOpen(false);
        return;
      }
      // IDEA Switcher: arrows walk the columns while the modifier is held.
      if (
        tabSwitcherOpenRef.current
        && (logicalKey === "arrowup" || logicalKey === "arrowdown" || logicalKey === "arrowleft" || logicalKey === "arrowright")
      ) {
        event.preventDefault();
        event.stopPropagation();
        const snapshot = switcherSnapshotRef.current;
        setTabSwitcherIndex((index) => switcherArrowIndex(
          index,
          logicalKey,
          snapshot?.editors.length ?? 0,
          snapshot?.tools.length ?? 0,
        ));
        return;
      }
      // Bare Tab belongs to the focused native control outside the editor.
      // Otherwise the active editor's insertTab action would consume a banner,
      // tree, or settings control's browser focus navigation.
      if (logicalKey === "tab" && !switcherModifier && !isEditorSurfaceKeyEvent(event.target)) return;
      // Ctrl+Shift+T is shared with MainLayout's shell owner. Let the root
      // router consume it so the workspace claim and terminal fallback cannot
      // both run for the same key event.
      if (
        logicalKey === "t"
        && (event.ctrlKey || event.metaKey)
        && event.shiftKey
        && !event.altKey
        && onCommandsChange
      ) return;
      // §8.18.5: Backspace inside the open Switcher closes the selected
      // editor entry (dirty tabs confirm) or hides the selected tool window.
      if (logicalKey === "backspace" && tabSwitcherOpenRef.current) {
        event.preventDefault();
        event.stopPropagation();
        void closeFromTabSwitcherRef.current();
        return;
      }
      const editorEventOwner = isEditorSurfaceKeyEvent(event.target)
        ? activeEditorCommandOwner()
        : null;
      // Completion is an editor-local state machine. The workspace capture
      // listener runs before CodeMirror, so it must yield these unmodified
      // navigation/accept/cancel keys while the popup is active. Bare Tab
      // always stays local: CodeMirror accepts completion/live templates and
      // then falls through to indentation when neither applies.
      if (editorEventOwner && !event.ctrlKey && !event.metaKey && !event.altKey) {
        if (logicalKey === "tab") return;
        const activeCompletionId = targetElement?.getAttribute("aria-activedescendant");
        const hasActiveCompletionCandidate = !!activeCompletionId
          && !!document.getElementById(activeCompletionId)?.closest(".cm-tooltip-autocomplete");
        if (
          !event.shiftKey
          && (
            editorEventOwner.port.state().completionActive
            || hasActiveCompletionCandidate
          )
          && ["arrowup", "arrowdown", "pageup", "pagedown", "enter", "escape"].includes(logicalKey)
        ) return;
      }
      const dispatchResult = dispatchWorkspaceKeydownV2({
        event,
        workspaceId: workspaceInstanceId,
        // CodeMirrorHost registers each split by its stable leaf/view id;
        // fileKey is shared by split views and cannot identify a live view.
        // Non-editor surfaces must resolve their own focus from the event
        // target; otherwise a tree Delete is evaluated against the editor
        // context before the tree can consume it.
        targetViewId: editorEventOwner
          ? activeEditorGroupIdRef.current
          : null,
        composing: editorEventOwner?.port.state().composing ?? false,
      });
      if (
        dispatchResult.kind === "rejected"
        && dispatchResult.reason === "disabled"
        && dispatchResult.disabledReason
      ) {
        // §8.19.2 typed no-op reason: a matched-but-disabled binding names its
        // blocked state instead of silently skipping the shortcut.
        setStatusMessage(
          disabledReasonLabel(dispatchResult.disabledReason) ?? dispatchResult.disabledReason,
        );
      }
    };
    // Modifier-release commit cannot be a keydown action; it stays a keyup
    // listener and commits on whichever platform modifier started the cycle.
    const release = (event: KeyboardEvent) => {
      if (!tabSwitcherOpenRef.current) return;
      if (event.key !== "Control" && event.key !== "Meta") return;
      commitTabSwitcherRef.current(Math.min(tabSwitcherIndexRef.current, switcherTotalCountRef.current - 1));
    };
    window.addEventListener("keydown", handleWorkspaceCommand, true);
    window.addEventListener("keyup", release, true);
    return () => {
      window.removeEventListener("keydown", handleWorkspaceCommand, true);
      window.removeEventListener("keyup", release, true);
    };
  }, [dispatchWorkspaceKeydownV2, isEditorSurfaceKeyEvent, isNativeTextInputTarget, isSurfaceOwnedKeyEvent, onCommandsChange, openFile, visible]);
  return {
    mruFileKeysRef,
    activeKeyRef,
    tabSwitcherOpen,
    switcherSnapshot,
    tabSwitcherIndex,
    setTabSwitcherIndex,
    commitTabSwitcher,
    setTabSwitcherOpen,
    setSwitcherSnapshot,
  };
}
