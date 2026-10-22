import { useCallback } from "react";
import { dapSendRequest,dapStartSession,dapTerminate,listenDapEvents,type DapEventPayload } from "../../../../lib/editor/dap";
import {
  appendConsoleLine,
  initialDebugState,
  mergeExceptionBreakpointDefaults,
  parseExceptionBreakpointFilters,
  type DebugExceptionBreakpoint,
  type DebugSessionState,
} from "../dapDebugModel";
import { type DebugSessionRecord,type LastDebugLaunch,type DebugLaunchTarget,type DebugLaunchGroup,type DebugLaunchNode } from "./types";
import { normalizeExceptionBreakpoints,validateDebugLaunchGroup,isDebugLaunchGroup } from "./breakpointPersistence";
import { errorText } from "./errors";


export interface UseDebugLaunchContext {
  abortedScopesRef: import("react").RefObject<Set<string>>;
  exceptionBreakpointsRef: import("react").RefObject<DebugExceptionBreakpoint[]>;
  mountedRef: import("react").MutableRefObject<boolean>;
  setExceptionBreakpoints: import("react").Dispatch<import("react").SetStateAction<DebugExceptionBreakpoint[]>>;
  persistExceptionBreakpoints: (next: DebugExceptionBreakpoint[]) => void;
  sessionsRef: import("react").RefObject<Map<string,DebugSessionRecord>>;
  stateRef: import("react").RefObject<DebugSessionState|null>;
  publishSessionList: () => void;
  setCanRestart: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  activeSessionIdRef: import("react").RefObject<string|null>;
  publishActiveSession: (record: DebugSessionRecord|null) => void;
  handleEvent: (payload: DapEventPayload) => void;
  updateSessionState: (sessionId: string,updater: (current: DebugSessionState) => DebugSessionState) => void;
  dropSessionDataBreakpoints: (sessionIds: ReadonlySet<string>) => void;
  clearSessions: () => Promise<void>;
  setState: import("react").Dispatch<import("react").SetStateAction<DebugSessionState|null>>;
  lastLaunchRef: import("react").RefObject<LastDebugLaunch|null>;
  reportStartupFailure: (message: string) => void;
  terminateSessions: (scopeIds?: ReadonlySet<string>) => Promise<void>;
}

