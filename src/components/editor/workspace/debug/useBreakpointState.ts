import { useCallback,useRef,useState } from "react";
import {
  type BreakpointRuntimeState,
  type DebugDataBreakpoint,
  type DebugExceptionBreakpoint,
  type DebugExceptionBreakpointRule,
  type DebugFunctionBreakpoint,
  type DebugInstructionBreakpoint,
} from "../dapDebugModel";
import { type BreakpointMap } from "./types";
import {
  readBreakpoints,
  readFunctionBreakpoints,
  readInstructionBreakpoints,
  readDataBreakpoints,
  readExceptionBreakpoints,
  readExceptionBreakpointRules,
  breakpointsKey,
  functionBreakpointsKey,
  instructionBreakpointsKey,
  dataBreakpointsKey,
  exceptionBreakpointsKey,
  exceptionBreakpointRulesKey,
} from "./breakpointPersistence";


export interface UseBreakpointStateContext {
  workspaceInstanceId: string;
  mountedRef: import("react").MutableRefObject<boolean>;
}

export function useBreakpointState(context: UseBreakpointStateContext) {
  const { workspaceInstanceId }=context;
  const [breakpoints,setBreakpoints]=useState<BreakpointMap>(() => readBreakpoints(workspaceInstanceId));
  const [breakpointRuntime,setBreakpointRuntime]=useState<Record<string,Record<number,BreakpointRuntimeState>>>({});
  const [functionBreakpoints,setFunctionBreakpoints]=useState<DebugFunctionBreakpoint[]>(
    () => readFunctionBreakpoints(workspaceInstanceId),
  );
  const [functionBreakpointRuntime,setFunctionBreakpointRuntime]=useState<
    Record<string,BreakpointRuntimeState>
  >({});
  const [instructionBreakpoints,setInstructionBreakpoints]=useState<DebugInstructionBreakpoint[]>(
    () => readInstructionBreakpoints(workspaceInstanceId),
  );
  const [instructionBreakpointRuntime,setInstructionBreakpointRuntime]=useState<
    Record<string,BreakpointRuntimeState>
  >({});
  const [dataBreakpoints,setDataBreakpoints]=useState<DebugDataBreakpoint[]>(
    () => readDataBreakpoints(workspaceInstanceId),
  );
  const [dataBreakpointRuntime,setDataBreakpointRuntime]=useState<
    Record<string,BreakpointRuntimeState>
  >({});
  const [exceptionBreakpoints,setExceptionBreakpoints]=useState<DebugExceptionBreakpoint[]>(
    () => readExceptionBreakpoints(workspaceInstanceId),
  );
  const [exceptionBreakpointRuntime,setExceptionBreakpointRuntime]=useState<
    Record<string,BreakpointRuntimeState>
  >({});
  const [exceptionBreakpointRules,setExceptionBreakpointRules]=useState<
    DebugExceptionBreakpointRule[]
  >(() => readExceptionBreakpointRules(workspaceInstanceId));
  const [exceptionBreakpointRuleRuntime,setExceptionBreakpointRuleRuntime]=useState<
    Record<string,BreakpointRuntimeState>
  >({});
  const [breakpointsMuted,setBreakpointsMutedState]=useState(false);
  const breakpointsRef=useRef(breakpoints);
  const functionBreakpointsRef=useRef(functionBreakpoints);
  const instructionBreakpointsRef=useRef(instructionBreakpoints);
  const dataBreakpointsRef=useRef(dataBreakpoints);
  const exceptionBreakpointsRef=useRef(exceptionBreakpoints);
  const exceptionBreakpointRulesRef=useRef(exceptionBreakpointRules);
  const mutedRef=useRef(breakpointsMuted);
  breakpointsRef.current=breakpoints;
  functionBreakpointsRef.current=functionBreakpoints;
  instructionBreakpointsRef.current=instructionBreakpoints;
  dataBreakpointsRef.current=dataBreakpoints;
  exceptionBreakpointsRef.current=exceptionBreakpoints;
  exceptionBreakpointRulesRef.current=exceptionBreakpointRules;
  mutedRef.current=breakpointsMuted;

  const persistBreakpoints=useCallback((next: BreakpointMap) => {
    try {
      window.localStorage.setItem(breakpointsKey(workspaceInstanceId),JSON.stringify(next));
    } catch {
      // Ignore storage failures.
    }
  },[workspaceInstanceId]);

  const persistFunctionBreakpoints=useCallback((next: DebugFunctionBreakpoint[]) => {
    try {
      window.localStorage.setItem(functionBreakpointsKey(workspaceInstanceId),JSON.stringify(next));
    } catch {
      // Ignore storage failures.
    }
  },[workspaceInstanceId]);

  const persistInstructionBreakpoints=useCallback((next: DebugInstructionBreakpoint[]) => {
    try {
      window.localStorage.setItem(
        instructionBreakpointsKey(workspaceInstanceId),
        JSON.stringify(next),
      );
    } catch {
      // Ignore storage failures.
    }
  },[workspaceInstanceId]);

  const persistDataBreakpoints=useCallback((next: DebugDataBreakpoint[]) => {
    try {
      window.localStorage.setItem(
        dataBreakpointsKey(workspaceInstanceId),
        JSON.stringify(next.filter((breakpoint) => breakpoint.canPersist)),
      );
    } catch {
      // Ignore storage failures.
    }
  },[workspaceInstanceId]);

  const persistExceptionBreakpoints=useCallback((next: DebugExceptionBreakpoint[]) => {
    try {
      window.localStorage.setItem(
        exceptionBreakpointsKey(workspaceInstanceId),
        JSON.stringify(next),
      );
    } catch {
      // Ignore storage failures.
    }
  },[workspaceInstanceId]);

  const persistExceptionBreakpointRules=useCallback((next: DebugExceptionBreakpointRule[]) => {
    try {
      window.localStorage.setItem(
        exceptionBreakpointRulesKey(workspaceInstanceId),
        JSON.stringify(next),
      );
    } catch {
      // Ignore storage failures.
    }
  },[workspaceInstanceId]);

  const dropSessionDataBreakpoints=useCallback((sessionIds: ReadonlySet<string>) => {
    const current=dataBreakpointsRef.current;
    const next=current.filter((breakpoint) => (
      !breakpoint.sessionId||!sessionIds.has(breakpoint.sessionId)
    ));
    if(next.length===current.length) return;
    dataBreakpointsRef.current=next;
    if(context.mountedRef.current) setDataBreakpoints(next);
  },[]);
  return { setBreakpointRuntime,setFunctionBreakpointRuntime,setInstructionBreakpointRuntime,setDataBreakpointRuntime,setExceptionBreakpointRuntime,setExceptionBreakpointRuleRuntime,breakpointsRef,mutedRef,setBreakpoints,persistBreakpoints,functionBreakpointsRef,instructionBreakpointsRef,dataBreakpointsRef,exceptionBreakpointsRef,exceptionBreakpointRulesRef,dropSessionDataBreakpoints,setExceptionBreakpoints,persistExceptionBreakpoints,setFunctionBreakpoints,persistFunctionBreakpoints,setInstructionBreakpoints,persistInstructionBreakpoints,setDataBreakpoints,persistDataBreakpoints,setBreakpointsMutedState,setExceptionBreakpointRules,persistExceptionBreakpointRules,breakpoints,breakpointRuntime,functionBreakpoints,functionBreakpointRuntime,instructionBreakpoints,instructionBreakpointRuntime,dataBreakpoints,dataBreakpointRuntime,exceptionBreakpoints,exceptionBreakpointRuntime,exceptionBreakpointRules,exceptionBreakpointRuleRuntime,breakpointsMuted };
}
