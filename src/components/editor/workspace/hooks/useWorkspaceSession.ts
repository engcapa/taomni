import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type PanelImperativeHandle } from "react-resizable-panels";
import { useMountedRef } from "../../../../hooks/useMountedRef";
import { useT } from "../../../../lib/i18n";
import { useAppStore } from "../../../../stores/appStore";
import { useChatStore } from "../../../../stores/chatStore";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../stores/codeWorkspaceStore";
import { useMainRailHostStore } from "../../../../stores/mainRailHostStore";
import { type EditorSelectionRange } from "../CodeMirrorHost";
import { useWorkspacePreferences } from "../controller/useWorkspacePreferences";
import { readWorkspaceBookmarks } from "../todoBookmarks";
import { useWorkspaceLspClientEvents } from "../useWorkspaceLspClientEvents";
import { useWorkspaceSemanticIndex } from "../useWorkspaceSemanticIndex";
import { readWorkspaceLayoutSnapshot } from "../workspaceLayoutPersistence";
import { WorkspaceObservationBridge } from "../workspaceObservationBridge";
import { useWorkspaceBufferState } from "./useWorkspaceBufferState";
import { useWorkspaceClipboard } from "./useWorkspaceClipboard";
import { useWorkspaceEditorCommands } from "./useWorkspaceEditorCommands";
import { useWorkspaceLayoutHydration } from "./useWorkspaceLayoutHydration";
import { useWorkspaceReferenceSessions } from "./useWorkspaceReferenceSessions";
import { useWorkspaceStoreActions } from "./useWorkspaceStoreActions";
import { useWorkspaceTabPolicy } from "./useWorkspaceTabPolicy";
import { useWorkspaceTreeFocusState } from "./useWorkspaceTreeFocusState";


export interface UseWorkspaceSessionContext {
  workspace: import("../../../../types").CodeWorkspaceTabInfo;
  tabId: string;
  visible: boolean;
}

