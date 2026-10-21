import { useCallback, useEffect, useRef, useState } from "react";
import { type EditorGroupId } from "../../../../stores/codeWorkspaceStore";
import { caretAnchor, type CodeInsightNoticeState } from "../CodeInsightNotice";
import type { GoToLineRequest } from "../CodeMirrorHost";
import type { EditorRevealTarget } from "../EditorGroup";
import { type PendingExternalFileConflict, type PendingExternalFileEvent } from "../controller/model";
import { type EditorCompareSession } from "../editorCompareModel";
import { type ClosedTabEntry } from "../workspaceTabPolicy";
import { useWorkspaceSession } from "./useWorkspaceSession";


export interface UseWorkspaceSurfaceStateContext {
  session: ReturnType<typeof useWorkspaceSession>;
}

export function useWorkspaceSurfaceState(context: UseWorkspaceSurfaceStateContext) {
  const { session } = context;
  const [externalFileConflicts, setExternalFileConflicts] = useState<PendingExternalFileConflict[]>([]);
  const pendingExternalFileEventsRef = useRef(new Map<string, PendingExternalFileEvent>());
  const [fileEncodingDialogOpen, setFileEncodingDialogOpen] = useState(false);
  const pendingEncodingDialogFileKeyRef = useRef<string | null>(null);
  const activeEditorGroupIdRef = useRef<EditorGroupId>("primary");
  const [revealTarget, setRevealTarget] = useState<EditorRevealTarget | null>(null);
  // Editor keys whose library sources are being fetched (drives the button spinner).
  const [downloadingSourcesKeys, setDownloadingSourcesKeys] = useState<string[]>([]);
  const [activeCompareSession, setActiveCompareSession] = useState<EditorCompareSession | null>(null);
  const revealNonceRef = useRef(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const editorPaneRef = useRef<HTMLElement | null>(null);
  /** ED-PARITY-020 DEC-020-01: caret popup for empty/unavailable code insight. */
  const [codeInsightNotice, setCodeInsightNotice] = useState<CodeInsightNoticeState | null>(null);
  const codeInsightNoticeSeqRef = useRef(0);
  /** ED-PARITY-014 DEC-014-04: File Structure shows a syntax-only outline. */
  const [structureSyntaxOnly, setStructureSyntaxOnly] = useState(false);
  /** ED-PARITY-018: the Git tool window mounts on first open, then stays. */
  const [gitToolWindowMounted, setGitToolWindowMounted] = useState(false);
  const showCodeInsightNotice = useCallback((message: string, action: "configure" | null = null) => {
    codeInsightNoticeSeqRef.current += 1;
    setCodeInsightNotice({
      id: codeInsightNoticeSeqRef.current,
      message,
      action,
      anchor: caretAnchor(editorPaneRef.current),
    });
  }, []);
  const inactiveEditorPaneRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setExternalFileConflicts([]);
  }, [session.workspaceInstanceId]);

  useEffect(() => {
    activeEditorGroupIdRef.current = session.workspaceUi.activeEditorGroupId;
  }, [session.workspaceUi.activeEditorGroupId]);
  const [dapGuideOpen, setDapGuideOpen] = useState(false);
  const [keymapCheatSheetOpen, setKeymapCheatSheetOpen] = useState(false);

  // §8.18.5 closed-tab reopen stack (session-only, max 50, never persisted).
  const [closedTabsStack, setClosedTabsStack] = useState<readonly ClosedTabEntry[]>([]);
  const [toolbarMoreOpen, setToolbarMoreOpen] = useState(false);
  /** ED-PARITY-012 DEC-012-06: pending Go to Line:Column dialog. */
  const [goToLineRequest, setGoToLineRequest] = useState<GoToLineRequest | null>(null);
  useEffect(() => {
    if (session.workspaceUi.bottomDockOpen && session.workspaceUi.bottomDockTab === "git") setGitToolWindowMounted(true);
  }, [session.workspaceUi.bottomDockOpen, session.workspaceUi.bottomDockTab]);
  // The ⋮ menu closes on any outside press or Esc without swallowing that
  // press, so the next toolbar/editor click still reaches its target.
  useEffect(() => {
    if (!toolbarMoreOpen) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[data-testid="code-workspace-toolbar-more-menu"], [data-testid="code-workspace-toolbar-more"]')) return;
      setToolbarMoreOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setToolbarMoreOpen(false);
    };
    document.addEventListener("mousedown", onPointer, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onPointer, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [toolbarMoreOpen]);
  return {
    activeEditorGroupIdRef,
    rootRef,
    revealNonceRef,
    setRevealTarget,
    setActiveCompareSession,
    setExternalFileConflicts,
    pendingExternalFileEventsRef,
    setClosedTabsStack,
    setFileEncodingDialogOpen,
    pendingEncodingDialogFileKeyRef,
    downloadingSourcesKeys,
    setDownloadingSourcesKeys,
    showCodeInsightNotice,
    editorPaneRef,
    setStructureSyntaxOnly,
    closedTabsStack,
    setKeymapCheatSheetOpen,
    setDapGuideOpen,
    keymapCheatSheetOpen,
    setGoToLineRequest,
    inactiveEditorPaneRef,
    revealTarget,
    gitToolWindowMounted,
    dapGuideOpen,
    codeInsightNotice,
    setCodeInsightNotice,
    goToLineRequest,
    activeCompareSession,
    externalFileConflicts,
    fileEncodingDialogOpen,
    structureSyntaxOnly,
    toolbarMoreOpen,
    setToolbarMoreOpen,
  };
}
