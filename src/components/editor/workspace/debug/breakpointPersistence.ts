import {
  dataBreakpointKey,
  defaultDataBreakpointAccessType,
  exceptionBreakpointKey,
  exceptionBreakpointRuleKey,
  instructionBreakpointKey,
  type DebugBreakpoint,
  type DebugDataBreakpoint,
  type DebugExceptionBreakpoint,
  type DebugExceptionBreakpointRule,
  type DebugExceptionPathSegment,
  type DebugFunctionBreakpoint,
  type DebugInstructionBreakpoint,
} from "../dapDebugModel";
import { type BreakpointMap } from "./types";

export function breakpointsKey(workspaceInstanceId: string): string {
  return `taomni.codeWorkspace.debugBreakpoints.v1.${workspaceInstanceId}`;
}

export function watchesKey(workspaceInstanceId: string): string {
  return `taomni.codeWorkspace.debugWatches.v1.${workspaceInstanceId}`;
}

export function functionBreakpointsKey(workspaceInstanceId: string): string {
  return `taomni.codeWorkspace.debugFunctionBreakpoints.v1.${workspaceInstanceId}`;
}

export function instructionBreakpointsKey(workspaceInstanceId: string): string {
  return `taomni.codeWorkspace.debugInstructionBreakpoints.v1.${workspaceInstanceId}`;
}

export function dataBreakpointsKey(workspaceInstanceId: string): string {
  return `taomni.codeWorkspace.debugDataBreakpoints.v1.${workspaceInstanceId}`;
}

export function exceptionBreakpointsKey(workspaceInstanceId: string): string {
  return `taomni.codeWorkspace.debugExceptionBreakpoints.v1.${workspaceInstanceId}`;
}

export function exceptionBreakpointRulesKey(workspaceInstanceId: string): string {
  return `taomni.codeWorkspace.debugExceptionBreakpointRules.v1.${workspaceInstanceId}`;
}


export const MAX_FUNCTION_BREAKPOINTS=256;


export const MAX_FUNCTION_BREAKPOINT_NAME_LENGTH=1024;


export const MAX_FUNCTION_BREAKPOINT_EXPRESSION_LENGTH=4096;


export const MAX_DATA_BREAKPOINTS=256;


export const MAX_DATA_BREAKPOINT_ID_LENGTH=4096;


export const MAX_DATA_BREAKPOINT_DESCRIPTION_LENGTH=1024;


export const MAX_DATA_BREAKPOINT_ADAPTER_ID_LENGTH=128;


export const MAX_DATA_BREAKPOINT_BYTES=0xffffffff;


export const MAX_INSTRUCTION_BREAKPOINTS=256;


export const MAX_INSTRUCTION_REFERENCE_LENGTH=4096;


export const MAX_INSTRUCTION_ADAPTER_ID_LENGTH=128;


export const MAX_INSTRUCTION_OFFSET=Number.MAX_SAFE_INTEGER;


export const MAX_EXCEPTION_BREAKPOINTS=512;


export const MAX_EXCEPTION_BREAKPOINT_FILTER_ID_LENGTH=1024;


export const MAX_EXCEPTION_BREAKPOINT_RULES=256;


export const MAX_EXCEPTION_BREAKPOINT_RULE_ID_LENGTH=128;


export const MAX_EXCEPTION_PATH_SEGMENTS=32;


export const MAX_EXCEPTION_PATH_NAMES=64;


export const MAX_EXCEPTION_PATH_NAME_LENGTH=1024;


export const MAX_BREAKPOINT_MODE_ID_LENGTH=1024;


export const MAX_SOURCE_BREAKPOINT_ADAPTER_MODES=64;


export let exceptionBreakpointRuleSequence=0;

export function normalizeBreakpointModeId(value: unknown): string|undefined {
  if(typeof value!=="string") return undefined;
  const mode=value.trim();
  return mode&&mode.length<=MAX_BREAKPOINT_MODE_ID_LENGTH? mode:undefined;
}

