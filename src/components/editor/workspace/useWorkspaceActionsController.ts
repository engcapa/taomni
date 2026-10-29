import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type WorkspaceActionContext,
  type ActionState,
  type ActionResult,
  type WorkspaceFocus,
} from "./workspaceActionRegistry";
import {
  type WorkspaceCommand,
  type WorkspaceCommandMenuItem,
  type WorkspaceCommandRegistration,
  type KeyboardEventLike,
} from "./workspaceCommands";
import {
  type ActionInvocation,
  type ActionSnapshotItem,
  type BindingConflictNotice,
  type KeyDispatchContextV2,
  type KeyDispatchResult,
  WorkspaceActionHost,
} from "./workspaceActionHost";
import { createWorkspaceActionProjection, type WorkspaceActionProjection } from "./workspaceActionProjection";

export interface UseWorkspaceActionsControllerOptions {
  workspaceId?: string;
  commands: readonly WorkspaceCommand[];
  activeFocus?: WorkspaceFocus;
  resolveFocus?: (target: EventTarget | null) => WorkspaceFocus;
  getDefaultFocus?: () => WorkspaceFocus;
  contextData?: Partial<WorkspaceActionContext>;
  /** Read live owners for dispatch while their secondary UI render is pending. */
  getContextData?: () => Partial<WorkspaceActionContext>;
  /** Deferred display notifications from live editor ports and selections. */
  subscribeContextChanges?: (listener: () => void) => () => void;
  onCommandExecuted?: (commandId: string, result?: ActionResult) => void;
  /** ED-PARITY-004 DEC-05: observable rejection for ambiguous strokes. */
  onBindingConflict?: (notice: BindingConflictNotice) => void;
}

export interface WorkspaceActionsController {
  host: WorkspaceActionHost;
  executeCommand: (commandId: string, payload?: unknown) => boolean;
  executeAction: (commandId: string, payload?: unknown, signal?: AbortSignal) => Promise<ActionResult>;
  dispatchKeydown: (
    event: KeyboardEventLike,
    options?: { eventTarget?: EventTarget | null } | ActionInvocation,
  ) => Promise<{ id: string; result: ActionResult } | null>;
  /** §8.19.2 typed gated entry (composing/dead-key/AltGr/chord results). */
  dispatchKeydownV2: (context: KeyDispatchContextV2) => KeyDispatchResult;
  getActionState: (commandId: string, payload?: unknown) => ActionState;
  menuItems: WorkspaceCommandMenuItem[];
  /** Instance-scoped snapshot: the single runtime truth for all surfaces. */
  snapshot: ActionSnapshotItem[];
  commandRegistration: WorkspaceCommandRegistration;
  projection: WorkspaceActionProjection;
}

/**
 * Controller hook managing workspace action registration, keydown dispatch,
 * state evaluation, and menu integration (E0.1, E0.2, N0.1, Gate R0).
 */
