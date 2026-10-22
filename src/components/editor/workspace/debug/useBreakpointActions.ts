import { useCallback } from "react";
import { dapSendRequest } from "../../../../lib/editor/dap";
import {
  appendConsoleLine,
  breakpointModesFor,
  buildDataBreakpointInfoArgs,
  dataBreakpointKey,
  defaultDataBreakpointAccessType,
  exceptionBreakpointKey,
  exceptionBreakpointRuleKey,
  instructionBreakpointKey,
  parseBreakpointModes,
  parseDataBreakpointInfo,
  resolveBreakpointMode,
  type DebugBreakpoint,
  type DebugDataBreakpoint,
  type DebugDataBreakpointTarget,
  type DebugExceptionBreakpoint,
  type DebugExceptionBreakpointRule,
  type DebugExceptionBreakMode,
  type DebugExceptionPathSegment,
  type DebugFunctionBreakpoint,
  type DebugInstructionBreakpoint,
  type DebugSessionState,
} from "../dapDebugModel";
import { type BreakpointMap,type DebugSessionRecord,type DataBreakpointAddResult } from "./types";
import {
  normalizeExceptionBreakpoints,
  normalizeBreakpointModeId,
  MAX_SOURCE_BREAKPOINT_ADAPTER_MODES,
  normalizeFunctionBreakpoints,
  MAX_FUNCTION_BREAKPOINT_NAME_LENGTH,
  normalizeInstructionBreakpoints,
  MAX_INSTRUCTION_BREAKPOINTS,
  MAX_INSTRUCTION_OFFSET,
  normalizeInstructionBreakpoint,
  normalizeDataBreakpoints,
  MAX_DATA_BREAKPOINT_ID_LENGTH,
  MAX_DATA_BREAKPOINTS,
  normalizeDataBreakpointBytes,
  isDataBreakpointAddress,
  normalizeDataBreakpoint,
  normalizeExceptionBreakpoint,
  normalizeExceptionBreakpointRules,
  MAX_EXCEPTION_BREAKPOINT_RULES,
  normalizeExceptionPath,
  createExceptionBreakpointRuleId,
  normalizeExceptionBreakpointRule,
} from "./breakpointPersistence";
import { errorText } from "./errors";


export interface UseBreakpointActionsContext {
  mutateBreakpoints: (path: string,updater: (list: DebugBreakpoint[]) => DebugBreakpoint[],options?: { sessionIds?: readonly string[]; }) => void;
  breakpointsRef: import("react").RefObject<BreakpointMap>;
  syncBreakpointsForPath: (path: string,options?: { list?: DebugBreakpoint[]; extraTempLine?: number; sessionIds?: readonly string[]; }) => Promise<void>;
  activeSessionIdRef: import("react").RefObject<string|null>;
  sessionsRef: import("react").RefObject<Map<string,DebugSessionRecord>>;
  functionBreakpointsRef: import("react").RefObject<DebugFunctionBreakpoint[]>;
  setFunctionBreakpoints: import("react").Dispatch<import("react").SetStateAction<DebugFunctionBreakpoint[]>>;
  persistFunctionBreakpoints: (next: DebugFunctionBreakpoint[]) => void;
  syncFunctionBreakpoints: (options?: { list?: DebugFunctionBreakpoint[]; sessionIds?: readonly string[]; }) => Promise<void>;
  instructionBreakpointsRef: import("react").RefObject<DebugInstructionBreakpoint[]>;
  setInstructionBreakpoints: import("react").Dispatch<import("react").SetStateAction<DebugInstructionBreakpoint[]>>;
  persistInstructionBreakpoints: (next: DebugInstructionBreakpoint[]) => void;
  syncInstructionBreakpoints: (options?: { list?: DebugInstructionBreakpoint[]; sessionIds?: readonly string[]; }) => Promise<void>;
  dataBreakpointsRef: import("react").RefObject<DebugDataBreakpoint[]>;
  setDataBreakpoints: import("react").Dispatch<import("react").SetStateAction<DebugDataBreakpoint[]>>;
  persistDataBreakpoints: (next: DebugDataBreakpoint[]) => void;
  syncDataBreakpoints: (options?: { list?: DebugDataBreakpoint[]; sessionIds?: readonly string[]; }) => Promise<void>;
  updateSessionState: (sessionId: string,updater: (current: DebugSessionState) => DebugSessionState) => void;
  mutedRef: import("react").RefObject<boolean>;
  setBreakpointsMutedState: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  syncExceptionBreakpoints: (options?: { list?: DebugExceptionBreakpoint[]; rules?: DebugExceptionBreakpointRule[]; sessionIds?: readonly string[]; }) => Promise<void>;
  setBreakpoints: import("react").Dispatch<import("react").SetStateAction<BreakpointMap>>;
  persistBreakpoints: (next: BreakpointMap) => void;
  exceptionBreakpointsRef: import("react").RefObject<DebugExceptionBreakpoint[]>;
  setExceptionBreakpoints: import("react").Dispatch<import("react").SetStateAction<DebugExceptionBreakpoint[]>>;
  persistExceptionBreakpoints: (next: DebugExceptionBreakpoint[]) => void;
  exceptionBreakpointRulesRef: import("react").RefObject<DebugExceptionBreakpointRule[]>;
  setExceptionBreakpointRules: import("react").Dispatch<import("react").SetStateAction<DebugExceptionBreakpointRule[]>>;
  persistExceptionBreakpointRules: (next: DebugExceptionBreakpointRule[]) => void;
}