export function normalizeDataBreakpointBytes(value: unknown): number|undefined {
  if(typeof value!=="number"||!Number.isInteger(value)) return undefined;
  return value>0&&value<=MAX_DATA_BREAKPOINT_BYTES? value:undefined;
}

export function isDataBreakpointAddress(value: string): boolean {
  return /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value);
}

export function normalizeSourceBreakpointAdapterModes(value: unknown): Record<string,string>|undefined {
  if(!value||typeof value!=="object"||Array.isArray(value)) return undefined;
  const entries: Array<[string,string]>=[];
  for(const [rawAdapterId,rawMode] of Object.entries(value)) {
    const adapterId=rawAdapterId.trim();
    const mode=normalizeBreakpointModeId(rawMode);
    if(!adapterId||adapterId.length>MAX_DATA_BREAKPOINT_ADAPTER_ID_LENGTH||!mode) continue;
    entries.push([adapterId,mode]);
    if(entries.length>=MAX_SOURCE_BREAKPOINT_ADAPTER_MODES) break;
  }
  return entries.length>0? Object.fromEntries(entries):undefined;
}

export function createExceptionBreakpointRuleId(): string {
  exceptionBreakpointRuleSequence=(exceptionBreakpointRuleSequence+1)%Number.MAX_SAFE_INTEGER;
  return `${Date.now().toString(36)}-${exceptionBreakpointRuleSequence.toString(36)}`;
}

export function normalizeFunctionBreakpoint(value: unknown): DebugFunctionBreakpoint|null {
  if(!value||typeof value!=="object") return null;
  const raw=value as Record<string,unknown>;
  const name=typeof raw.name==="string"
    ? raw.name.trim().slice(0,MAX_FUNCTION_BREAKPOINT_NAME_LENGTH)
    :"";
  if(!name) return null;
  const normalizeExpression=(expression: unknown): string|undefined => {
    if(typeof expression!=="string") return undefined;
    return expression.trim().slice(0,MAX_FUNCTION_BREAKPOINT_EXPRESSION_LENGTH)||undefined;
  };
  return {
    name,
    condition: normalizeExpression(raw.condition),
    hitCondition: normalizeExpression(raw.hitCondition),
    enabled: typeof raw.enabled==="boolean"? raw.enabled:undefined,
  };
}

export function normalizeFunctionBreakpoints(values: readonly unknown[]): DebugFunctionBreakpoint[] {
  const normalized: DebugFunctionBreakpoint[]=[];
  const seen=new Set<string>();
  for(const value of values) {
    const breakpoint=normalizeFunctionBreakpoint(value);
    if(!breakpoint||seen.has(breakpoint.name)) continue;
    seen.add(breakpoint.name);
    normalized.push(breakpoint);
    if(normalized.length>=MAX_FUNCTION_BREAKPOINTS) break;
  }
  return normalized;
}

export function normalizeInstructionBreakpoint(value: unknown): DebugInstructionBreakpoint|null {
  if(!value||typeof value!=="object") return null;
  const raw=value as Record<string,unknown>;
  const adapterId=typeof raw.adapterId==="string"
    ? raw.adapterId.trim().slice(0,MAX_INSTRUCTION_ADAPTER_ID_LENGTH)
    :"";
  const instructionReference=typeof raw.instructionReference==="string"
    ? raw.instructionReference.trim().slice(0,MAX_INSTRUCTION_REFERENCE_LENGTH)
    :"";
  if(!adapterId||!instructionReference) return null;
  const offset=typeof raw.offset==="number"
    &&Number.isSafeInteger(raw.offset)
    &&Math.abs(raw.offset)<=MAX_INSTRUCTION_OFFSET
    &&raw.offset!==0
    ? raw.offset
    :undefined;
  const normalizeExpression=(expression: unknown): string|undefined => (
    typeof expression==="string"
      ? expression.trim().slice(0,MAX_FUNCTION_BREAKPOINT_EXPRESSION_LENGTH)||undefined
      :undefined
  );
  return {
    adapterId,
    instructionReference,
    offset,
    condition: normalizeExpression(raw.condition),
    hitCondition: normalizeExpression(raw.hitCondition),
    mode: normalizeBreakpointModeId(raw.mode),
    enabled: typeof raw.enabled==="boolean"? raw.enabled:undefined,
  };
}

