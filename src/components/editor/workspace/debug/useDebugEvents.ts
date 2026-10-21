import { useCallback,useRef } from "react";
import { dapSend,dapSendRequest,dapTerminate,type DapEventPayload } from "../../../../lib/editor/dap";
import {
  appendConsoleLine,
  parseBreakpointEvent,
  effectiveSuspend,
  parseStackFrames,
  reduceDebugEvent,
  type BreakpointRuntimeState,
  type DebugBreakpoint,
  type DebugDataBreakpoint,
  type DebugExceptionBreakpoint,
  type DebugExceptionBreakpointRule,
  type DebugFunctionBreakpoint,
  type DebugInstructionBreakpoint,
  type DebugSessionState,
  type DebugStackFrame,
} from "../dapDebugModel";
import { breakpointMasterKeys,breakpointRefKey,hasClientNonSuspending,needsClientHit } from "../debugBreakpointProperties";
import { type BreakpointMap,type DebugSessionRecord } from "./types";
import { FRAME_PAGE_SIZE,CLOSING_OUTPUT_DRAIN_MS,EXITED_WITHOUT_TERMINATED_MS } from "./breakpointPersistence";
import { errorText } from "./errors";


export interface UseDebugEventsContext {
  sessionsRef: import("react").RefObject<Map<string,DebugSessionRecord>>;
  updateSessionState: (sessionId: string,updater: (current: DebugSessionState) => DebugSessionState) => void;
  activeSessionIdRef: import("react").RefObject<string|null>;
  initializedRef: import("react").RefObject<boolean>;
  breakpointsRef: import("react").RefObject<BreakpointMap>;
  syncBreakpointsForPath: (path: string,options?: { list?: DebugBreakpoint[]; extraTempLine?: number; sessionIds?: readonly string[]; }) => Promise<void>;
  syncFunctionBreakpoints: (options?: { list?: DebugFunctionBreakpoint[]; sessionIds?: readonly string[]; }) => Promise<void>;
  syncInstructionBreakpoints: (options?: { list?: DebugInstructionBreakpoint[]; sessionIds?: readonly string[]; }) => Promise<void>;
  syncDataBreakpoints: (options?: { list?: DebugDataBreakpoint[]; sessionIds?: readonly string[]; }) => Promise<void>;
  syncExceptionBreakpoints: (options?: { list?: DebugExceptionBreakpoint[]; rules?: DebugExceptionBreakpointRule[]; sessionIds?: readonly string[]; }) => Promise<void>;
  publishActiveSession: (record: DebugSessionRecord|null) => void;
  tempRunToCursorRef: import("react").RefObject<{ path: string; }|null>;
  refreshStoppedContext: (sessionId: string,threadId: number|null,reason: string|null,epoch: number) => Promise<void>;
  setBreakpointRuntime: import("react").Dispatch<import("react").SetStateAction<Record<string,Record<number,BreakpointRuntimeState>>>>;
  setFunctionBreakpointRuntime: import("react").Dispatch<import("react").SetStateAction<Record<string,BreakpointRuntimeState>>>;
  setInstructionBreakpointRuntime: import("react").Dispatch<import("react").SetStateAction<Record<string,BreakpointRuntimeState>>>;
  setDataBreakpointRuntime: import("react").Dispatch<import("react").SetStateAction<Record<string,BreakpointRuntimeState>>>;
  setExceptionBreakpointRuntime: import("react").Dispatch<import("react").SetStateAction<Record<string,BreakpointRuntimeState>>>;
  setExceptionBreakpointRuleRuntime: import("react").Dispatch<import("react").SetStateAction<Record<string,BreakpointRuntimeState>>>;
  dropSessionDataBreakpoints: (sessionIds: ReadonlySet<string>) => void;
  publishSessionList: () => void;
  findHitBreakpoint: (frames: DebugStackFrame[]) => { path: string; bp: DebugBreakpoint; }|null;
  applyBreakpointHit: (sessionId: string,hit: { path: string; bp: DebugBreakpoint; },frames: DebugStackFrame[]) => Promise<void>;
}