export function useWorkspaceSession(context: UseWorkspaceSessionContext) {
  const { workspace, tabId, visible } = context;
  const setStatusMessage = useAppStore((s) => s.setStatusMessage);
  // ED-PARITY-027 B: while the main sidebar is collapsed to its rail, the
  // active workspace renders its left tool window bar into that rail.
  const mainRailHost = useMainRailHostStore((s) => s.host);
  const mainRailMergeActive = useAppStore((s) => s.mergeToolWindowRail && s.sidebarCollapsed);
  const sendPromptToTabChat = useChatStore((s) => s.sendPromptToTabChat);
  const t = useT();
  const workspaceInstanceId = useMemo(
    () => workspace.workspaceInstanceId ?? workspace.workspaceId ?? workspace.repoRoot?.trim() ?? tabId,
    [tabId, workspace.repoRoot, workspace.workspaceId, workspace.workspaceInstanceId],
  );
  const observationBridge = useMemo(
    () => new WorkspaceObservationBridge(workspaceInstanceId, import.meta.env.PROD),
    [workspaceInstanceId],
  );
  const observationBridgeRef = useRef(observationBridge);
  observationBridgeRef.current = observationBridge;
  const publishWorkspaceObservation = useCallback((
    update: (bridge: WorkspaceObservationBridge) => void,
  ) => {
    update(observationBridgeRef.current);
  }, []);
  const semanticIndex = useWorkspaceSemanticIndex(workspaceInstanceId);
  const referenceSessions = useWorkspaceReferenceSessions({
    workspaceInstanceId,
  });
  const lspClientEvents = useWorkspaceLspClientEvents({
    workspaceId: workspaceInstanceId,
    visible,
    onStatus: setStatusMessage,
  });
  const activeSemanticProviders = useMemo(
    () => lspClientEvents.progresses.map((progress) => `${progress.serverLabel}:${progress.rootUri}`),
    [lspClientEvents.progresses],
  );
  useEffect(() => {
    semanticIndex.setActiveProviders(activeSemanticProviders);
  }, [activeSemanticProviders, semanticIndex.setActiveProviders]);
  const preferences = useWorkspacePreferences({
    workspaceInstanceId,
  });
  const tabPolicyOwner = useWorkspaceTabPolicy({
    workspaceInstanceId,
  });
  const clipboard = useWorkspaceClipboard({
    workspaceInstanceId,
    publishWorkspaceObservation,
  });
  const [searchFocusTarget, setSearchFocusTarget] = useState<"query" | "replace">("query");
  const searchEverywhereTriggerRef = useRef<HTMLElement | null>(null);
  const storeActions = useWorkspaceStoreActions({

  });
  // The effect below initializes a missing instance after commit. Keeping the
  // render path read-only avoids notifying external-store subscribers during
  // render when a workspace is mounted for the first time.
  const workspaceUi = useCodeWorkspaceStore((s) => selectCodeWorkspaceUi(s, workspaceInstanceId));
  const projectPanelRef = useRef<PanelImperativeHandle>(null);
  // Panel `defaultSize` is a mount-time input for react-resizable-panels:
  // re-passing a value that changes while the pointer is down makes the library
  // re-register the panel, tear the group down and drop the live drag session,
  // which freezes the splitter after the first pixel of movement. Resolve the
  // persisted width exactly once and keep it constant for the mount.
  const initialProjectPanelWidthRef = useRef<number | null>(null);
  if (initialProjectPanelWidthRef.current === null) {
    // A live instance already carries the session's width; a fresh mount must
    // fall back to the persisted snapshot because `workspaceUi` still holds the
    // 452px store default until the hydration effect below runs.
    const storedWidth = useCodeWorkspaceStore.getState().byInstanceId[workspaceInstanceId]
      ?.shellChromeState?.projectWidthPx
      ?? readWorkspaceLayoutSnapshot(workspaceInstanceId)?.shellChromeState?.projectWidthPx;
    initialProjectPanelWidthRef.current =
      typeof storedWidth === "number" && Number.isFinite(storedWidth) && storedWidth > 40
        ? Math.round(storedWidth)
        : 452;
  }
  const initialProjectPanelSize = `${initialProjectPanelWidthRef.current}px`;
  const lastProjectPanelSizeRef = useRef(initialProjectPanelWidthRef.current);

  useEffect(() => {
    storeActions.ensureWorkspaceUi(workspaceInstanceId);
    preferences.replaceBookmarks(readWorkspaceBookmarks(workspaceInstanceId));
  }, [storeActions.ensureWorkspaceUi, preferences.replaceBookmarks, workspaceInstanceId]);
  const layoutHydration = useWorkspaceLayoutHydration({
    workspaceInstanceId,
    setStatusMessage,
    lastProjectPanelSizeRef,
    setTabPolicy: tabPolicyOwner.setTabPolicy,
    patchWorkspaceUi: storeActions.patchWorkspaceUi,
    workspace,
    seedTreeExpandIfEmpty: storeActions.seedTreeExpandIfEmpty,
  });
  const bufferState = useWorkspaceBufferState({
    workspaceUi,
  });
  const editorSelectionRef = useRef<EditorSelectionRange>({
    start: { line: 0, character: 0 },
    end: { line: 0, character: 0 },
    empty: true,
    text: "",
    rect: null,
  });
  const treeFocus = useWorkspaceTreeFocusState({

  });
  const editorCommands = useWorkspaceEditorCommands({
    pendingTreeOpenIntentRef: treeFocus.pendingTreeOpenIntentRef,
    tryGrantTreeFocusRef: treeFocus.tryGrantTreeFocusRef,
    workspaceInstanceId,
    openFilesRef: bufferState.openFilesRef,
    editorSelectionRef,
  });
  /**
   * False after unmount so async callbacks skip setState. MUST come from
   * `useMountedRef`: the inline `useEffect(() => () => { ref.current = false })`
   * spelling stays false forever under StrictMode's dev double-invoke, which
   * silently aborted the Java debug launch right after main-class resolution.
   */
  const mountedRef = useMountedRef();
  return {
    publishWorkspaceObservation,
    workspaceInstanceId,
    setStatusMessage,
    searchEverywhereTriggerRef,
    semanticIndex,
    storeActions,
    workspaceUi,
    tabPolicyOwner,
    bufferState,
    clipboard,
    referenceSessions,
    lspClientEvents,
    layoutHydration,
    mountedRef,
    treeFocus,
    preferences,
    editorCommands,
    setSearchFocusTarget,
    editorSelectionRef,
    sendPromptToTabChat,
    t,
    projectPanelRef,
    lastProjectPanelSizeRef,
    searchFocusTarget,
    observationBridge,
    mainRailMergeActive,
    mainRailHost,
    initialProjectPanelSize,
  };
}