export function normalizeInstructionBreakpoints(values: readonly unknown[]): DebugInstructionBreakpoint[] {
  const normalized: DebugInstructionBreakpoint[]=[];
  const seen=new Set<string>();
  for(const value of values) {
    const breakpoint=normalizeInstructionBreakpoint(value);
    if(!breakpoint) continue;
    const key=instructionBreakpointKey(breakpoint);
    if(seen.has(key)) continue;
    seen.add(key);
    normalized.push(breakpoint);
    if(normalized.length>=MAX_INSTRUCTION_BREAKPOINTS) break;
  }
  return normalized;
}

export function normalizeDataBreakpoint(value: unknown): DebugDataBreakpoint|null {
  if(!value||typeof value!=="object") return null;
  const raw=value as Record<string,unknown>;
  const dataId=typeof raw.dataId==="string"&&raw.dataId.length<=MAX_DATA_BREAKPOINT_ID_LENGTH
    ? raw.dataId
    :"";
  const description=typeof raw.description==="string"
    ? raw.description.trim().slice(0,MAX_DATA_BREAKPOINT_DESCRIPTION_LENGTH)
    :"";
  const adapterId=typeof raw.adapterId==="string"
    &&raw.adapterId.trim().length<=MAX_DATA_BREAKPOINT_ADAPTER_ID_LENGTH
    ? raw.adapterId.trim()
    :"";
  const canPersist=raw.canPersist===true;
  const sessionId=!canPersist
    &&typeof raw.sessionId==="string"
    &&raw.sessionId.length>0
    &&raw.sessionId.length<=MAX_DATA_BREAKPOINT_ID_LENGTH
    ? raw.sessionId
    :undefined;
  if(!dataId||!description||!adapterId||(!canPersist&&!sessionId)) return null;
  const accessTypes=Array.isArray(raw.accessTypes)
    ? Array.from(new Set(raw.accessTypes.filter((accessType): accessType is "read"|"write"|"readWrite" => (
      accessType==="read"||accessType==="write"||accessType==="readWrite"
    ))))
    :[];
  const accessType=raw.accessType==="read"||raw.accessType==="write"||raw.accessType==="readWrite"
    ? raw.accessType
    :undefined;
  const bytes=normalizeDataBreakpointBytes(raw.bytes);
  const asAddress=raw.asAddress===true? true:undefined;
  const normalizeExpression=(expression: unknown): string|undefined => (
    typeof expression==="string"
      ? expression.trim().slice(0,MAX_FUNCTION_BREAKPOINT_EXPRESSION_LENGTH)||undefined
      :undefined
  );
  return {
    dataId,
    description,
    adapterId,
    accessTypes,
    accessType: accessType&&(accessTypes.length===0||accessTypes.includes(accessType))
      ? accessType
      :defaultDataBreakpointAccessType(accessTypes),
    condition: normalizeExpression(raw.condition),
    hitCondition: normalizeExpression(raw.hitCondition),
    bytes,
    asAddress,
    mode: normalizeBreakpointModeId(raw.mode),
    enabled: typeof raw.enabled==="boolean"? raw.enabled:undefined,
    canPersist,
    sessionId,
  };
}

export function normalizeDataBreakpoints(values: readonly unknown[]): DebugDataBreakpoint[] {
  const normalized: DebugDataBreakpoint[]=[];
  const seen=new Set<string>();
  for(const value of values) {
    const breakpoint=normalizeDataBreakpoint(value);
    if(!breakpoint) continue;
    const key=dataBreakpointKey(breakpoint);
    if(seen.has(key)) continue;
    seen.add(key);
    normalized.push(breakpoint);
    if(normalized.length>=MAX_DATA_BREAKPOINTS) break;
  }
  return normalized;
}