export function useBreakpointActions(context: UseBreakpointActionsContext) {
  const {
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
  }=context;

  const toggleBreakpoint=useCallback((path: string,line: number) => {
    mutateBreakpoints(path,(list) => (
      list.some((bp) => bp.line===line)
        ? list.filter((bp) => bp.line!==line)
        :[...list,{ line }]
    ));
  },[mutateBreakpoints]);

  const removeBreakpoint=useCallback((path: string,line: number) => {
    mutateBreakpoints(path,(list) => list.filter((bp) => bp.line!==line));
  },[mutateBreakpoints]);

  const setBreakpointOptions=useCallback((path: string,line: number,options: Partial<DebugBreakpoint>) => {
    const previousMaster=breakpointsRef.current[path]?.find((bp) => bp.line===line)?.dependsOn;
    mutateBreakpoints(path,(list) => (
      list.some((bp) => bp.line===line)
        ? list.map((bp) => (bp.line===line? { ...bp,...options }:bp))
        :list
    ));
    // A master's own request changes once something depends on it (its hits
    // must reach the client), so re-sync the old and new master files.
    if("dependsOn" in options) {
      const masterPaths=new Set([previousMaster?.path,options.dependsOn?.path]);
      masterPaths.delete(undefined);
      masterPaths.delete(path);
      for(const masterPath of masterPaths) if(masterPath) void syncBreakpointsForPath(masterPath);
    }
  },[mutateBreakpoints,syncBreakpointsForPath]);

  /** Add (or update) a breakpoint with IDEA properties — Alt/Shift+click kinds. */
  const addBreakpoint=useCallback((path: string,line: number,options: Partial<DebugBreakpoint>={}) => {
    mutateBreakpoints(path,(list) => (
      list.some((bp) => bp.line===line)
        ? list.map((bp) => (bp.line===line? { ...bp,...options,line }:bp))
        :[...list,{ ...options,line }]
    ));
  },[mutateBreakpoints]);

  /** IDEA middle-click / Toggle Breakpoint Enabled. */
  const toggleBreakpointEnabled=useCallback((path: string,line: number) => {
    mutateBreakpoints(path,(list) => list.map((bp) => (
      bp.line===line? { ...bp,enabled: bp.enabled===false }:bp
    )));
  },[mutateBreakpoints]);

  const setBreakpointMode=useCallback((path: string,line: number,rawMode: string) => {
    const sessionId=activeSessionIdRef.current;
    const active=sessionId? sessionsRef.current.get(sessionId):undefined;
    const mode=normalizeBreakpointModeId(rawMode);
    if(!active?.live||!mode) return;
    const applicable=breakpointModesFor(parseBreakpointModes(active.capabilities),"source");
    if(!applicable.some((candidate) => candidate.mode===mode)) return;
    const sessionIds=Array.from(sessionsRef.current.values())
      .filter((record) => record.live&&record.initialized&&record.adapterId===active.adapterId)
      .map((record) => record.id);
    mutateBreakpoints(path,(list) => list.map((breakpoint) => {
      if(breakpoint.line!==line) return breakpoint;
      const retained=Object.entries(breakpoint.adapterModes??{})
        .filter(([adapterId]) => adapterId!==active.adapterId)
        .slice(-(MAX_SOURCE_BREAKPOINT_ADAPTER_MODES-1));
      return {
        ...breakpoint,
        adapterModes: Object.fromEntries([...retained,[active.adapterId,mode]]),
      };
    }),{ sessionIds });
  },[mutateBreakpoints]);

  const mutateFunctionBreakpoints=useCallback((
    updater: (current: DebugFunctionBreakpoint[]) => DebugFunctionBreakpoint[],
  ) => {
    const current=functionBreakpointsRef.current;
    const updated=updater(current);
    if(updated===current) return;
    const next=normalizeFunctionBreakpoints(updated);
    functionBreakpointsRef.current=next;
    setFunctionBreakpoints(next);
    persistFunctionBreakpoints(next);
    void syncFunctionBreakpoints({ list: next });
  },[persistFunctionBreakpoints,syncFunctionBreakpoints]);

  const addFunctionBreakpoint=useCallback((rawName: string) => {
    const name=rawName.trim().slice(0,MAX_FUNCTION_BREAKPOINT_NAME_LENGTH);
    if(!name) return;
    mutateFunctionBreakpoints((current) => (
      current.some((breakpoint) => breakpoint.name===name)
        ? current
        :[...current,{ name }]
    ));
  },[mutateFunctionBreakpoints]);

  const setFunctionBreakpointOptions=useCallback((
    name: string,
    options: Partial<DebugFunctionBreakpoint>,
  ) => {
    mutateFunctionBreakpoints((current) => current.map((breakpoint) => (
      breakpoint.name===name
        ? { ...breakpoint,...options,name: breakpoint.name }
        :breakpoint
    )));
  },[mutateFunctionBreakpoints]);

  const removeFunctionBreakpoint=useCallback((name: string) => {
    mutateFunctionBreakpoints((current) => current.filter((breakpoint) => breakpoint.name!==name));
  },[mutateFunctionBreakpoints]);

  const mutateInstructionBreakpoints=useCallback((
    adapterId: string,
    updater: (current: DebugInstructionBreakpoint[]) => DebugInstructionBreakpoint[],
  ) => {
    const current=instructionBreakpointsRef.current;
    const updated=updater(current);
    if(updated===current) return;
    const next=normalizeInstructionBreakpoints(updated);
    instructionBreakpointsRef.current=next;
    setInstructionBreakpoints(next);
    persistInstructionBreakpoints(next);
    const sessionIds=Array.from(sessionsRef.current.values())
      .filter((record) => record.live&&record.initialized&&record.adapterId===adapterId)
      .map((record) => record.id);
    void syncInstructionBreakpoints({ list: next,sessionIds });
  },[persistInstructionBreakpoints,syncInstructionBreakpoints]);

  const addInstructionBreakpoint=useCallback((target: {
    instructionReference: string;
    offset?: number;
    mode?: string;
  }): boolean => {
    const sessionId=activeSessionIdRef.current;
    const active=sessionId? sessionsRef.current.get(sessionId):undefined;
    if(!active?.live||active.capabilities.supportsInstructionBreakpoints!==true) return false;
    if(instructionBreakpointsRef.current.length>=MAX_INSTRUCTION_BREAKPOINTS) return false;
    if(
      target.offset!==undefined
      &&(!Number.isSafeInteger(target.offset)||Math.abs(target.offset)>MAX_INSTRUCTION_OFFSET)
    ) return false;
    const modes=breakpointModesFor(parseBreakpointModes(active.capabilities),"instruction");
    const requestedMode=normalizeBreakpointModeId(target.mode);
    if(target.mode!==undefined&&!modes.some((candidate) => candidate.mode===requestedMode)) {
      return false;
    }
    const breakpoint=normalizeInstructionBreakpoint({
      adapterId: active.adapterId,
      instructionReference: target.instructionReference,
      offset: target.offset,
      mode: resolveBreakpointMode(requestedMode,modes,"instruction"),
    });
    if(!breakpoint) return false;
    const key=instructionBreakpointKey(breakpoint);
    let added=false;
    mutateInstructionBreakpoints(active.adapterId,(current) => {
      if(current.some((entry) => instructionBreakpointKey(entry)===key)) return current;
      added=true;
      return [...current,breakpoint];
    });
    return added;
  },[mutateInstructionBreakpoints]);

  const setInstructionBreakpointOptions=useCallback((
    key: string,
    options: Partial<Pick<DebugInstructionBreakpoint,"enabled"|"condition"|"hitCondition"|"mode">>,
  ) => {
    const existing=instructionBreakpointsRef.current.find((breakpoint) => (
      instructionBreakpointKey(breakpoint)===key
    ));
    if(!existing) return;
    let mode=existing.mode;
    if(Object.prototype.hasOwnProperty.call(options,"mode")) {
      const requestedMode=normalizeBreakpointModeId(options.mode);
      const session=Array.from(sessionsRef.current.values()).find((record) => (
        record.live&&record.adapterId===existing.adapterId
      ));
      const modes=session
        ? breakpointModesFor(parseBreakpointModes(session.capabilities),"instruction")
        :[];
      if(!requestedMode||!modes.some((candidate) => candidate.mode===requestedMode)) return;
      mode=requestedMode;
    }
    mutateInstructionBreakpoints(existing.adapterId,(current) => current.map((breakpoint) => (
      instructionBreakpointKey(breakpoint)===key
        ? {
          ...breakpoint,
          ...options,
          adapterId: breakpoint.adapterId,
          instructionReference: breakpoint.instructionReference,
          offset: breakpoint.offset,
          mode,
        }
        :breakpoint
    )));
  },[mutateInstructionBreakpoints]);

  const removeInstructionBreakpoint=useCallback((key: string) => {
    const existing=instructionBreakpointsRef.current.find((breakpoint) => (
      instructionBreakpointKey(breakpoint)===key
    ));
    if(!existing) return;
    mutateInstructionBreakpoints(existing.adapterId,(current) => current.filter((breakpoint) => (
      instructionBreakpointKey(breakpoint)!==key
    )));
  },[mutateInstructionBreakpoints]);

  const mutateDataBreakpoints=useCallback((
    updater: (current: DebugDataBreakpoint[]) => DebugDataBreakpoint[],
  ) => {
    const current=dataBreakpointsRef.current;
    const updated=updater(current);
    if(updated===current) return;
    const next=normalizeDataBreakpoints(updated);
    dataBreakpointsRef.current=next;
    setDataBreakpoints(next);
    persistDataBreakpoints(next);
    void syncDataBreakpoints({ list: next });
  },[persistDataBreakpoints,syncDataBreakpoints]);

  const addDataBreakpoint=useCallback(async (
    target: DebugDataBreakpointTarget,
  ): Promise<DataBreakpointAddResult> => {
    const id=activeSessionIdRef.current;
    const record=id? sessionsRef.current.get(id):undefined;
    const name=target.name.trim();
    if(!id||!record?.live||record.state.status!=="stopped") {
      return { added: false,message: "Data breakpoints can only be created while execution is stopped" };
    }
    if(record.capabilities.supportsDataBreakpoints!==true) {
      return { added: false,message: "The selected debug adapter does not support data breakpoints" };
    }
    if(!name) return { added: false,message: "The data breakpoint target is empty" };
    if(name.length>MAX_DATA_BREAKPOINT_ID_LENGTH) {
      return { added: false,message: "The data breakpoint target is too long" };
    }
    if(dataBreakpointsRef.current.length>=MAX_DATA_BREAKPOINTS) {
      return { added: false,message: `Data breakpoint limit reached (${MAX_DATA_BREAKPOINTS})` };
    }
    const supportsDataBreakpointBytes=record.capabilities.supportsDataBreakpointBytes===true;
    const requestedBytes=normalizeDataBreakpointBytes(target.bytes);
    const requestedAsAddress=target.asAddress===true;
    if((target.bytes!==undefined||requestedAsAddress)&&!supportsDataBreakpointBytes) {
      return { added: false,message: "The selected debug adapter does not support address/range data breakpoints" };
    }
    if(target.bytes!==undefined&&requestedBytes===undefined) {
      return { added: false,message: "Data breakpoint byte count must be an integer between 1 and 4294967295" };
    }
    if(requestedAsAddress&&!isDataBreakpointAddress(name)) {
      return { added: false,message: "Address data breakpoints require a decimal or 0x-prefixed hexadecimal address" };
    }
    if(requestedAsAddress&&(typeof target.variablesReference==="number"||typeof target.frameId==="number")) {
      return { added: false,message: "Address data breakpoints cannot be scoped to a variable or frame" };
    }
    const dataModes=breakpointModesFor(parseBreakpointModes(record.capabilities),"data");
    const requestedMode=normalizeBreakpointModeId(target.mode);
    if(requestedMode&&!dataModes.some((candidate) => candidate.mode===requestedMode)) {
      return { added: false,message: "The selected data-breakpoint mode is not supported" };
    }
    const mode=resolveBreakpointMode(requestedMode,dataModes,"data");
    const epoch=record.stopEpoch;
    let body: unknown;
    try {
      body=await dapSendRequest(id,"dataBreakpointInfo",buildDataBreakpointInfoArgs({
        name,
        variablesReference: target.variablesReference,
        frameId: target.frameId,
        bytes: requestedBytes,
        asAddress: requestedAsAddress||undefined,
        mode,
      }));
    } catch(error) {
      const message=`Data breakpoint discovery failed: ${errorText(error)}`;
      updateSessionState(id,(current) => appendConsoleLine(current,"stderr",`${message}\n`));
      return { added: false,message };
    }
    const current=sessionsRef.current.get(id);
    if(!current?.live||current.stopEpoch!==epoch||current.state.status!=="stopped") {
      return { added: false,message: "Execution resumed before the data breakpoint was resolved" };
    }
    const info=parseDataBreakpointInfo(body);
    if(!info.dataId) {
      const message=info.description||"The selected value cannot be watched by this adapter";
      updateSessionState(id,(state) => appendConsoleLine(state,"stderr",`${message}\n`));
      return { added: false,message };
    }
    const breakpoint=normalizeDataBreakpoint({
      dataId: info.dataId,
      description: info.description||name,
      adapterId: record.adapterId,
      accessTypes: info.accessTypes,
      accessType: defaultDataBreakpointAccessType(info.accessTypes),
      bytes: requestedBytes,
      asAddress: requestedAsAddress||undefined,
      mode,
      canPersist: info.canPersist,
      sessionId: info.canPersist? undefined:record.id,
    });
    if(!breakpoint) {
      return { added: false,message: "The debug adapter returned invalid data-breakpoint metadata" };
    }
    const key=dataBreakpointKey(breakpoint);
    if(dataBreakpointsRef.current.some((entry) => dataBreakpointKey(entry)===key)) {
      return { added: false,message: `${breakpoint.description} is already watched` };
    }
    mutateDataBreakpoints((entries) => [...entries,breakpoint]);
    return {
      added: true,
      message: breakpoint.canPersist
        ? `Watching ${breakpoint.description}`
        :`Watching ${breakpoint.description} for this debug session`,
    };
  },[mutateDataBreakpoints,updateSessionState]);

  const setDataBreakpointOptions=useCallback((
    key: string,
    options: Partial<DebugDataBreakpoint>,
  ) => {
    mutateDataBreakpoints((current) => current.map((breakpoint) => (
      dataBreakpointKey(breakpoint)===key
        ? {
          ...breakpoint,
          ...options,
          dataId: breakpoint.dataId,
          adapterId: breakpoint.adapterId,
          bytes: breakpoint.bytes,
          asAddress: breakpoint.asAddress,
          mode: breakpoint.mode,
          canPersist: breakpoint.canPersist,
          sessionId: breakpoint.sessionId,
        }
        :breakpoint
    )));
  },[mutateDataBreakpoints]);

  const removeDataBreakpoint=useCallback((key: string) => {
    mutateDataBreakpoints((current) => current.filter((breakpoint) => (
      dataBreakpointKey(breakpoint)!==key
    )));
  },[mutateDataBreakpoints]);

  /** IDEA "Mute Breakpoints": re-push every file with the new suppression. */
  const setBreakpointsMuted=useCallback((muted: boolean) => {
    mutedRef.current=muted;
    setBreakpointsMutedState(muted);
    for(const path of Object.keys(breakpointsRef.current)) {
      void syncBreakpointsForPath(path);
    }
    void syncFunctionBreakpoints();
    void syncInstructionBreakpoints();
    void syncDataBreakpoints();
    void syncExceptionBreakpoints();
  },[
    syncBreakpointsForPath,
    syncDataBreakpoints,
    syncExceptionBreakpoints,
    syncFunctionBreakpoints,
    syncInstructionBreakpoints,
  ]);

  const removeAllBreakpoints=useCallback(() => {
    const paths=Object.keys(breakpointsRef.current);
    breakpointsRef.current={};
    setBreakpoints({});
    persistBreakpoints({});
    for(const path of paths) void syncBreakpointsForPath(path,{ list: [] });
    functionBreakpointsRef.current=[];
    setFunctionBreakpoints([]);
    persistFunctionBreakpoints([]);
    void syncFunctionBreakpoints({ list: [] });
    instructionBreakpointsRef.current=[];
    setInstructionBreakpoints([]);
    persistInstructionBreakpoints([]);
    void syncInstructionBreakpoints({ list: [] });
    dataBreakpointsRef.current=[];
    setDataBreakpoints([]);
    persistDataBreakpoints([]);
    void syncDataBreakpoints({ list: [] });
    const nextExceptionBreakpoints=exceptionBreakpointsRef.current.map((breakpoint) => (
      breakpoint.enabled? { ...breakpoint,enabled: false }:breakpoint
    ));
    exceptionBreakpointsRef.current=nextExceptionBreakpoints;
    setExceptionBreakpoints(nextExceptionBreakpoints);
    persistExceptionBreakpoints(nextExceptionBreakpoints);
    exceptionBreakpointRulesRef.current=[];
    setExceptionBreakpointRules([]);
    persistExceptionBreakpointRules([]);
    void syncExceptionBreakpoints({ list: nextExceptionBreakpoints,rules: [] });
  },[
    persistBreakpoints,
    persistDataBreakpoints,
    persistExceptionBreakpoints,
    persistExceptionBreakpointRules,
    persistFunctionBreakpoints,
    persistInstructionBreakpoints,
    syncBreakpointsForPath,
    syncDataBreakpoints,
    syncExceptionBreakpoints,
    syncFunctionBreakpoints,
    syncInstructionBreakpoints,
  ]);

  const setExceptionBreakpointOptions=useCallback((
    filterId: string,
    options: Partial<Pick<DebugExceptionBreakpoint,"enabled"|"condition"|"mode">>,
  ) => {
    const sessionId=activeSessionIdRef.current;
    const active=sessionId? sessionsRef.current.get(sessionId):undefined;
    if(!active?.live) return;
    const filter=active.availableFilters.find((candidate) => candidate.filter===filterId);
    if(!filter) return;
    const current=exceptionBreakpointsRef.current;
    const key=exceptionBreakpointKey({ adapterId: active.adapterId,filterId });
    const index=current.findIndex((breakpoint) => exceptionBreakpointKey(breakpoint)===key);
    const existing=index>=0
      ? current[index]
      :{ adapterId: active.adapterId,filterId,enabled: filter.default };
    const canSetCondition=filter.supportsCondition
      &&active.capabilities.supportsExceptionFilterOptions===true;
    const exceptionModes=breakpointModesFor(parseBreakpointModes(active.capabilities),"exception");
    const canSetMode=active.capabilities.supportsExceptionFilterOptions===true
      &&exceptionModes.length>0;
    const condition=Object.prototype.hasOwnProperty.call(options,"condition")&&canSetCondition
      ? options.condition
      :existing.condition;
    const requestedMode=normalizeBreakpointModeId(options.mode);
    const mode=Object.prototype.hasOwnProperty.call(options,"mode")
      &&canSetMode
      &&requestedMode
      &&exceptionModes.some((candidate) => candidate.mode===requestedMode)
      ? requestedMode
      :existing.mode;
    const updated=normalizeExceptionBreakpoint({
      ...existing,
      enabled: typeof options.enabled==="boolean"? options.enabled:existing.enabled,
      condition,
      mode,
    });
    if(!updated) return;
    const next=normalizeExceptionBreakpoints(index>=0
      ? current.map((breakpoint,position) => (position===index? updated:breakpoint))
      :[...current,updated]);
    exceptionBreakpointsRef.current=next;
    setExceptionBreakpoints(next);
    persistExceptionBreakpoints(next);
    const sessionIds=Array.from(sessionsRef.current.values())
      .filter((record) => record.live&&record.initialized&&record.adapterId===active.adapterId)
      .map((record) => record.id);
    void syncExceptionBreakpoints({ list: next,sessionIds });
  },[persistExceptionBreakpoints,syncExceptionBreakpoints]);

  const mutateExceptionBreakpointRules=useCallback((
    adapterId: string,
    updater: (current: DebugExceptionBreakpointRule[]) => DebugExceptionBreakpointRule[],
  ) => {
    const next=normalizeExceptionBreakpointRules(updater(exceptionBreakpointRulesRef.current));
    exceptionBreakpointRulesRef.current=next;
    setExceptionBreakpointRules(next);
    persistExceptionBreakpointRules(next);
    const sessionIds=Array.from(sessionsRef.current.values())
      .filter((record) => record.live&&record.initialized&&record.adapterId===adapterId)
      .map((record) => record.id);
    void syncExceptionBreakpoints({ rules: next,sessionIds });
  },[persistExceptionBreakpointRules,syncExceptionBreakpoints]);

  const addExceptionBreakpointRule=useCallback((
    path: DebugExceptionPathSegment[],
    breakMode: DebugExceptionBreakMode="always",
  ): string|null => {
    const sessionId=activeSessionIdRef.current;
    const active=sessionId? sessionsRef.current.get(sessionId):undefined;
    if(
      !active?.live
      ||active.availableFilters.length===0
      ||active.capabilities.supportsExceptionOptions!==true
      ||exceptionBreakpointRulesRef.current.length>=MAX_EXCEPTION_BREAKPOINT_RULES
    ) return null;
    const normalizedPath=normalizeExceptionPath(path);
    if(!normalizedPath) return null;
    let id=createExceptionBreakpointRuleId();
    const known=new Set(exceptionBreakpointRulesRef.current.map(exceptionBreakpointRuleKey));
    while(known.has(exceptionBreakpointRuleKey({ adapterId: active.adapterId,id }))) {
      id=createExceptionBreakpointRuleId();
    }
    const rule=normalizeExceptionBreakpointRule({
      id,
      adapterId: active.adapterId,
      path: normalizedPath,
      breakMode,
      enabled: true,
    });
    if(!rule) return null;
    mutateExceptionBreakpointRules(active.adapterId,(current) => [...current,rule]);
    return id;
  },[mutateExceptionBreakpointRules]);

  const setExceptionBreakpointRuleOptions=useCallback((
    ruleId: string,
    options: Partial<Pick<DebugExceptionBreakpointRule,"enabled"|"path"|"breakMode">>,
  ) => {
    const sessionId=activeSessionIdRef.current;
    const active=sessionId? sessionsRef.current.get(sessionId):undefined;
    if(!active?.live) return;
    mutateExceptionBreakpointRules(active.adapterId,(current) => current.map((rule) => (
      rule.id===ruleId&&rule.adapterId===active.adapterId
        ? {
          ...rule,
          ...(typeof options.enabled==="boolean"? { enabled: options.enabled }:{}),
          ...(options.path? { path: options.path }:{}),
          ...(options.breakMode? { breakMode: options.breakMode }:{}),
        }
        :rule
    )));
  },[mutateExceptionBreakpointRules]);

  const removeExceptionBreakpointRule=useCallback((ruleId: string) => {
    const sessionId=activeSessionIdRef.current;
    const active=sessionId? sessionsRef.current.get(sessionId):undefined;
    if(!active?.live) return;
    mutateExceptionBreakpointRules(active.adapterId,(current) => current.filter((rule) => (
      rule.adapterId!==active.adapterId||rule.id!==ruleId
    )));
  },[mutateExceptionBreakpointRules]);
  return { setBreakpointsMuted,removeAllBreakpoints,toggleBreakpoint,addBreakpoint,toggleBreakpointEnabled,setBreakpointOptions,setBreakpointMode,removeBreakpoint,addFunctionBreakpoint,setFunctionBreakpointOptions,removeFunctionBreakpoint,addInstructionBreakpoint,setInstructionBreakpointOptions,removeInstructionBreakpoint,addDataBreakpoint,setDataBreakpointOptions,removeDataBreakpoint,setExceptionBreakpointOptions,addExceptionBreakpointRule,setExceptionBreakpointRuleOptions,removeExceptionBreakpointRule };
}