export function useDebugEvents(context: UseDebugEventsContext) {
  const {
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
  }=context;

  const finishClosingRef=useRef<(record: DebugSessionRecord) => void>(() => { });
  const processEvent=useCallback((payload: DapEventPayload) => {
    const record=sessionsRef.current.get(payload.sessionId);
    if(!record) return;
    if(payload.event==="terminated"||payload.event==="exited") {
      // The debuggee's last stdout lines may still be on their way (java-debug
      // reads the process streams on its own thread), so keep listening for a
      // short drain and only then print the exit line and free the session.
      const closing=record.closing??{ events: [],timer: null };
      record.closing=closing;
      closing.events.push(payload);
      if(closing.timer) clearTimeout(closing.timer);
      const drainMs=closing.events.some((event) => event.event==="terminated")
        ? CLOSING_OUTPUT_DRAIN_MS
        :EXITED_WITHOUT_TERMINATED_MS;
      closing.timer=setTimeout(() => finishClosingRef.current(record),drainMs);
      return;
    }
    updateSessionState(payload.sessionId,(prev) => reduceDebugEvent(prev,payload.event,payload.message));
    if(payload.event==="initialized") {
      record.initialized=true;
      if(record.launchAccepted&&!record.readySettled) {
        record.readySettled=true;
        record.readyResolve();
      }
      if(activeSessionIdRef.current===record.id) initializedRef.current=true;
      // Configure breakpoints before the debuggee runs, then release it.
      void (async () => {
        const id=record.id;
        if(!record.live) return;
        for(const path of Object.keys(breakpointsRef.current)) {
          if((breakpointsRef.current[path]??[]).length>0) {
            await syncBreakpointsForPath(path,{ sessionIds: [id] });
          }
        }
        await syncFunctionBreakpoints({ sessionIds: [id] });
        await syncInstructionBreakpoints({ sessionIds: [id] });
        await syncDataBreakpoints({ sessionIds: [id] });
        await syncExceptionBreakpoints({ sessionIds: [id] });
        await dapSend(id,"configurationDone").catch((error) => {
          updateSessionState(id,(current) => appendConsoleLine(
            current,
            "stderr",
            `configurationDone failed: ${errorText(error)}\n`,
          ));
        });
      })();
    } else if(payload.event==="stopped") {
      record.stopEpoch+=1;
      // Follow the child that actually paused, as IDEA does for compound runs.
      publishActiveSession(record);
      // Run-to-cursor's transient breakpoint is one-shot: restore the user set.
      const temp=record.tempRunToCursor;
      record.tempRunToCursor=null;
      tempRunToCursorRef.current=null;
      if(temp) void syncBreakpointsForPath(temp.path,{ sessionIds: [record.id] });
      const body=(payload.message as { body?: { threadId?: number; reason?: string; }; })?.body;
      void refreshStoppedContext(record.id,body?.threadId??null,body?.reason??null,record.stopEpoch);
    } else if(payload.event==="breakpoint") {
      const parsed=parseBreakpointEvent(payload.message);
      const entry=parsed?.id!=null? record.bpIdIndex.get(parsed.id):undefined;
      if(parsed&&entry) {
        const { verified }=parsed;
        const runtime: BreakpointRuntimeState=verified
          ? { status: "verified",message: null }
          :{ status: parsed.bindReason==="failed"? "failed":"pending",message: parsed.message };
        if(entry.kind==="source"&&parsed.line!=null) {
          record.breakpointRuntime={
            ...record.breakpointRuntime,
            [entry.path]: {
              ...(record.breakpointRuntime[entry.path]??{}),
              [parsed.line]: runtime,
            },
          };
          if(activeSessionIdRef.current===record.id) setBreakpointRuntime(record.breakpointRuntime);
        } else if(entry.kind==="function") {
          record.functionBreakpointRuntime={
            ...record.functionBreakpointRuntime,
            [entry.name]: runtime,
          };
          if(activeSessionIdRef.current===record.id) {
            setFunctionBreakpointRuntime(record.functionBreakpointRuntime);
          }
        } else if(entry.kind==="instruction") {
          record.instructionBreakpointRuntime={
            ...record.instructionBreakpointRuntime,
            [entry.key]: runtime,
          };
          if(activeSessionIdRef.current===record.id) {
            setInstructionBreakpointRuntime(record.instructionBreakpointRuntime);
          }
        } else if(entry.kind==="data") {
          record.dataBreakpointRuntime={
            ...record.dataBreakpointRuntime,
            [entry.key]: runtime,
          };
          if(activeSessionIdRef.current===record.id) {
            setDataBreakpointRuntime(record.dataBreakpointRuntime);
          }
        } else if(entry.kind==="exception-filter") {
          record.exceptionBreakpointRuntime={
            ...record.exceptionBreakpointRuntime,
            [entry.filterId]: runtime,
          };
          if(activeSessionIdRef.current===record.id) {
            setExceptionBreakpointRuntime(record.exceptionBreakpointRuntime);
          }
        } else if(entry.kind==="exception-rule") {
          record.exceptionBreakpointRuleRuntime={
            ...record.exceptionBreakpointRuleRuntime,
            [entry.ruleId]: runtime,
          };
          if(activeSessionIdRef.current===record.id) {
            setExceptionBreakpointRuleRuntime(record.exceptionBreakpointRuleRuntime);
          }
        }
      }
    }
  },[
    publishActiveSession,
    refreshStoppedContext,
    syncBreakpointsForPath,
    syncDataBreakpoints,
    syncExceptionBreakpoints,
    syncFunctionBreakpoints,
    syncInstructionBreakpoints,
    updateSessionState,
  ]);

  /** Apply the held `exited`/`terminated` events once the output drained. */
  const finishClosing=useCallback((record: DebugSessionRecord) => {
    const closing=record.closing;
    if(!closing) return;
    record.closing=null;
    if(closing.timer) clearTimeout(closing.timer);
    if(!sessionsRef.current.has(record.id)) return;
    for(const event of closing.events) {
      updateSessionState(record.id,(prev) => reduceDebugEvent(prev,event.event,event.message));
    }
    // Free the backend session (drops the adapter transport / child); the final
    // state stays visible in the panel until the next start.
    record.live=false;
    record.functionSyncGeneration+=1;
    record.instructionSyncGeneration+=1;
    record.dataSyncGeneration+=1;
    record.exceptionSyncGeneration+=1;
    if(!record.readySettled) {
      record.readySettled=true;
      record.readyReject(new Error(`${record.label} terminated before the debug adapter became ready`));
    }
    record.unlisten?.();
    record.unlisten=null;
    record.bpIdIndex.clear();
    record.tempRunToCursor=null;
    record.breakpointRuntime={};
    record.functionBreakpointRuntime={};
    record.instructionBreakpointRuntime={};
    record.dataBreakpointRuntime={};
    record.exceptionBreakpointRuntime={};
    record.exceptionBreakpointRuleRuntime={};
    record.frameVariables={};
    void dapTerminate(record.id).catch(() => { });
    dropSessionDataBreakpoints(new Set([record.id]));
    if(activeSessionIdRef.current===record.id) {
      const fallback=Array.from(sessionsRef.current.values())
        .filter((candidate) => candidate.live)
        .sort((left,right) => left.order-right.order)[0]??record;
      publishActiveSession(fallback);
    } else {
      publishSessionList();
    }
  },[dropSessionDataBreakpoints,publishActiveSession,publishSessionList,updateSessionState]);
  finishClosingRef.current=finishClosing;

  const handleEventRef=useRef<(payload: DapEventPayload) => void>(() => { });
  /**
   * Event entry point. A `breakpoint` stop that may belong to a
   * non-suspending (IDEA "Suspend" unchecked) breakpoint is inspected first:
   * a pass-through hit runs its actions and resumes without ever showing a
   * stopped state. Events arriving meanwhile queue so they keep their order.
   */
  const handleEvent=useCallback((payload: DapEventPayload) => {
    const record=sessionsRef.current.get(payload.sessionId);
    if(!record) return;
    if(record.eventGate) {
      record.eventGate.queue.push(payload);
      return;
    }
    const body=payload.event==="stopped"
      ? (payload.message as { body?: { threadId?: number; reason?: string; }; }|null)?.body
      :undefined;
    const threadId=body?.threadId;
    if(
      !body
      ||body.reason!=="breakpoint"
      ||typeof threadId!=="number"
      ||!record.live
      ||!hasClientNonSuspending(breakpointsRef.current)
    ) {
      processEvent(payload);
      return;
    }
    const gate={ queue: [] as DapEventPayload[] };
    record.eventGate=gate;
    void (async () => {
      let passedThrough=false;
      try {
        const stackBody=await dapSendRequest(record.id,"stackTrace",{ threadId,startFrame: 0,levels: FRAME_PAGE_SIZE });
        const frames=parseStackFrames(stackBody);
        const hit=findHitBreakpoint(frames);
        if(hit&&!effectiveSuspend(hit.bp)) {
          const masters=breakpointMasterKeys(breakpointsRef.current);
          if(needsClientHit(hit.bp,masters.has(breakpointRefKey(hit.path,hit.bp.line)))) {
            await applyBreakpointHit(record.id,hit,frames);
            await dapSendRequest(record.id,"continue",{ threadId });
            passedThrough=true;
          }
        }
      } catch {
        // Anything unexpected shows the stop instead of leaving a silently
        // suspended thread behind.
        passedThrough=false;
      }
      record.eventGate=null;
      if(!passedThrough) processEvent(payload);
      for(const queued of gate.queue) handleEventRef.current(queued);
    })();
  },[applyBreakpointHit,findHitBreakpoint,processEvent]);
  handleEventRef.current=handleEvent;
  return { handleEvent };
}