export function normalizeExceptionBreakpoint(value: unknown): DebugExceptionBreakpoint|null {
  if(!value||typeof value!=="object") return null;
  const raw=value as Record<string,unknown>;
  const adapterId=typeof raw.adapterId==="string"
    &&raw.adapterId.trim().length<=MAX_DATA_BREAKPOINT_ADAPTER_ID_LENGTH
    ? raw.adapterId.trim()
    :"";
  const filterId=typeof raw.filterId==="string"
    &&!!raw.filterId.trim()
    &&raw.filterId.length<=MAX_EXCEPTION_BREAKPOINT_FILTER_ID_LENGTH
    ? raw.filterId
    :"";
  if(!adapterId||!filterId||typeof raw.enabled!=="boolean") return null;
  const condition=typeof raw.condition==="string"
    ? raw.condition.trim().slice(0,MAX_FUNCTION_BREAKPOINT_EXPRESSION_LENGTH)||undefined
    :undefined;
  return {
    adapterId,
    filterId,
    enabled: raw.enabled,
    condition,
    mode: normalizeBreakpointModeId(raw.mode),
  };
}

export function normalizeExceptionBreakpoints(values: readonly unknown[]): DebugExceptionBreakpoint[] {
  const normalized: DebugExceptionBreakpoint[]=[];
  const seen=new Set<string>();
  for(const value of values) {
    const breakpoint=normalizeExceptionBreakpoint(value);
    if(!breakpoint) continue;
    const key=exceptionBreakpointKey(breakpoint);
    if(seen.has(key)) continue;
    seen.add(key);
    normalized.push(breakpoint);
    if(normalized.length>=MAX_EXCEPTION_BREAKPOINTS) break;
  }
  return normalized;
}

export function normalizeExceptionPath(value: unknown): DebugExceptionPathSegment[]|null {
  if(!Array.isArray(value)) return null;
  const path: DebugExceptionPathSegment[]=[];
  for(const rawSegment of value.slice(0,MAX_EXCEPTION_PATH_SEGMENTS)) {
    if(!rawSegment||typeof rawSegment!=="object") continue;
    const raw=rawSegment as Record<string,unknown>;
    if(!Array.isArray(raw.names)) continue;
    const names=Array.from(new Set(raw.names.flatMap((name) => {
      if(typeof name!=="string") return [];
      const normalized=name.trim().slice(0,MAX_EXCEPTION_PATH_NAME_LENGTH);
      return normalized? [normalized]:[];
    }))).slice(0,MAX_EXCEPTION_PATH_NAMES);
    if(names.length===0) continue;
    path.push({ names,...(raw.negate===true? { negate: true }:{}) });
  }
  if(value.length>0&&path.length===0) return null;
  return path;
}

export function normalizeExceptionBreakpointRule(value: unknown): DebugExceptionBreakpointRule|null {
  if(!value||typeof value!=="object") return null;
  const raw=value as Record<string,unknown>;
  const id=typeof raw.id==="string"
    ? raw.id.trim().slice(0,MAX_EXCEPTION_BREAKPOINT_RULE_ID_LENGTH)
    :"";
  const adapterId=typeof raw.adapterId==="string"
    &&raw.adapterId.trim().length<=MAX_DATA_BREAKPOINT_ADAPTER_ID_LENGTH
    ? raw.adapterId.trim()
    :"";
  const path=normalizeExceptionPath(raw.path);
  const breakMode=raw.breakMode==="never"
    ||raw.breakMode==="always"
    ||raw.breakMode==="unhandled"
    ||raw.breakMode==="userUnhandled"
    ? raw.breakMode
    :null;
  if(!id||!adapterId||!path||!breakMode||typeof raw.enabled!=="boolean") return null;
  return { id,adapterId,path,breakMode,enabled: raw.enabled };
}

