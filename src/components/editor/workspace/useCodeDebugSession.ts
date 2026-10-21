import { useCallback, useEffect, useRef, useState } from "react";
import { useMountedRef } from "../../../hooks/useMountedRef";
import { dapSendRequest, dapTerminate } from "../../../lib/editor/dap";
import { appendConsoleLine, currentLocation, initialDebugState, parseEvaluate, parseExceptionInfo, effectiveSuspend, isBreakpointEnabled, parseStackFrames, parseStackTotal, parseThreads, type DebugBreakpoint, type DebugExceptionBreakpointFilter, type DebugSessionState, type DebugStackFrame } from "./dapDebugModel";
import { breakpointHitLogText, breakpointMasterKeys, breakpointRefKey, dependentsOf, logTemplateParts, masterOf, needsClientHit } from "./debugBreakpointProperties";
import { fsPathEquals } from "./codeWorkspaceModel";
import { type CodeDebugSession, type DebugSessionSummary, type DebugActionResult, type DebugSessionRecord, type LastDebugLaunch } from "./debug/types";
import { FRAME_PAGE_SIZE } from "./debug/breakpointPersistence";
import { errorText } from "./debug/errors";
import { useBreakpointSynchronization } from "./debug/useBreakpointSynchronization";
import { useBreakpointActions } from "./debug/useBreakpointActions";
import { useDebugInspection } from "./debug/useDebugInspection";
import { useDebugLaunch } from "./debug/useDebugLaunch";
import { useDebugEvents } from "./debug/useDebugEvents";
import { useBreakpointState } from "./debug/useBreakpointState";
import { useDebugWatches } from "./debug/useDebugWatches";
import { useDebugExecution } from "./debug/useDebugExecution";









