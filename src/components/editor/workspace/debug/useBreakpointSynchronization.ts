import { useCallback } from "react";
import { dapSendRequest } from "../../../../lib/editor/dap";
import {
  appendConsoleLine,
  breakpointModesFor,
  breakpointVerificationMap,
  buildSetBreakpointsArgs,
  buildSetDataBreakpointsArgs,
  buildSetExceptionBreakpointsArgs,
  buildSetFunctionBreakpointsArgs,
  buildSetInstructionBreakpointsArgs,
  dataBreakpointKey,
  dataBreakpointVerificationMap,
  exceptionBreakpointRuleVerificationMap,
  exceptionBreakpointVerificationMap,
  functionBreakpointVerificationMap,
  instructionBreakpointKey,
  instructionBreakpointVerificationMap,
  parseBreakpointModes,
  parseSetBreakpointsResponse,
  parseSetDataBreakpointsResponse,
  parseSetExceptionBreakpointsResponse,
  parseSetFunctionBreakpointsResponse,
  parseSetInstructionBreakpointsResponse,
  planBreakpointSync,
  planDataBreakpointSync,
  planExceptionBreakpointSync,
  planFunctionBreakpointSync,
  planInstructionBreakpointSync,
  reconcileBreakpointLines,
  toAdapterSourcePath,
  type BreakpointRuntimeState,
  type DebugBreakpoint,
  type DebugDataBreakpoint,
  type DebugExceptionBreakpoint,
  type DebugExceptionBreakpointRule,
  type DebugFunctionBreakpoint,
  type DebugInstructionBreakpoint,
  type DebugSessionState,
} from "../dapDebugModel";
import { breakpointMasterKeys,breakpointRefKey,masterOf,needsClientHit } from "../debugBreakpointProperties";
import { type BreakpointMap,type DebugSessionRecord } from "./types";
import { errorText } from "./errors";


export interface UseBreakpointSynchronizationContext {
  breakpointsRef: import("react").RefObject<BreakpointMap>;
  sessionsRef: import("react").RefObject<Map<string,DebugSessionRecord>>;
  mutedRef: import("react").RefObject<boolean>;
  updateSessionState: (sessionId: string,updater: (current: DebugSessionState) => DebugSessionState) => void;
  mountedRef: import("react").MutableRefObject<boolean>;
  activeSessionIdRef: import("react").RefObject<string|null>;
  setBreakpointRuntime: import("react").Dispatch<import("react").SetStateAction<Record<string,Record<number,BreakpointRuntimeState>>>>;
  setBreakpoints: import("react").Dispatch<import("react").SetStateAction<BreakpointMap>>;
  persistBreakpoints: (next: BreakpointMap) => void;
  functionBreakpointsRef: import("react").RefObject<DebugFunctionBreakpoint[]>;
  setFunctionBreakpointRuntime: import("react").Dispatch<import("react").SetStateAction<Record<string,BreakpointRuntimeState>>>;
  instructionBreakpointsRef: import("react").RefObject<DebugInstructionBreakpoint[]>;
  setInstructionBreakpointRuntime: import("react").Dispatch<import("react").SetStateAction<Record<string,BreakpointRuntimeState>>>;
  dataBreakpointsRef: import("react").RefObject<DebugDataBreakpoint[]>;
  setDataBreakpointRuntime: import("react").Dispatch<import("react").SetStateAction<Record<string,BreakpointRuntimeState>>>;
  exceptionBreakpointsRef: import("react").RefObject<DebugExceptionBreakpoint[]>;
  exceptionBreakpointRulesRef: import("react").RefObject<DebugExceptionBreakpointRule[]>;
  setExceptionBreakpointRuntime: import("react").Dispatch<import("react").SetStateAction<Record<string,BreakpointRuntimeState>>>;
  setExceptionBreakpointRuleRuntime: import("react").Dispatch<import("react").SetStateAction<Record<string,BreakpointRuntimeState>>>;
}