export function normalizeExceptionBreakpointRules(values: readonly unknown[]): DebugExceptionBreakpointRule[] {
  const normalized: DebugExceptionBreakpointRule[]=[];
  const seen=new Set<string>();
  for(const value of values) {
    const rule=normalizeExceptionBreakpointRule(value);
    if(!rule) continue;
    const key=exceptionBreakpointRuleKey(rule);
    if(seen.has(key)) continue;
    seen.add(key);
    normalized.push(rule);
    if(normalized.length>=MAX_EXCEPTION_BREAKPOINT_RULES) break;
  }
  return normalized;
}

export function readBreakpoints(workspaceInstanceId: string): BreakpointMap {
  try {
    const parsed=JSON.parse(window.localStorage.getItem(breakpointsKey(workspaceInstanceId))??"{}");
    if(!parsed||typeof parsed!=="object") return {};
    const out: BreakpointMap={};
    for(const [path,list] of Object.entries(parsed)) {
      if(!Array.isArray(list)) continue;
      out[path]=list
        .filter((bp): bp is DebugBreakpoint => !!bp&&typeof (bp as DebugBreakpoint).line==="number")
        .map((bp) => ({
          line: bp.line,
          condition: bp.condition,
          hitCondition: bp.hitCondition,
          logMessage: bp.logMessage,
          enabled: bp.enabled,
          adapterModes: normalizeSourceBreakpointAdapterModes(bp.adapterModes),
        }));
    }
    return out;
  } catch {
    return {};
  }
}

export function readWatches(workspaceInstanceId: string): string[] {
  try {
    const parsed=JSON.parse(window.localStorage.getItem(watchesKey(workspaceInstanceId))??"[]");
    return Array.isArray(parsed)? parsed.filter((x): x is string => typeof x==="string"):[];
  } catch {
    return [];
  }
}

export function readFunctionBreakpoints(workspaceInstanceId: string): DebugFunctionBreakpoint[] {
  try {
    const parsed=JSON.parse(
      window.localStorage.getItem(functionBreakpointsKey(workspaceInstanceId))??"[]",
    );
    return Array.isArray(parsed)? normalizeFunctionBreakpoints(parsed):[];
  } catch {
    return [];
  }
}

export function readInstructionBreakpoints(workspaceInstanceId: string): DebugInstructionBreakpoint[] {
  try {
    const parsed=JSON.parse(
      window.localStorage.getItem(instructionBreakpointsKey(workspaceInstanceId))??"[]",
    );
    return Array.isArray(parsed)? normalizeInstructionBreakpoints(parsed):[];
  } catch {
    return [];
  }
}

export function readDataBreakpoints(workspaceInstanceId: string): DebugDataBreakpoint[] {
  try {
    const parsed=JSON.parse(
      window.localStorage.getItem(dataBreakpointsKey(workspaceInstanceId))??"[]",
    );
    return Array.isArray(parsed)
      ? normalizeDataBreakpoints(parsed).filter((breakpoint) => breakpoint.canPersist)
      :[];
  } catch {
    return [];
  }
}

export function readExceptionBreakpoints(workspaceInstanceId: string): DebugExceptionBreakpoint[] {
  try {
    const parsed=JSON.parse(
      window.localStorage.getItem(exceptionBreakpointsKey(workspaceInstanceId))??"[]",
    );
    return Array.isArray(parsed)? normalizeExceptionBreakpoints(parsed):[];
  } catch {
    return [];
  }
}

export function readExceptionBreakpointRules(workspaceInstanceId: string): DebugExceptionBreakpointRule[] {
  try {
    const parsed=JSON.parse(
      window.localStorage.getItem(exceptionBreakpointRulesKey(workspaceInstanceId))??"[]",
    );
    return Array.isArray(parsed)? normalizeExceptionBreakpointRules(parsed):[];
  } catch {
    return [];
  }
}

export { isDebugLaunchGroup,validateDebugLaunchGroup } from "./launchPlan";

export { CLOSING_OUTPUT_DRAIN_MS,EXITED_WITHOUT_TERMINATED_MS,FRAME_PAGE_SIZE,MAX_MEMORY_REFERENCE_LENGTH,MAX_MEMORY_READ_BYTES,MAX_DISASSEMBLE_INSTRUCTIONS } from "./requestLimits";