export function useCodeDebugSession(workspaceInstanceId: string): CodeDebugSession {
  const [state, setState] = useState<DebugSessionState | null>(null);
  const { setBreakpointRuntime, setFunctionBreakpointRuntime, setInstructionBreakpointRuntime, setDataBreakpointRuntime, setExceptionBreakpointRuntime, setExceptionBreakpointRuleRuntime, breakpointsRef, mutedRef, setBreakpoints, persistBreakpoints, functionBreakpointsRef, instructionBreakpointsRef, dataBreakpointsRef, exceptionBreakpointsRef, exceptionBreakpointRulesRef, dropSessionDataBreakpoints, setExceptionBreakpoints, persistExceptionBreakpoints, setFunctionBreakpoints, persistFunctionBreakpoints, setInstructionBreakpoints, persistInstructionBreakpoints, setDataBreakpoints, persistDataBreakpoints, setBreakpointsMutedState, setExceptionBreakpointRules, persistExceptionBreakpointRules, breakpoints, breakpointRuntime, functionBreakpoints, functionBreakpointRuntime, instructionBreakpoints, instructionBreakpointRuntime, dataBreakpoints, dataBreakpointRuntime, exceptionBreakpoints, exceptionBreakpointRuntime, exceptionBreakpointRules, exceptionBreakpointRuleRuntime, breakpointsMuted } = useBreakpointState({
    workspaceInstanceId,
    get mountedRef() { return mountedRef; },
  });
  const [capabilities, setCapabilities] = useState<Record<string, unknown>>({});
  const [availableFilters, setAvailableFilters] = useState<DebugExceptionBreakpointFilter[]>([]);
  const { watchExpressions, watchItems, addWatchExpression, removeWatchExpression } = useDebugWatches({
    workspaceInstanceId,
  });
  const [isStepping, setIsStepping] = useState(false);
  const [canRestart, setCanRestart] = useState(false);
  const [frameVariables, setFrameVariables] = useState<Record<string, string>>({});
  const [sessions, setSessions] = useState<DebugSessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [consoleGeneration, setConsoleGeneration] = useState(0);
  const consoleGenerationRef = useRef(0);

  const bumpConsoleGeneration = useCallback(() => {
    consoleGenerationRef.current += 1;
    setConsoleGeneration(consoleGenerationRef.current);
  }, []);

  const stepInFlightRef = useRef<Promise<DebugActionResult> | null>(null);
  const sessionsRef = useRef(new Map<string, DebugSessionRecord>());
  const abortedScopesRef = useRef(new Set<string>());
  const activeSessionIdRef = useRef<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const capabilitiesRef = useRef<Record<string, unknown>>({});
  const stateRef = useRef<DebugSessionState | null>(null);
  const mountedRef = useMountedRef();
  /** Bumped on every `stopped` event; async work checks it to drop stale results. */
  const stopEpochRef = useRef(0);
  /** Adapter breakpoint id → file path, to route `breakpoint` events. */
  const bpIdIndexRef = useRef(new Map<number, { path: string }>());
  /** Per-path `setBreakpoints` generation, so a late response cannot win. */
  const syncGenerationRef = useRef(new Map<string, number>());
  /** Pending run-to-cursor: its transient breakpoint is removed on the next stop. */
  const tempRunToCursorRef = useRef<{ path: string } | null>(null);
  const lastLaunchRef = useRef<LastDebugLaunch | null>(null);
  /** Whether the adapter has emitted `initialized` for the current session. */
  const initializedRef = useRef(false);
  stateRef.current = state;

  const publishSessionList = useCallback(() => {
    if (!mountedRef.current) return;
    setSessions(Array.from(sessionsRef.current.values())
      .sort((left, right) => left.order - right.order)
      .map((record) => ({
        id: record.id,
        targetId: record.targetId,
        label: record.label,
        adapterId: record.adapterId,
        status: record.state.status,
        stoppedReason: record.state.stoppedReason,
      })));
  }, []);

  const publishActiveSession = useCallback((record: DebugSessionRecord | null) => {
    activeSessionIdRef.current = record?.id ?? null;
    sessionIdRef.current = record?.live ? record.id : null;
    capabilitiesRef.current = record?.capabilities ?? {};
    stopEpochRef.current = record?.stopEpoch ?? 0;
    bpIdIndexRef.current = record?.bpIdIndex ?? new Map();
    syncGenerationRef.current = record?.syncGeneration ?? new Map();
    tempRunToCursorRef.current = record?.tempRunToCursor ?? null;
    initializedRef.current = record?.initialized ?? false;
    stateRef.current = record?.state ?? null;
    if (!mountedRef.current) return;
    setActiveSessionId(record?.id ?? null);
    setState(record?.state ?? null);
    setCapabilities(record?.capabilities ?? {});
    setAvailableFilters(record?.availableFilters ?? []);
    setBreakpointRuntime(record?.breakpointRuntime ?? {});
    setFunctionBreakpointRuntime(record?.functionBreakpointRuntime ?? {});
    setInstructionBreakpointRuntime(record?.instructionBreakpointRuntime ?? {});
    setDataBreakpointRuntime(record?.dataBreakpointRuntime ?? {});
    setExceptionBreakpointRuntime(record?.exceptionBreakpointRuntime ?? {});
    setExceptionBreakpointRuleRuntime(record?.exceptionBreakpointRuleRuntime ?? {});
    setFrameVariables(record?.frameVariables ?? {});
  }, []);

  const updateSessionState = useCallback((
    sessionId: string,
    updater: (current: DebugSessionState) => DebugSessionState,
  ) => {
    const record = sessionsRef.current.get(sessionId);
    if (!record) return;
    record.state = updater(record.state);
    if (activeSessionIdRef.current === sessionId) {
      stateRef.current = record.state;
      if (mountedRef.current) setState(record.state);
    }
    publishSessionList();
  }, [publishSessionList]);

  const selectSession = useCallback((sessionId: string) => {
    const record = sessionsRef.current.get(sessionId);
    if (record) publishActiveSession(record);
  }, [publishActiveSession]);

  // Drop the adapter session with the hook. `mountedRef` re-arms itself (see
  // useMountedRef) so the StrictMode dev double-invoke cannot leave it false.
  useEffect(() => () => {
    for (const record of sessionsRef.current.values()) {
      record.unlisten?.();
      if (record.live) void dapTerminate(record.id).catch(() => {});
    }
    sessionsRef.current.clear();
  }, []);

  // Inline values are only meaningful while stopped: drop them the moment the
  // debuggee resumes or the session ends, so stale numbers never sit in the
  // editor gutter.
  const debugStatus = state?.status ?? null;
  useEffect(() => {
    if (debugStatus !== "stopped") {
      const active = activeSessionIdRef.current
        ? sessionsRef.current.get(activeSessionIdRef.current)
        : undefined;
      if (active) active.frameVariables = {};
      setFrameVariables({});
    }
  }, [debugStatus]);

  const updateActiveState = useCallback((
    updater: (current: DebugSessionState) => DebugSessionState,
  ) => {
    const id = activeSessionIdRef.current;
    if (id && sessionsRef.current.has(id)) {
      updateSessionState(id, updater);
      return;
    }
    setState((prev) => (prev ? updater(prev) : prev));
  }, [updateSessionState]);

  const logConsole = useCallback((category: string, text: string) => {
    if (!text) return;
    updateActiveState((prev) => ({
      ...prev,
      output: [...prev.output, { category, text }].slice(-2000),
    }));
  }, [updateActiveState]);

  const clearConsole = useCallback(() => {
    bumpConsoleGeneration();
    updateActiveState((prev) => (prev.output.length > 0 ? { ...prev, output: [] } : prev));
  }, [bumpConsoleGeneration, updateActiveState]);

  /**
   * Show a launch failure in the Debug panel. When a session is already present
   * (e.g. `dapStartSession` succeeded but `launch` was rejected) the message is
   * appended and the session marked terminated; otherwise a minimal terminated
   * session is seeded so the panel renders its console instead of the empty
   * "no debug session" placeholder. The seeded session has an empty id, so it is
   * inert (no adapter events match it, terminate is a no-op) and the next Start
   * replaces it.
   */
  const reportStartupFailure = useCallback((message: string) => {
    if (!mountedRef.current) return;
    const text = message.endsWith("\n") ? message : `${message}\n`;
    const active = activeSessionIdRef.current;
    if (active && sessionsRef.current.has(active)) {
      const record = sessionsRef.current.get(active)!;
      updateSessionState(active, (prev) => appendConsoleLine(
        record.live ? prev : { ...prev, status: "terminated" },
        "stderr",
        text,
      ));
    } else {
      // Pre-adapter steps can complete in one React batch. Mirror the update
      // synchronously so a following startDebug can carry every queued line.
      const current = stateRef.current;
      const next = appendConsoleLine(
        current
          ? { ...current, status: "terminated" }
          : { ...initialDebugState(""), status: "terminated" },
        "stderr",
        text,
      );
      stateRef.current = next;
      setState(next);
    }
  }, [updateSessionState]);

  /**
   * Show a pre-launch step in the panel. Seeds a `starting` session (empty id →
   * inert: no adapter events match it and terminate is a no-op) so the console
   * is on screen from the first click; a prior terminated session is replaced
   * rather than appended to, so stale output from the last run is not mistaken
   * for this one.
   */
  const reportStartupProgress = useCallback((message: string) => {
    if (!mountedRef.current) return;
    const text = message.endsWith("\n") ? message : `${message}\n`;
    const active = activeSessionIdRef.current;
    if (active && sessionsRef.current.has(active)) {
      updateSessionState(active, (prev) => appendConsoleLine(prev, "console", text));
    } else {
      // Keep the inert startup session coherent before React flushes state.
      // Build, resolve and launch commonly finish inside the same async batch.
      const current = stateRef.current;
      const next = appendConsoleLine(
        current && current.status !== "terminated" ? current : initialDebugState(""),
        "console",
        text,
      );
      stateRef.current = next;
      setState(next);
    }
  }, [updateSessionState]);
  const { syncBreakpointsForPath, syncFunctionBreakpoints, syncInstructionBreakpoints, syncDataBreakpoints, syncExceptionBreakpoints } = useBreakpointSynchronization({
    breakpointsRef,
    sessionsRef,
    mutedRef,
    updateSessionState,
    mountedRef,
    activeSessionIdRef,
    setBreakpointRuntime,
    setBreakpoints,
    persistBreakpoints,
    functionBreakpointsRef,
    setFunctionBreakpointRuntime,
    instructionBreakpointsRef,
    setInstructionBreakpointRuntime,
    dataBreakpointsRef,
    setDataBreakpointRuntime,
    exceptionBreakpointsRef,
    exceptionBreakpointRulesRef,
    setExceptionBreakpointRuntime,
    setExceptionBreakpointRuleRuntime,
  });

  /**
   * Single mutation path for the breakpoint map. Updates the ref synchronously
   * (so an immediately-following adapter sync sees the new set), persists, and
   * pushes the changed file to a live adapter.
   */
  const mutateBreakpoints = useCallback((
    path: string,
    updater: (list: DebugBreakpoint[]) => DebugBreakpoint[],
    options: { sessionIds?: readonly string[] } = {},
  ) => {
    const nextList = updater(breakpointsRef.current[path] ?? []);
    const next = { ...breakpointsRef.current };
    if (nextList.length > 0) next[path] = nextList;
    else delete next[path];
    breakpointsRef.current = next;
    setBreakpoints(next);
    persistBreakpoints(next);
    void syncBreakpointsForPath(path, { list: nextList, sessionIds: options.sessionIds });
  }, [persistBreakpoints, syncBreakpointsForPath]);

  /** The stored breakpoint a `breakpoint` stop landed on (its top frame). */
  const findHitBreakpoint = useCallback((frames: DebugStackFrame[]) => {
    const top = frames[0];
    if (!top?.path) return null;
    for (const [path, list] of Object.entries(breakpointsRef.current)) {
      if (!fsPathEquals(path, top.path)) continue;
      const bp = list.find((entry) => entry.line === top.line && isBreakpointEnabled(entry));
      if (bp) return { path, bp };
    }
    return null;
  }, []);

  /**
   * Run the IDEA breakpoint actions DAP cannot express for one hit: log the
   * hit message / stack trace / evaluated values, remove a temporary
   * breakpoint, arm the master's dependents and disarm a dependent that is
   * disabled again after its hit.
   */
  const applyBreakpointHit = useCallback(async (
    sessionId: string,
    hit: { path: string; bp: DebugBreakpoint },
    frames: DebugStackFrame[],
  ) => {
    const record = sessionsRef.current.get(sessionId);
    if (!record) return;
    const { path, bp } = hit;
    const frameId = frames[0]?.id;
    const evaluateText = async (expression: string): Promise<string> => {
      const body = await dapSendRequest(sessionId, "evaluate", { expression, frameId, context: "watch" })
        .catch((error) => ({ result: `Error: ${errorText(error)}` }));
      return parseEvaluate(body).value;
    };
    const expression = bp.logExpression?.trim() ? await evaluateText(bp.logExpression.trim()) : null;
    let template: string | null = null;
    if (effectiveSuspend(bp) && bp.logMessage?.trim()) {
      const parts = await Promise.all(logTemplateParts(bp.logMessage.trim()).map((part) => (
        "text" in part ? Promise.resolve(part.text) : evaluateText(part.expression)
      )));
      template = parts.join("");
    }
    const text = breakpointHitLogText(bp, frames, { expression, template });
    if (text && mountedRef.current) {
      updateSessionState(sessionId, (current) => appendConsoleLine(current, "console", text));
    }
    const map = breakpointsRef.current;
    const touched = new Set<string>();
    for (const dependent of dependentsOf({ path, line: bp.line }, map)) {
      record.armedDependents.add(breakpointRefKey(dependent.path, dependent.line));
      touched.add(dependent.path);
    }
    if (masterOf(bp, map) && !bp.leaveEnabled && record.armedDependents.delete(breakpointRefKey(path, bp.line))) {
      touched.add(path);
    }
    if (bp.temporary) {
      // Removing re-syncs this file for every session.
      mutateBreakpoints(path, (list) => list.filter((entry) => entry.line !== bp.line));
      touched.delete(path);
    }
    await Promise.all(Array.from(touched, (touchedPath) => (
      syncBreakpointsForPath(touchedPath, { sessionIds: [sessionId] })
    )));
  }, [mountedRef, mutateBreakpoints, syncBreakpointsForPath, updateSessionState]);

  /**
   * Snapshot the frame's local variables as `name → value` for the editor's
   * inline values (IDEA renders them next to the code). Only the first scope is
   * read: adapters list locals first, and globals/statics are neither on screen
   * nor worth an extra round trip on every step.
   */
  const refreshFrameVariables = useCallback(async (frameId: number, epoch: number) => {
    const id = sessionIdRef.current;
    const record = id ? sessionsRef.current.get(id) : undefined;
    if (!id || !record) return;
    const scopesBody = await dapSendRequest(id, "scopes", { frameId }).catch(() => null);
    const scopes = (scopesBody as { scopes?: unknown } | null)?.scopes;
    const localRef = Array.isArray(scopes)
      ? scopes
        .map((s) => (s && typeof s === "object" ? (s as Record<string, unknown>) : {}))
        .find((s) => typeof s.variablesReference === "number" && s.variablesReference > 0)
      : undefined;
    const ref = typeof localRef?.variablesReference === "number" ? localRef.variablesReference : 0;
    if (ref <= 0) {
      if (mountedRef.current && record.stopEpoch === epoch) {
        record.frameVariables = {};
        if (activeSessionIdRef.current === id) setFrameVariables({});
      }
      return;
    }
    const body = await dapSendRequest(id, "variables", { variablesReference: ref }).catch(() => null);
    const list = (body as { variables?: unknown } | null)?.variables;
    const map: Record<string, string> = {};
    if (Array.isArray(list)) {
      for (const entry of list) {
        const rec = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
        if (typeof rec.name === "string" && typeof rec.value === "string") map[rec.name] = rec.value;
      }
    }
    if (mountedRef.current && record.stopEpoch === epoch) {
      record.frameVariables = map;
      if (activeSessionIdRef.current === id) setFrameVariables(map);
    }
  }, []);

  /** After a `stopped` event, pull threads + stack + exception details for the UI. */
  const refreshStoppedContext = useCallback(async (
    sessionId: string,
    threadId: number | null,
    reason: string | null,
    epoch: number,
  ) => {
    const record = sessionsRef.current.get(sessionId);
    if (!record) return;
    const threadsBody = await dapSendRequest(sessionId, "threads").catch(() => null);
    const threads = parseThreads(threadsBody);
    const tid = threadId ?? threads[0]?.id ?? null;
    let frames: DebugStackFrame[] = [];
    let framesTotal: number | null = null;
    if (tid != null) {
      const stackBody = await dapSendRequest(sessionId, "stackTrace", { threadId: tid, startFrame: 0, levels: FRAME_PAGE_SIZE })
        .catch(() => null);
      frames = parseStackFrames(stackBody);
      framesTotal = parseStackTotal(stackBody);
    }
    if (!mountedRef.current || record.stopEpoch !== epoch) return;
    updateSessionState(sessionId, (prev) => (prev.status === "stopped"
      ? { ...prev, threads, frames, framesTotal, selectedThreadId: tid, selectedFrameId: frames[0]?.id ?? null }
      : prev));
    if (frames[0] && activeSessionIdRef.current === sessionId) {
      void refreshFrameVariables(frames[0].id, epoch);
    }
    if (reason === "breakpoint") {
      const hit = findHitBreakpoint(frames);
      const masters = hit ? breakpointMasterKeys(breakpointsRef.current) : null;
      if (hit && masters && needsClientHit(hit.bp, masters.has(breakpointRefKey(hit.path, hit.bp.line)))) {
        void applyBreakpointHit(sessionId, hit, frames);
      }
    }
    // IDEA-style exception details when the stop is an exception break.
    if (
      tid != null
      && typeof reason === "string" && reason.toLowerCase().includes("exception")
      && record.capabilities.supportsExceptionInfoRequest === true
    ) {
      const info = parseExceptionInfo(
        await dapSendRequest(sessionId, "exceptionInfo", { threadId: tid }).catch(() => null),
      );
      if (info && mountedRef.current && record.stopEpoch === epoch) {
        updateSessionState(sessionId, (prev) => (prev.status === "stopped" ? { ...prev, exceptionInfo: info } : prev));
      }
    }
  }, [applyBreakpointHit, findHitBreakpoint, refreshFrameVariables, updateSessionState]);
  const { handleEvent } = useDebugEvents({
    sessionsRef,
    updateSessionState,
    activeSessionIdRef,
    initializedRef,
    breakpointsRef,
    syncBreakpointsForPath,
    syncFunctionBreakpoints,
    syncInstructionBreakpoints,
    syncDataBreakpoints,
    syncExceptionBreakpoints,
    publishActiveSession,
    tempRunToCursorRef,
    refreshStoppedContext,
    setBreakpointRuntime,
    setFunctionBreakpointRuntime,
    setInstructionBreakpointRuntime,
    setDataBreakpointRuntime,
    setExceptionBreakpointRuntime,
    setExceptionBreakpointRuleRuntime,
    dropSessionDataBreakpoints,
    publishSessionList,
    findHitBreakpoint,
    applyBreakpointHit,
  });

  const terminateSessions = useCallback(async (scopeIds?: ReadonlySet<string>) => {
    const records = Array.from(sessionsRef.current.values()).filter((record) => (
      !scopeIds || record.abortScopeIds.some((scopeId) => scopeIds.has(scopeId))
    ));
    await Promise.all(records.map(async (record) => {
      record.unlisten?.();
      record.unlisten = null;
      const live = record.live;
      record.live = false;
      record.functionSyncGeneration += 1;
      record.instructionSyncGeneration += 1;
      record.dataSyncGeneration += 1;
      record.exceptionSyncGeneration += 1;
      record.state = {
        ...record.state,
        status: "terminated",
        stoppedThreadId: null,
        stoppedReason: null,
        selectedThreadId: null,
        selectedFrameId: null,
        // Stop clears the inspectable view of the debuggee: no threads, no
        // frames, no exception banner. Only the console history survives.
        threads: [],
        frames: [],
        exceptionInfo: null,
      };
      record.breakpointRuntime = {};
      record.functionBreakpointRuntime = {};
      record.instructionBreakpointRuntime = {};
      record.dataBreakpointRuntime = {};
      record.exceptionBreakpointRuntime = {};
      record.exceptionBreakpointRuleRuntime = {};
      record.frameVariables = {};
      record.bpIdIndex.clear();
      record.tempRunToCursor = null;
      if (live) await dapTerminate(record.id).catch(() => {});
      if (!record.readySettled) {
        record.readySettled = true;
        record.readyReject(new Error(`${record.label} was stopped before startup completed`));
      }
    }));
    dropSessionDataBreakpoints(new Set(records.map((record) => record.id)));
    if (!scopeIds) {
      const active = activeSessionIdRef.current
        ? sessionsRef.current.get(activeSessionIdRef.current) ?? null
        : null;
      publishActiveSession(active);
    } else {
      const active = activeSessionIdRef.current
        ? sessionsRef.current.get(activeSessionIdRef.current) ?? null
        : null;
      if (active && !active.live) {
        const fallback = Array.from(sessionsRef.current.values()).find((record) => record.live)
          ?? active;
        publishActiveSession(fallback);
      }
    }
    publishSessionList();
  }, [dropSessionDataBreakpoints, publishActiveSession, publishSessionList]);

  const clearSessions = useCallback(async () => {
    await terminateSessions();
    sessionsRef.current.clear();
    abortedScopesRef.current.clear();
    publishActiveSession(null);
    publishSessionList();
  }, [publishActiveSession, publishSessionList, terminateSessions]);
  const { startDebug, startDebugGroup, restart } = useDebugLaunch({
    abortedScopesRef,
    exceptionBreakpointsRef,
    mountedRef,
    setExceptionBreakpoints,
    persistExceptionBreakpoints,
    sessionsRef,
    stateRef,
    publishSessionList,
    setCanRestart,
    activeSessionIdRef,
    publishActiveSession,
    handleEvent,
    updateSessionState,
    dropSessionDataBreakpoints,
    clearSessions,
    setState,
    lastLaunchRef,
    reportStartupFailure,
    terminateSessions,
  });
  const { setBreakpointsMuted, removeAllBreakpoints, toggleBreakpoint, addBreakpoint, toggleBreakpointEnabled, setBreakpointOptions, setBreakpointMode, removeBreakpoint, addFunctionBreakpoint, setFunctionBreakpointOptions, removeFunctionBreakpoint, addInstructionBreakpoint, setInstructionBreakpointOptions, removeInstructionBreakpoint, addDataBreakpoint, setDataBreakpointOptions, removeDataBreakpoint, setExceptionBreakpointOptions, addExceptionBreakpointRule, setExceptionBreakpointRuleOptions, removeExceptionBreakpointRule } = useBreakpointActions({
    mutateBreakpoints,
    breakpointsRef,
    syncBreakpointsForPath,
    activeSessionIdRef,
    sessionsRef,
    functionBreakpointsRef,
    setFunctionBreakpoints,
    persistFunctionBreakpoints,
    syncFunctionBreakpoints,
    instructionBreakpointsRef,
    setInstructionBreakpoints,
    persistInstructionBreakpoints,
    syncInstructionBreakpoints,
    dataBreakpointsRef,
    setDataBreakpoints,
    persistDataBreakpoints,
    syncDataBreakpoints,
    updateSessionState,
    mutedRef,
    setBreakpointsMutedState,
    syncExceptionBreakpoints,
    setBreakpoints,
    persistBreakpoints,
    exceptionBreakpointsRef,
    setExceptionBreakpoints,
    persistExceptionBreakpoints,
    exceptionBreakpointRulesRef,
    setExceptionBreakpointRules,
    persistExceptionBreakpointRules,
  });
  const { step, runToCursor, selectThread, selectFrame, loadMoreFrames, restartFrame, hotReload } = useDebugExecution({
    stepInFlightRef,
    sessionIdRef,
    sessionsRef,
    setIsStepping,
    stateRef,
    mountedRef,
    updateSessionState,
    breakpointsRef,
    mutedRef,
    tempRunToCursorRef,
    syncBreakpointsForPath,
    refreshFrameVariables,
    stopEpochRef,
    capabilitiesRef,
    logConsole,
  });
  const { evaluate, hoverEvaluate, readMemory, writeMemory, disassemble, setVariable, fetchVariables, fetchScopes, fetchSource } = useDebugInspection({
    sessionIdRef,
    stateRef,
    consoleGenerationRef,
    mountedRef,
    capabilitiesRef,
    logConsole,
    activeSessionIdRef,
    sessionsRef,
    stopEpochRef,
  });

  const terminate = useCallback(() => {
    bumpConsoleGeneration();
    void terminateSessions();
  }, [bumpConsoleGeneration, terminateSessions]);

  return {
    state,
    breakpoints,
    breakpointRuntime,
    functionBreakpoints,
    functionBreakpointRuntime,
    instructionBreakpoints,
    instructionBreakpointRuntime,
    dataBreakpoints,
    dataBreakpointRuntime,
    exceptionBreakpoints,
    exceptionBreakpointRuntime,
    exceptionBreakpointRules,
    exceptionBreakpointRuleRuntime,
    capabilities,
    availableExceptionFilters: availableFilters,
    watchExpressions,
    watchItems,
    isStepping,
    breakpointsMuted,
    setBreakpointsMuted,
    removeAllBreakpoints,
    frameVariables,
    stopEpoch: state?.stopEpoch ?? stopEpochRef.current ?? 0,
    sessions,
    activeSessionId,
    selectSession,
    startDebug,
    startDebugGroup,
    restart,
    canRestart,
    toggleBreakpoint,
    addBreakpoint,
    toggleBreakpointEnabled,
    setBreakpointOptions,
    setBreakpointMode,
    removeBreakpoint,
    addFunctionBreakpoint,
    setFunctionBreakpointOptions,
    removeFunctionBreakpoint,
    addInstructionBreakpoint,
    setInstructionBreakpointOptions,
    removeInstructionBreakpoint,
    addDataBreakpoint,
    setDataBreakpointOptions,
    removeDataBreakpoint,
    setExceptionBreakpointOptions,
    addExceptionBreakpointRule,
    setExceptionBreakpointRuleOptions,
    removeExceptionBreakpointRule,
    addWatchExpression,
    removeWatchExpression,
    step,
    runToCursor,
    selectThread,
    selectFrame,
    loadMoreFrames,
    restartFrame,
    hotReload,
    evaluate,
    hoverEvaluate,
    readMemory,
    writeMemory,
    disassemble,
    setVariable,
    logConsole,
    clearConsole,
    consoleGeneration,
    reportStartupFailure,
    reportStartupProgress,
    fetchVariables,
    fetchScopes,
    fetchSource,
    terminate,
    currentLocation: state ? currentLocation(state.frames, state.selectedFrameId) : null,
  };
}









export { type BreakpointMap, type DebugLaunchTarget, type DebugLaunchGroup, type DebugLaunchNode, type DebugSessionSummary, type DataBreakpointAddResult, type DebugActionResult, type WatchExpressionItem, type CodeDebugSession } from "./debug/types";
