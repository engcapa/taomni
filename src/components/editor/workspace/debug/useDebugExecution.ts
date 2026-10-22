import { useCallback } from "react";
import { dapSendRequest } from "../../../../lib/editor/dap";
import {
  markResumed,
  parseStackFrames,
  parseStackTotal,
  parseThreads,
  stepCommandFor,
  type DebugBreakpoint,
  type DebugSessionState,
  type DebugStepAction,
} from "../dapDebugModel";
import { type DebugActionResult,type DebugSessionRecord } from "./types";
import { FRAME_PAGE_SIZE } from "./breakpointPersistence";


export interface UseDebugExecutionContext {
  stepInFlightRef: import("react").RefObject<Promise<DebugActionResult>|null>;
  sessionIdRef: import("react").RefObject<string|null>;
  sessionsRef: import("react").RefObject<Map<string,DebugSessionRecord>>;
  setIsStepping: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  stateRef: import("react").RefObject<DebugSessionState|null>;
  mountedRef: import("react").MutableRefObject<boolean>;
  updateSessionState: (sessionId: string,updater: (current: DebugSessionState) => DebugSessionState) => void;
  breakpointsRef: import("react").RefObject<import("./types").BreakpointMap>;
  mutedRef: import("react").RefObject<boolean>;
  tempRunToCursorRef: import("react").RefObject<{ path: string; }|null>;
  syncBreakpointsForPath: (path: string,options?: { list?: DebugBreakpoint[]; extraTempLine?: number; sessionIds?: readonly string[]; }) => Promise<void>;
  refreshFrameVariables: (frameId: number,epoch: number) => Promise<void>;
  stopEpochRef: import("react").RefObject<number>;
  capabilitiesRef: import("react").RefObject<Record<string,unknown>>;
  logConsole: (category: string,text: string) => void;
}

