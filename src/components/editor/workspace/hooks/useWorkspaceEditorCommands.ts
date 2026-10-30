import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { type LspPosition } from "../../../../lib/editor/lsp";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore, type EditorGroupId } from "../../../../stores/codeWorkspaceStore";
import {
  type EditorCommandId,
  type EditorCommandOptions,
  type EditorCommandPort,
  type EditorCommandPortRegistration,
  type EditorCommandState,
  type EditorCommandTarget,
  type EditorSelectionRange,
} from "../CodeMirrorHost";
import { type OpenFileState } from "../codeWorkspaceModel";
import { type TreeOpenIntent } from "../controller/mutationTypes";
import { type WorkspaceCommandContext } from "../workspaceCommands";
import { useWorkspacePaintQueue } from "./useWorkspacePaintQueue";


export interface UseWorkspaceEditorCommandsContext {
  pendingTreeOpenIntentRef: import("react").RefObject<TreeOpenIntent | null>;
  tryGrantTreeFocusRef: import("react").RefObject<(intent: TreeOpenIntent, canonicalKey: string) => boolean>;
  workspaceInstanceId: string;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  editorSelectionRef: import("react").RefObject<EditorSelectionRange>;
}

export function useWorkspaceEditorCommands(dependencies: UseWorkspaceEditorCommandsContext) {
  const { workspaceInstanceId, openFilesRef } = dependencies;
  const editorCommandPortsRef = useRef(new Map<EditorGroupId, {
    fileKey: string;
    token: object;
    port: EditorCommandPort;
  }>());

  const contextChanges = useRef({ revision: 0, pending: false, listeners: new Set<() => void>() });
  const projectAfterPaint = useWorkspacePaintQueue();
  const subscribeEditorCommandContext = useCallback((listener: () => void) => {
    contextChanges.current.listeners.add(listener);
    return () => { contextChanges.current.listeners.delete(listener); };
  }, []);
  // Dispatch reads live ports. Only menu consumers need the combined selection
  // notification after paint; the editor's runtime owner needs no render.
  const setEditorCommandContextRevision = useCallback<Dispatch<SetStateAction<number>>>((update) => {
    const changes = contextChanges.current;
    changes.revision = typeof update === "function" ? update(changes.revision) : update;
    if (changes.pending) return;
    changes.pending = true;
    projectAfterPaint(() => {
      changes.pending = false;
      for (const listener of changes.listeners) listener();
    });
  }, [projectAfterPaint]);
  useEffect(() => () => {
    contextChanges.current.pending = false;
    contextChanges.current.listeners.clear();
  }, []);
  /** Selection-derived action-context flags last published (see onSelectionChange). */
  const editorCommandSignatureRef = useRef<string | null>(null);
  const registerEditorCommandPort = useCallback((
    groupId: EditorGroupId,
    registration: EditorCommandPortRegistration,
  ) => {
    const current = editorCommandPortsRef.current.get(groupId);
    if (registration.port) {
      editorCommandPortsRef.current.set(groupId, {
        fileKey: registration.fileKey,
        token: registration.token,
        port: registration.port,
      });
      setEditorCommandContextRevision((revision) => revision + 1);
      if (dependencies.pendingTreeOpenIntentRef.current) {
        const intent = dependencies.pendingTreeOpenIntentRef.current;
        if (intent.groupId === groupId) {
          const expectedKey = intent.canonicalFileKey ?? intent.requestedFileKey;
          if (expectedKey === registration.fileKey) {
            dependencies.tryGrantTreeFocusRef.current(intent, registration.fileKey);
          }
        }
      }
      return;
    }
    if (
      current?.fileKey !== registration.fileKey
      || current.token !== registration.token
    ) {
      return;
    }
    editorCommandPortsRef.current.delete(groupId);
    setEditorCommandContextRevision((revision) => revision + 1);
  }, []);
  const activeEditorCommandOwner = useCallback(() => {
    const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
    const groupId = ui.activeEditorGroupId;
    const fileKey = ui.editorGroups[groupId]?.activeKey ?? null;
    const owner = editorCommandPortsRef.current.get(groupId) ?? null;
    return owner && fileKey === owner.fileKey ? owner : null;
  }, [workspaceInstanceId]);
  /**
   * Owner lookup pinned to an explicit recursive leaf. Context menus freeze
   * `{groupId, fileKey}` at open time; this guard keeps a later active-group
   * change from redirecting their execution to a different editor.
   */
  const editorCommandOwnerFor = useCallback((groupId: string, fileKey: string) => {
    const owner = editorCommandPortsRef.current.get(groupId as EditorGroupId) ?? null;
    return owner && owner.fileKey === fileKey ? owner : null;
  }, []);
  const activeEditorCommandState = useCallback((): EditorCommandState | null => {
    return activeEditorCommandOwner()?.port.state() ?? null;
  }, [activeEditorCommandOwner]);
  const isActiveEditorReady = useCallback(() => {
    const owner = activeEditorCommandOwner();
    return !!owner && !!openFilesRef.current[owner.fileKey] && !openFilesRef.current[owner.fileKey].loading;
  }, [activeEditorCommandOwner, openFilesRef]);
  const executeActiveEditorCommand = useCallback((commandId: EditorCommandId, options?: EditorCommandOptions) => {
    return activeEditorCommandOwner()?.port.execute(commandId, options) ?? false;
  }, [activeEditorCommandOwner]);
  const executeEditorCommandFor = useCallback((
    target: EditorCommandTarget | undefined,
    commandId: EditorCommandId,
    options?: EditorCommandOptions,
  ) => {
    if (target) {
      return editorCommandOwnerFor(target.groupId, target.fileKey)
        ?.port.execute(commandId, options) ?? false;
    }
    return executeActiveEditorCommand(commandId, options);
  }, [editorCommandOwnerFor, executeActiveEditorCommand]);
  const executeEditorCommand = useCallback((commandId: EditorCommandId, context?: WorkspaceCommandContext) => {
    const target = context?.payload as EditorCommandTarget | undefined;
    if (
      target
      && typeof target === "object"
      && typeof target.groupId === "string"
      && typeof target.fileKey === "string"
    ) {
      return executeEditorCommandFor(target, commandId);
    }
    return executeActiveEditorCommand(commandId);
  }, [executeActiveEditorCommand, executeEditorCommandFor]);
  /**
   * Availability state for a command invocation. A context-menu payload pins
   * the owning leaf; without one (keyboard, palette) the active leaf answers.
   */
  const editorCommandStateFor = useCallback((context?: WorkspaceCommandContext): EditorCommandState | null => {
    const target = context?.payload as EditorCommandTarget | undefined;
    if (
      target
      && typeof target === "object"
      && typeof target.groupId === "string"
      && typeof target.fileKey === "string"
    ) {
      return editorCommandOwnerFor(target.groupId, target.fileKey)?.port.state() ?? null;
    }
    return activeEditorCommandState();
  }, [activeEditorCommandState, editorCommandOwnerFor]);
  const handleReturnToEditor = useCallback(() => {
    const owner = activeEditorCommandOwner();
    if (owner?.port?.focus) {
      owner.port.focus({ preventScroll: true });
      return;
    }
    const cmContent = document.querySelector<HTMLElement>(".cm-editor .cm-content");
    cmContent?.focus({ preventScroll: true });
  }, [activeEditorCommandOwner]);
  /**
   * Resolve a provider-action invocation target. Context-menu payloads carry
   * the clicked file and position; keyboard/palette invocations fall back to
   * the active file at the current selection.
   */
  const resolveEditorTarget = useCallback((context?: WorkspaceCommandContext): {
    file: OpenFileState | null;
    position: LspPosition | undefined;
  } => {
    const payload = context?.payload as {
      groupId?: unknown;
      fileKey?: unknown;
      position?: LspPosition;
    } | undefined;
    if (typeof payload === "object" && payload !== null && typeof payload.fileKey === "string") {
      const file = openFilesRef.current[payload.fileKey] ?? null;
      return { file, position: payload.position };
    }
    // activeKeyRef is declared later in the component (keyboard switcher owns
    // it), so read through the store for the fallback active file.
    const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
    const file = openFilesRef.current[ui.activeKey ?? ""] ?? null;
    return { file, position: dependencies.editorSelectionRef.current.end };
  }, [workspaceInstanceId]);
  return {
    editorCommandOwnerFor, handleReturnToEditor, resolveEditorTarget, executeActiveEditorCommand,
    executeEditorCommand, editorCommandStateFor, activeEditorCommandState, isActiveEditorReady,
    get editorCommandContextRevision() { return contextChanges.current.revision; },
    subscribeEditorCommandContext, activeEditorCommandOwner, executeEditorCommandFor,
    editorCommandSignatureRef, setEditorCommandContextRevision, registerEditorCommandPort,
  };
}