export function useWorkspaceActionsController({
  workspaceId = "default-workspace",
  commands,
  activeFocus = "workspace",
  resolveFocus,
  getDefaultFocus,
  contextData,
  getContextData,
  subscribeContextChanges,
  onCommandExecuted,
  onBindingConflict,
}: UseWorkspaceActionsControllerOptions): WorkspaceActionsController {
  const commandsRef = useRef(commands);
  commandsRef.current = commands;

  const activeFocusRef = useRef(activeFocus);
  activeFocusRef.current = activeFocus;

  const resolveFocusRef = useRef(resolveFocus);
  resolveFocusRef.current = resolveFocus;

  const getDefaultFocusRef = useRef(getDefaultFocus);
  getDefaultFocusRef.current = getDefaultFocus;

  const contextDataRef = useRef(contextData);
  contextDataRef.current = contextData;
  const getContextDataRef = useRef(getContextData);
  getContextDataRef.current = getContextData;

  const onCommandExecutedRef = useRef(onCommandExecuted);
  onCommandExecutedRef.current = onCommandExecuted;

  const onBindingConflictRef = useRef(onBindingConflict);
  onBindingConflictRef.current = onBindingConflict;

  // §8.16.3 Gate-R1 lifecycle: the host lives in lazily-created state (never
  // useMemo, which React may drop). Real unmount disposes the host; StrictMode's
  // transient effect cleanup also runs dispose, so the effect self-heals by
  // minting a fresh host when it observes a disposed instance. Disposed hosts
  // answer typed failed results and never re-register stale commands.
  const createHost = useCallback(() => new WorkspaceActionHost({
    workspaceId,
    getDefaultContext: () => ({ ...contextDataRef.current, ...getContextDataRef.current?.() }),
    resolveFocus: (target) =>
      resolveFocusRef.current ? resolveFocusRef.current(target) : (activeFocusRef.current ?? "workspace"),
    getDefaultFocus: () =>
      getDefaultFocusRef.current ? getDefaultFocusRef.current() : (activeFocusRef.current ?? "workspace"),
    onExecuted: (id, res) => onCommandExecutedRef.current?.(id, res),
    onBindingConflict: (notice) => onBindingConflictRef.current?.(notice),
  }), [workspaceId]);

  const [host, setHost] = useState(() => createHost());
  const hostRef = useRef(host);
  hostRef.current = host;

  /**
   * Lazy self-heal (§8.16.3): a disposed host (real unmount, or StrictMode's
   * transient cleanup) is replaced on the next accessor call instead of
   * poisoning the controller with typed failures forever.
   */
  const ensureLiveHost = useCallback((): WorkspaceActionHost => {
    const current = hostRef.current;
    if (!current.isDisposed()) return current;
    const fresh = createHost();
    hostRef.current = fresh;
    setHost(fresh);
    return fresh;
  }, [createHost]);

  useEffect(() => {
    const current = hostRef.current;
    if (current.isDisposed()) {
      ensureLiveHost();
      return;
    }
    return () => {
      current.dispose();
    };
  }, [ensureLiveHost, host]);

  const executeAction = useCallback(
    async (commandId: string, payload?: unknown, signal?: AbortSignal): Promise<ActionResult> => {
      return ensureLiveHost().execute(commandId, payload, signal);
    },
    [ensureLiveHost],
  );

  const executeCommand = useCallback(
    (commandId: string, payload?: unknown): boolean => {
      const live = ensureLiveHost();
      const state = live.getState(commandId, payload);
      if (state.availability !== "available") return false;
      void live.execute(commandId, payload);
      return true;
    },
    [ensureLiveHost],
  );

  const dispatchKeydown = useCallback(
    async (
      event: KeyboardEventLike,
      options?: { eventTarget?: EventTarget | null } | ActionInvocation,
    ): Promise<{ id: string; result: ActionResult } | null> => {
      return ensureLiveHost().dispatchKeydown(event, options);
    },
    [ensureLiveHost],
  );

  /** §8.19.2: typed gated dispatch; workspaceId is enforced by the host. */
  const dispatchKeydownV2 = useCallback(
    (context: KeyDispatchContextV2): KeyDispatchResult => {
      const live = ensureLiveHost();
      return live.dispatchKeydownV2({ ...context, workspaceId: live.getWorkspaceId() });
    },
    [ensureLiveHost],
  );

  const getActionState = useCallback(
    (commandId: string, payload?: unknown): ActionState => {
      return ensureLiveHost().getState(commandId, payload);
    },
    [ensureLiveHost],
  );

  const contextKey = useMemo(() => ({}), [host, activeFocus, contextData, getContextData]);
  const contextKeyRef = useRef(contextKey);
  contextKeyRef.current = contextKey;
  const executionRef = useRef({ executeAction, executeCommand });
  executionRef.current = { executeAction, executeCommand };
  const [projection] = useState(() => createWorkspaceActionProjection(
    () => ({ host: hostRef.current, contextKey: contextKeyRef.current }),
    (...args) => executionRef.current.executeAction(...args),
    (...args) => executionRef.current.executeCommand(...args),
  ));

  useEffect(() => {
    if (host.isDisposed()) return;
    const unregister = host.registerCommands(commands);
    projection.publish();
    return unregister;
  }, [host, commands, projection]);
  useEffect(() => projection.publish(), [projection, contextKey]);
  useEffect(() => subscribeContextChanges?.(projection.publish), [projection, subscribeContextChanges]);

  return {
    host,
    executeCommand,
    executeAction,
    dispatchKeydown,
    dispatchKeydownV2,
    getActionState,
    get menuItems() { return projection.getSnapshot().menuItems; },
    get snapshot() { return projection.getSnapshot().snapshot; },
    get commandRegistration() { return projection.getSnapshot().commandRegistration; },
    projection,
  };
}