export function useDebugExecution(context: UseDebugExecutionContext) {
  const {
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
  }=context;

  const step=useCallback((action: DebugStepAction): Promise<DebugActionResult> => {
    if(stepInFlightRef.current) {
      return Promise.resolve({ kind: "no-op",message: "Stepping action already in flight" });
    }
    const id=sessionIdRef.current;
    const record=id? sessionsRef.current.get(id):undefined;
    if(!id||!record) {
      return Promise.resolve({ kind: "no-op",message: "No active debug session" });
    }

    setIsStepping(true);
    const p=(async (): Promise<DebugActionResult> => {
      try {
        if(action==="pause") {
          let tid=stateRef.current?.threads[0]?.id??null;
          if(tid==null) {
            tid=parseThreads(await dapSendRequest(id,"threads").catch(() => null))[0]?.id??null;
          }
          if(tid==null) {
            return { kind: "no-op",message: "No threads found to pause" };
          }
          await dapSendRequest(id,"pause",{ threadId: tid });
          return { kind: "applied" };
        }
        const epoch=record.stopEpoch;
        const tid=stateRef.current?.selectedThreadId??stateRef.current?.stoppedThreadId;
        await dapSendRequest(id,stepCommandFor(action),tid!=null? { threadId: tid }:{});
        if(mountedRef.current&&record.stopEpoch===epoch) {
          updateSessionState(id,(prev) => (prev.status==="stopped"? markResumed(prev):prev));
        }
        return { kind: "applied" };
      } catch(err) {
        return {
          kind: "failed",
          message: err instanceof Error? err.message:String(err),
        };
      } finally {
        stepInFlightRef.current=null;
        if(mountedRef.current) {
          setIsStepping(false);
        }
      }
    })();

    stepInFlightRef.current=p;
    return p;
  },[updateSessionState]);

  const runToCursor=useCallback((path: string,line: number) => {
    const id=sessionIdRef.current;
    const current=stateRef.current;
    const record=id? sessionsRef.current.get(id):undefined;
    if(!id||!record||!current||current.status!=="stopped") return;
    void (async () => {
      const needsTemp=!(breakpointsRef.current[path]??[]).some(
        (bp) => bp.line===line&&bp.enabled!==false,
      )||mutedRef.current;
      if(needsTemp) {
        record.tempRunToCursor={ path };
        tempRunToCursorRef.current=record.tempRunToCursor;
        await syncBreakpointsForPath(path,{ extraTempLine: line,sessionIds: [id] });
      }
      const epoch=record.stopEpoch;
      const tid=current.selectedThreadId??current.stoppedThreadId;
      try {
        await dapSendRequest(id,"continue",tid!=null? { threadId: tid }:{});
        if(mountedRef.current&&record.stopEpoch===epoch) {
          updateSessionState(id,(prev) => (prev.status==="stopped"? markResumed(prev):prev));
        }
      } catch {
        // Continue failed: restore the user's breakpoints right away.
        if(needsTemp) {
          record.tempRunToCursor=null;
          tempRunToCursorRef.current=null;
          await syncBreakpointsForPath(path,{ sessionIds: [id] });
        }
      }
    })();
  },[syncBreakpointsForPath,updateSessionState]);

  const selectThread=useCallback((threadId: number) => {
    const id=sessionIdRef.current;
    const record=id? sessionsRef.current.get(id):undefined;
    if(!id||!record||stateRef.current?.status!=="stopped") return;
    void (async () => {
      const epoch=record.stopEpoch;
      const stackBody=await dapSendRequest(id,"stackTrace",{ threadId,startFrame: 0,levels: FRAME_PAGE_SIZE })
        .catch(() => null);
      const frames=parseStackFrames(stackBody);
      const framesTotal=parseStackTotal(stackBody);
      if(!mountedRef.current||record.stopEpoch!==epoch) return;
      updateSessionState(id,(prev) => (prev.status==="stopped"
        ? { ...prev,selectedThreadId: threadId,frames,framesTotal,selectedFrameId: frames[0]?.id??null }
        :prev));
      if(frames[0]) void refreshFrameVariables(frames[0].id,epoch);
    })();
  },[refreshFrameVariables,updateSessionState]);

  /** IDEA loads deep stacks lazily: fetch the next page of the shown thread. */
  const loadMoreFrames=useCallback(async () => {
    const id=sessionIdRef.current;
    const record=id? sessionsRef.current.get(id):undefined;
    const current=stateRef.current;
    if(!id||!record||current?.status!=="stopped") return;
    const threadId=current.selectedThreadId??current.stoppedThreadId;
    if(threadId==null) return;
    const epoch=record.stopEpoch;
    const startFrame=current.frames.length;
    const body=await dapSendRequest(id,"stackTrace",{ threadId,startFrame,levels: FRAME_PAGE_SIZE })
      .catch(() => null);
    if(!mountedRef.current||record.stopEpoch!==epoch) return;
    const more=parseStackFrames(body);
    const total=parseStackTotal(body);
    updateSessionState(id,(prev) => {
      if(
        prev.status!=="stopped"
        ||(prev.selectedThreadId??prev.stoppedThreadId)!==threadId
        ||prev.frames.length!==startFrame
      ) return prev;
      const known=new Set(prev.frames.map((frame) => frame.id));
      const frames=[...prev.frames,...more.filter((frame) => !known.has(frame.id))];
      // An empty page means the adapter has nothing more, whatever it claimed.
      return { ...prev,frames,framesTotal: more.length===0? frames.length:total??prev.framesTotal??null };
    });
  },[mountedRef,updateSessionState]);

  const selectFrame=useCallback((frameId: number) => {
    const id=sessionIdRef.current;
    if(!id) return;
    updateSessionState(id,(prev) => (prev.status==="stopped"? { ...prev,selectedFrameId: frameId }:prev));
    // Inline values follow the frame the user is inspecting.
    void refreshFrameVariables(frameId,stopEpochRef.current);
  },[refreshFrameVariables,updateSessionState]);

  const restartFrame=useCallback((frameId: number) => {
    const id=sessionIdRef.current;
    if(!id||capabilitiesRef.current.supportsRestartFrame!==true) return;
    // The adapter re-stops at the frame entry and emits a `stopped` event.
    void dapSendRequest(id,"restartFrame",{ frameId }).catch(() => { });
  },[]);

  const hotReload=useCallback(() => {
    const id=sessionIdRef.current;
    if(!id) return;
    // java-debug custom request; adapters without it just error (reported below).
    void dapSendRequest(id,"redefineClasses",{})
      .then((body) => {
        const changed=body&&typeof body==="object"
          ? (body as { changedClasses?: unknown; }).changedClasses
          :null;
        const count=Array.isArray(changed)? changed.length:0;
        logConsole("console",count>0
          ? `Hot reloaded ${count} class${count===1? "":"es"}\n`
          :"Hot reload: no changed classes\n");
      })
      .catch((error) => {
        logConsole("stderr",`Hot reload failed: ${error instanceof Error? error.message:String(error)}\n`);
      });
  },[logConsole]);
  return { step,runToCursor,selectThread,selectFrame,loadMoreFrames,restartFrame,hotReload };
}