export function useDebugLaunch(context: UseDebugLaunchContext) {
  const {
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
  }=context;

  const launchTarget=useCallback(async (
    target: DebugLaunchTarget,
    order: number,
    abortScopeIds: string[],
  ): Promise<DebugSessionRecord> => {
    let result: Awaited<ReturnType<typeof dapStartSession>>;
    try {
      result=await dapStartSession(target.adapterId,target.launchConfig);
    } catch(error) {
      // Adapter resolution failures (no jdtls session, no main class, no
      // debug bundle, classpath/port resolution) reject here. Surface them in
      // the Debug panel — not just the caller's status bar — then rethrow so
      // existing callers keep their behavior.
      throw error;
    }
    if(abortScopeIds.some((scopeId) => abortedScopesRef.current.has(scopeId))) {
      await dapTerminate(result.sessionId).catch(() => { });
      throw new Error(`Debug launch was cancelled after another child failed: ${target.label}`);
    }
    const filters=parseExceptionBreakpointFilters(result.capabilities);
    const mergedExceptionBreakpoints=mergeExceptionBreakpointDefaults(
      exceptionBreakpointsRef.current,
      target.adapterId,
      filters,
    );
    if(mergedExceptionBreakpoints!==exceptionBreakpointsRef.current) {
      const next=normalizeExceptionBreakpoints(mergedExceptionBreakpoints);
      exceptionBreakpointsRef.current=next;
      if(mountedRef.current) setExceptionBreakpoints(next);
      persistExceptionBreakpoints(next);
    }
    const carried=sessionsRef.current.size===0&&stateRef.current?.sessionId===""
      ? stateRef.current.output
      :[];
    const initial=initialDebugState(result.sessionId);
    let readyResolve=() => { };
    let readyReject=(_error: unknown) => { };
    const ready=new Promise<void>((resolve,reject) => {
      readyResolve=resolve;
      readyReject=reject;
    });
    // A single-session caller does not await readiness; keep a rejected launch
    // from becoming an unhandled promise while the DAP error is surfaced below.
    void ready.catch(() => { });
    const record: DebugSessionRecord={
      id: result.sessionId,
      order,
      targetId: target.id,
      label: target.label,
      adapterId: target.adapterId,
      launchConfig: target.launchConfig,
      state: { ...initial,status: "running",output: carried },
      capabilities: result.capabilities,
      availableFilters: filters,
      breakpointRuntime: {},
      functionBreakpointRuntime: {},
      instructionBreakpointRuntime: {},
      dataBreakpointRuntime: {},
      exceptionBreakpointRuntime: {},
      exceptionBreakpointRuleRuntime: {},
      frameVariables: {},
      initialized: false,
      launchAccepted: false,
      live: true,
      unlisten: null,
      stopEpoch: 0,
      bpIdIndex: new Map(),
      syncGeneration: new Map(),
      functionSyncGeneration: 0,
      instructionSyncGeneration: 0,
      dataSyncGeneration: 0,
      exceptionSyncGeneration: 0,
      tempRunToCursor: null,
      armedDependents: new Set(),
      eventGate: null,
      closing: null,
      abortScopeIds,
      ready,
      readyResolve,
      readyReject,
      readySettled: false,
    };
    sessionsRef.current.set(record.id,record);
    publishSessionList();
    if(mountedRef.current) setCanRestart(true);
    if(!activeSessionIdRef.current) publishActiveSession(record);
    // Listen before firing launch so the `initialized` event can't be missed.
    try {
      record.unlisten=await listenDapEvents(result.sessionId,handleEvent);
    } catch(error) {
      sessionsRef.current.delete(record.id);
      record.live=false;
      record.functionSyncGeneration+=1;
      record.instructionSyncGeneration+=1;
      record.dataSyncGeneration+=1;
      record.exceptionSyncGeneration+=1;
      await dapTerminate(record.id).catch(() => { });
      publishSessionList();
      throw error;
    }
    // Fire launch/attach as a correlated request but do NOT await it here: the
    // response only arrives after configurationDone (awaiting would deadlock
    // the initialized → setBreakpoints → configurationDone sequence). The
    // correlation exists to surface failures — when the launch fails the
    // adapter never emits `initialized`, so without this the error response is
    // silently dropped and the UI sits at "running" forever.
    const launchedSession=result.sessionId;
    void dapSendRequest(launchedSession,result.request,result.arguments).then(() => {
      const launched=sessionsRef.current.get(launchedSession);
      if(!launched?.live) return;
      launched.launchAccepted=true;
      if(launched.initialized&&!launched.readySettled) {
        launched.readySettled=true;
        launched.readyResolve();
      }
    }).catch((error) => {
      const launched=sessionsRef.current.get(launchedSession);
      if(!launched?.live) return;
      const message=error instanceof Error? error.message:String(error);
      launched.live=false;
      launched.functionSyncGeneration+=1;
      launched.instructionSyncGeneration+=1;
      launched.dataSyncGeneration+=1;
      launched.exceptionSyncGeneration+=1;
      if(!launched.readySettled) {
        launched.readySettled=true;
        launched.readyReject(error);
      }
      launched.unlisten?.();
      launched.unlisten=null;
      void dapTerminate(launchedSession).catch(() => { });
      launched.breakpointRuntime={};
      launched.functionBreakpointRuntime={};
      launched.instructionBreakpointRuntime={};
      launched.dataBreakpointRuntime={};
      launched.exceptionBreakpointRuntime={};
      launched.exceptionBreakpointRuleRuntime={};
      launched.frameVariables={};
      updateSessionState(launchedSession,(prev) => appendConsoleLine(
        { ...prev,status: "terminated" },
        "stderr",
        `Launch failed: ${message}\n`,
      ));
      if(activeSessionIdRef.current===launchedSession) publishActiveSession(launched);
      dropSessionDataBreakpoints(new Set([launchedSession]));
    });
    // Watchdog: if the adapter never becomes ready, say so instead of showing
    // an eternally-running empty session.
    window.setTimeout(() => {
      const launched=sessionsRef.current.get(launchedSession);
      if(!launched?.live||launched.initialized) return;
      updateSessionState(launchedSession,(prev) => appendConsoleLine(
        prev,
        "console",
        "Still waiting for the debug adapter to become ready (no 'initialized' event after 15s). "
        +"The project may have build errors, or the launch is stalled.\n",
      ));
    },15_000);
    return record;
  },[
    dropSessionDataBreakpoints,
    handleEvent,
    persistExceptionBreakpoints,
    publishActiveSession,
    publishSessionList,
    updateSessionState,
  ]);

  const startDebug=useCallback(async (
    launchConfig: Record<string,unknown>,
    adapterId="java",
  ) => {
    const startupOutput=stateRef.current?.sessionId===""? stateRef.current.output:[];
    await clearSessions();
    if(startupOutput.length>0) {
      const startup={ ...initialDebugState(""),output: startupOutput };
      stateRef.current=startup;
      if(mountedRef.current) setState(startup);
    }
    lastLaunchRef.current={ kind: "single",config: launchConfig,adapterId };
    try {
      await launchTarget({ id: "single",label: "Debug",adapterId,launchConfig },0,[]);
      if(mountedRef.current) setCanRestart(true);
    } catch(error) {
      reportStartupFailure(`Debug failed to start: ${errorText(error)}`);
      throw error;
    }
  },[clearSessions,launchTarget,reportStartupFailure]);

  const startDebugGroup=useCallback(async (plan: DebugLaunchGroup) => {
    validateDebugLaunchGroup(plan);
    const startupOutput=stateRef.current?.sessionId===""? stateRef.current.output:[];
    await clearSessions();
    if(startupOutput.length>0) {
      const startup={ ...initialDebugState(""),output: startupOutput };
      stateRef.current=startup;
      if(mountedRef.current) setState(startup);
    }
    lastLaunchRef.current={ kind: "group",plan: structuredClone(plan) };
    let order=0;
    const runNode=async (node: DebugLaunchNode,parentScopes: string[]): Promise<void> => {
      if(!isDebugLaunchGroup(node)) {
        const launchOrder=order;
        order+=1;
        const record=await launchTarget(node,launchOrder,parentScopes);
        await record.ready;
        return;
      }
      const scopes=[...parentScopes,node.id];
      const runChild=(child: DebugLaunchNode) => runNode(child,scopes);
      if(node.parallel) {
        if(node.stopOnFailure!==false) {
          try {
            await Promise.all(node.children.map(runChild));
          } catch(error) {
            abortedScopesRef.current.add(node.id);
            await terminateSessions(new Set([node.id]));
            throw error;
          }
        } else {
          const results=await Promise.allSettled(node.children.map(runChild));
          const failure=results.find((result): result is PromiseRejectedResult => result.status==="rejected");
          if(failure) throw failure.reason;
        }
        return;
      }
      let firstFailure: unknown=null;
      for(const child of node.children) {
        try {
          await runChild(child);
        } catch(error) {
          firstFailure??=error;
          if(node.stopOnFailure!==false) {
            abortedScopesRef.current.add(node.id);
            await terminateSessions(new Set([node.id]));
            throw error;
          }
        }
      }
      if(firstFailure) throw firstFailure;
    };
    try {
      await runNode(plan,[]);
      if(mountedRef.current) setCanRestart(true);
    } catch(error) {
      reportStartupFailure(`Compound Debug failed to start: ${errorText(error)}`);
      throw error;
    }
  },[clearSessions,launchTarget,reportStartupFailure,terminateSessions]);

  const restart=useCallback(() => {
    const last=lastLaunchRef.current;
    if(!last) return;
    if(last.kind==="group") void startDebugGroup(last.plan).catch(() => { });
    else void startDebug(last.config,last.adapterId).catch(() => { });
  },[startDebug,startDebugGroup]);
  return { startDebug,startDebugGroup,restart };
}