export function useBreakpointSynchronization(context: UseBreakpointSynchronizationContext) {
  const {
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
  }=context;

  /**
   * Push a file's breakpoints to the adapter and record the bindings it
   * reports: verified flags feed the gutter (grey = not bound), verified line
   * adjustments are adopted back into the stored set (IDEA/VS Code move a
   * breakpoint on a blank line to the next executable one).
   *
   * `list` MUST be passed by callers that just changed the set — React state
   * (and the ref mirroring it) is not updated until the next render, so reading
   * it here would send the pre-change set and the new breakpoint would never
   * arm. `extraTempLine` injects the transient run-to-cursor breakpoint without
   * persisting it.
   */
  const syncBreakpointsForPath=useCallback(async (
    path: string,
    options: { list?: DebugBreakpoint[]; extraTempLine?: number; sessionIds?: readonly string[]; }={},
  ) => {
    const stored=options.list??breakpointsRef.current[path]??[];
    const map={ ...breakpointsRef.current,[path]: stored };
    const masters=breakpointMasterKeys(map);
    const requestedIds=options.sessionIds??Array.from(sessionsRef.current.values())
      .filter((record) => record.live)
      .map((record) => record.id);
    await Promise.all(requestedIds.map(async (id) => {
      const record=sessionsRef.current.get(id);
      if(!record?.live) return;
      // Dependents arm per session: each child of a compound run tracks its
      // own master hits.
      const plan=planBreakpointSync(stored,{
        muted: mutedRef.current,
        extraLine: options.extraTempLine,
        path,
        isArmed: (bp) => !masterOf(bp,map)||record.armedDependents.has(breakpointRefKey(path,bp.line)),
        clientManaged: (bp) => needsClientHit(bp,masters.has(breakpointRefKey(path,bp.line))),
      });
      // Two quick toggles on the same file put two requests in flight; an older
      // response landing last would otherwise re-apply the set it was built from.
      const generation=(record.syncGeneration.get(path)??0)+1;
      record.syncGeneration.set(path,generation);
      const args=buildSetBreakpointsArgs(path,plan,{
        adapterId: record.adapterId,
        breakpointModes: parseBreakpointModes(record.capabilities),
      });
      args.source.path=toAdapterSourcePath(path);
      const body=await dapSendRequest(id,"setBreakpoints",args).catch((error) => {
        updateSessionState(id,(current) => appendConsoleLine(
          current,
          "stderr",
          `setBreakpoints for ${path.split(/[\\/]/).pop()??path} failed: ${errorText(error)}\n`,
        ));
        return null;
      });
      if(body==null||!mountedRef.current) return;
      const current=sessionsRef.current.get(id);
      if(!current||current.syncGeneration.get(path)!==generation) return;
      const bindings=parseSetBreakpointsResponse(plan,body);
      for(const binding of bindings) {
        if(binding.id!=null) current.bpIdIndex.set(binding.id,{ kind: "source",path });
      }
      current.breakpointRuntime={
        ...current.breakpointRuntime,
        [path]: breakpointVerificationMap(plan,bindings),
      };
      if(activeSessionIdRef.current===id) setBreakpointRuntime(current.breakpointRuntime);
      // Different adapters may bind the same source differently. Only the
      // selected session is allowed to move the persisted gutter breakpoint.
      if(options.extraTempLine==null&&activeSessionIdRef.current===id) {
        const reconciled=reconcileBreakpointLines(plan,bindings);
        if(JSON.stringify(reconciled)!==JSON.stringify(plan.sorted)) {
          const next={ ...breakpointsRef.current };
          if(reconciled.length>0) next[path]=reconciled;
          else delete next[path];
          breakpointsRef.current=next;
          setBreakpoints(next);
          persistBreakpoints(next);
        }
      }
    }));
  },[persistBreakpoints,updateSessionState]);

  /** Push the workspace function/method breakpoints to every eligible session. */
  const syncFunctionBreakpoints=useCallback(async (
    options: {
      list?: DebugFunctionBreakpoint[];
      sessionIds?: readonly string[];
    }={},
  ) => {
    const stored=options.list??functionBreakpointsRef.current;
    const plan=planFunctionBreakpointSync(stored,{ muted: mutedRef.current });
    const requestedIds=options.sessionIds??Array.from(sessionsRef.current.values())
      .filter((record) => record.live&&record.initialized)
      .map((record) => record.id);
    await Promise.all(requestedIds.map(async (id) => {
      const record=sessionsRef.current.get(id);
      if(!record?.live||!record.initialized) return;
      const generation=record.functionSyncGeneration+1;
      record.functionSyncGeneration=generation;
      for(const [breakpointId,entry] of record.bpIdIndex) {
        if(entry.kind==="function") record.bpIdIndex.delete(breakpointId);
      }

      const publishRuntime=(runtime: Record<string,BreakpointRuntimeState>) => {
        const current=sessionsRef.current.get(id);
        if(!current?.live||current.functionSyncGeneration!==generation) return;
        current.functionBreakpointRuntime=runtime;
        if(activeSessionIdRef.current===id&&mountedRef.current) {
          setFunctionBreakpointRuntime(runtime);
        }
      };

      if(record.capabilities.supportsFunctionBreakpoints!==true) {
        publishRuntime(Object.fromEntries(plan.sent.map((breakpoint) => [
          breakpoint.name,
          {
            status: "failed" as const,
            message: "The selected debug adapter does not support function breakpoints",
          },
        ])));
        return;
      }

      publishRuntime(Object.fromEntries(plan.sent.map((breakpoint) => [
        breakpoint.name,
        { status: "pending" as const,message: null },
      ])));

      const body=await dapSendRequest(
        id,
        "setFunctionBreakpoints",
        buildSetFunctionBreakpointsArgs(plan),
      ).catch((error) => {
        const current=sessionsRef.current.get(id);
        if(!current?.live||current.functionSyncGeneration!==generation) return null;
        const message=errorText(error);
        updateSessionState(id,(current) => appendConsoleLine(
          current,
          "stderr",
          `setFunctionBreakpoints failed: ${message}\n`,
        ));
        publishRuntime(Object.fromEntries(plan.sent.map((breakpoint) => [
          breakpoint.name,
          { status: "failed" as const,message },
        ])));
        return null;
      });
      if(body==null||!mountedRef.current) return;
      const current=sessionsRef.current.get(id);
      if(!current?.live||current.functionSyncGeneration!==generation) return;
      const bindings=parseSetFunctionBreakpointsResponse(plan,body);
      for(const binding of bindings) {
        if(binding.id!=null) {
          current.bpIdIndex.set(binding.id,{ kind: "function",name: binding.name });
        }
      }
      publishRuntime(functionBreakpointVerificationMap(plan,bindings));
    }));
  },[updateSessionState]);

  /** Replace adapter-scoped instruction breakpoints in every initialized session. */
  const syncInstructionBreakpoints=useCallback(async (
    options: {
      list?: DebugInstructionBreakpoint[];
      sessionIds?: readonly string[];
    }={},
  ) => {
    const stored=options.list??instructionBreakpointsRef.current;
    const requestedIds=options.sessionIds??Array.from(sessionsRef.current.values())
      .filter((record) => record.live&&record.initialized)
      .map((record) => record.id);
    await Promise.all(requestedIds.map(async (id) => {
      const record=sessionsRef.current.get(id);
      if(!record?.live||!record.initialized) return;
      const plan=planInstructionBreakpointSync(stored,{
        adapterId: record.adapterId,
        muted: mutedRef.current,
      });
      const generation=record.instructionSyncGeneration+1;
      record.instructionSyncGeneration=generation;
      for(const [breakpointId,entry] of record.bpIdIndex) {
        if(entry.kind==="instruction") record.bpIdIndex.delete(breakpointId);
      }

      const publishRuntime=(runtime: Record<string,BreakpointRuntimeState>) => {
        const current=sessionsRef.current.get(id);
        if(!current?.live||current.instructionSyncGeneration!==generation) return;
        current.instructionBreakpointRuntime=runtime;
        if(activeSessionIdRef.current===id&&mountedRef.current) {
          setInstructionBreakpointRuntime(runtime);
        }
      };

      if(record.capabilities.supportsInstructionBreakpoints!==true) {
        publishRuntime(Object.fromEntries(plan.sent.map((breakpoint) => [
          instructionBreakpointKey(breakpoint),
          {
            status: "failed" as const,
            message: "The selected debug adapter does not support instruction breakpoints",
          },
        ])));
        return;
      }

      publishRuntime(Object.fromEntries(plan.sent.map((breakpoint) => [
        instructionBreakpointKey(breakpoint),
        { status: "pending" as const,message: null },
      ])));
      const body=await dapSendRequest(
        id,
        "setInstructionBreakpoints",
        buildSetInstructionBreakpointsArgs(plan,breakpointModesFor(
          parseBreakpointModes(record.capabilities),
          "instruction",
        )),
      ).catch((error) => {
        const current=sessionsRef.current.get(id);
        if(!current?.live||current.instructionSyncGeneration!==generation) return null;
        const message=errorText(error);
        updateSessionState(id,(currentState) => appendConsoleLine(
          currentState,
          "stderr",
          `setInstructionBreakpoints failed: ${message}\n`,
        ));
        publishRuntime(Object.fromEntries(plan.sent.map((breakpoint) => [
          instructionBreakpointKey(breakpoint),
          { status: "failed" as const,message },
        ])));
        return null;
      });
      if(body==null||!mountedRef.current) return;
      const current=sessionsRef.current.get(id);
      if(!current?.live||current.instructionSyncGeneration!==generation) return;
      const bindings=parseSetInstructionBreakpointsResponse(plan,body);
      for(const binding of bindings) {
        if(binding.id!=null) {
          current.bpIdIndex.set(binding.id,{ kind: "instruction",key: binding.key });
        }
      }
      publishRuntime(instructionBreakpointVerificationMap(plan,bindings));
    }));
  },[updateSessionState]);

  /** Replace the data-breakpoint set in every initialized adapter session. */
  const syncDataBreakpoints=useCallback(async (
    options: {
      list?: DebugDataBreakpoint[];
      sessionIds?: readonly string[];
    }={},
  ) => {
    const stored=options.list??dataBreakpointsRef.current;
    const requestedIds=options.sessionIds??Array.from(sessionsRef.current.values())
      .filter((record) => record.live&&record.initialized)
      .map((record) => record.id);
    await Promise.all(requestedIds.map(async (id) => {
      const record=sessionsRef.current.get(id);
      if(!record?.live||!record.initialized) return;
      const plan=planDataBreakpointSync(stored,{
        adapterId: record.adapterId,
        sessionId: record.id,
        muted: mutedRef.current,
      });
      const generation=record.dataSyncGeneration+1;
      record.dataSyncGeneration=generation;
      for(const [breakpointId,entry] of record.bpIdIndex) {
        if(entry.kind==="data") record.bpIdIndex.delete(breakpointId);
      }

      const publishRuntime=(runtime: Record<string,BreakpointRuntimeState>) => {
        const current=sessionsRef.current.get(id);
        if(!current?.live||current.dataSyncGeneration!==generation) return;
        current.dataBreakpointRuntime=runtime;
        if(activeSessionIdRef.current===id&&mountedRef.current) {
          setDataBreakpointRuntime(runtime);
        }
      };

      if(record.capabilities.supportsDataBreakpoints!==true) {
        publishRuntime(Object.fromEntries(plan.sent.map((breakpoint) => [
          dataBreakpointKey(breakpoint),
          {
            status: "failed" as const,
            message: "The selected debug adapter does not support data breakpoints",
          },
        ])));
        return;
      }

      publishRuntime(Object.fromEntries(plan.sent.map((breakpoint) => [
        dataBreakpointKey(breakpoint),
        { status: "pending" as const,message: null },
      ])));
      const body=await dapSendRequest(
        id,
        "setDataBreakpoints",
        buildSetDataBreakpointsArgs(plan),
      ).catch((error) => {
        const current=sessionsRef.current.get(id);
        if(!current?.live||current.dataSyncGeneration!==generation) return null;
        const message=errorText(error);
        updateSessionState(id,(currentState) => appendConsoleLine(
          currentState,
          "stderr",
          `setDataBreakpoints failed: ${message}\n`,
        ));
        publishRuntime(Object.fromEntries(plan.sent.map((breakpoint) => [
          dataBreakpointKey(breakpoint),
          { status: "failed" as const,message },
        ])));
        return null;
      });
      if(body==null||!mountedRef.current) return;
      const current=sessionsRef.current.get(id);
      if(!current?.live||current.dataSyncGeneration!==generation) return;
      const bindings=parseSetDataBreakpointsResponse(plan,body);
      for(const binding of bindings) {
        if(binding.id!=null) {
          current.bpIdIndex.set(binding.id,{ kind: "data",key: binding.key });
        }
      }
      publishRuntime(dataBreakpointVerificationMap(plan,bindings));
    }));
  },[updateSessionState]);

  /** Replace exception filters and class/package rules for initialized sessions. */
  const syncExceptionBreakpoints=useCallback(async (
    options: {
      list?: DebugExceptionBreakpoint[];
      rules?: DebugExceptionBreakpointRule[];
      sessionIds?: readonly string[];
    }={},
  ) => {
    const stored=options.list??exceptionBreakpointsRef.current;
    const storedRules=options.rules??exceptionBreakpointRulesRef.current;
    const requestedIds=options.sessionIds??Array.from(sessionsRef.current.values())
      .filter((record) => record.live&&record.initialized)
      .map((record) => record.id);
    await Promise.all(requestedIds.map(async (id) => {
      const record=sessionsRef.current.get(id);
      if(!record?.live||!record.initialized) return;
      const generation=record.exceptionSyncGeneration+1;
      record.exceptionSyncGeneration=generation;
      for(const [breakpointId,entry] of record.bpIdIndex) {
        if(entry.kind==="exception-filter"||entry.kind==="exception-rule") {
          record.bpIdIndex.delete(breakpointId);
        }
      }

      const publishRuntime=(
        filterRuntime: Record<string,BreakpointRuntimeState>,
        ruleRuntime: Record<string,BreakpointRuntimeState>,
      ) => {
        const current=sessionsRef.current.get(id);
        if(!current?.live||current.exceptionSyncGeneration!==generation) return;
        current.exceptionBreakpointRuntime=filterRuntime;
        current.exceptionBreakpointRuleRuntime=ruleRuntime;
        if(activeSessionIdRef.current===id&&mountedRef.current) {
          setExceptionBreakpointRuntime(filterRuntime);
          setExceptionBreakpointRuleRuntime(ruleRuntime);
        }
      };

      // DAP requires clients to call setExceptionBreakpoints only when the
      // adapter advertised at least one exception filter.
      if(record.availableFilters.length===0) {
        publishRuntime({},{});
        return;
      }
      const supportsExceptionOptions=record.capabilities.supportsExceptionOptions===true;
      const plan=planExceptionBreakpointSync(stored,storedRules,record.availableFilters,{
        adapterId: record.adapterId,
        muted: mutedRef.current,
        supportsFilterOptions: record.capabilities.supportsExceptionFilterOptions===true,
        supportsExceptionOptions,
        breakpointModes: parseBreakpointModes(record.capabilities),
      });
      const unsupportedRuleRuntime=!supportsExceptionOptions&&!mutedRef.current
        ? Object.fromEntries(plan.applicableRules
          .filter((rule) => rule.enabled)
          .map((rule) => [
            rule.id,
            {
              status: "failed" as const,
              message: "The selected debug adapter does not support exception path rules",
            },
          ]))
        :{};
      const sentFilters=[...plan.plain,...plan.options.map((entry) => entry.breakpoint)];
      publishRuntime(Object.fromEntries(sentFilters.map((breakpoint) => [
        breakpoint.filterId,
        { status: "pending" as const,message: null },
      ])),supportsExceptionOptions
        ? Object.fromEntries(plan.rules.map((rule) => [
          rule.id,
          { status: "pending" as const,message: null },
        ]))
        :unsupportedRuleRuntime);
      const body=await dapSendRequest(
        id,
        "setExceptionBreakpoints",
        buildSetExceptionBreakpointsArgs(plan),
      ).catch((error) => {
        const current=sessionsRef.current.get(id);
        if(!current?.live||current.exceptionSyncGeneration!==generation) return null;
        const message=errorText(error);
        updateSessionState(id,(currentState) => appendConsoleLine(
          currentState,
          "stderr",
          `setExceptionBreakpoints failed: ${message}\n`,
        ));
        publishRuntime(Object.fromEntries(sentFilters.map((breakpoint) => [
          breakpoint.filterId,
          { status: "failed" as const,message },
        ])),supportsExceptionOptions
          ? Object.fromEntries(plan.rules.map((rule) => [
            rule.id,
            { status: "failed" as const,message },
          ]))
          :unsupportedRuleRuntime);
        return null;
      });
      if(body==null||!mountedRef.current) return;
      const current=sessionsRef.current.get(id);
      if(!current?.live||current.exceptionSyncGeneration!==generation) return;
      const bindings=parseSetExceptionBreakpointsResponse(plan,body);
      for(const binding of bindings) {
        if(binding.id!=null) {
          current.bpIdIndex.set(binding.id,binding.kind==="filter"
            ? { kind: "exception-filter",filterId: binding.filterId }
            :{ kind: "exception-rule",ruleId: binding.ruleId });
        }
      }
      publishRuntime(
        exceptionBreakpointVerificationMap(plan,bindings),
        supportsExceptionOptions
          ? exceptionBreakpointRuleVerificationMap(plan,bindings)
          :unsupportedRuleRuntime,
      );
    }));
  },[updateSessionState]);
  return { syncBreakpointsForPath,syncFunctionBreakpoints,syncInstructionBreakpoints,syncDataBreakpoints,syncExceptionBreakpoints };
}
