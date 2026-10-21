import { useCallback } from "react";
import { dapSendRequest } from "../../../../lib/editor/dap";
import {
  buildDisassembleArgs,
  buildReadMemoryArgs,
  buildWriteMemoryArgs,
  parseDisassembleResponse,
  parseEvaluate,
  parseReadMemoryResponse,
  parseWriteMemoryResponse,
  type DebugDisassembleRequest,
  type DebugDisassembledInstruction,
  type DebugMemoryReadRequest,
  type DebugMemoryReadResult,
  type DebugMemoryWriteRequest,
  type DebugMemoryWriteResult,
  type DebugRequestToken,
  type DebugSessionState,
  type EvaluateResult,
} from "../dapDebugModel";
import { type DebugSessionRecord } from "./types";
import { MAX_MEMORY_REFERENCE_LENGTH,MAX_MEMORY_READ_BYTES,MAX_DISASSEMBLE_INSTRUCTIONS } from "./breakpointPersistence";
import { errorText } from "./errors";


export interface UseDebugInspectionContext {
  sessionIdRef: import("react").RefObject<string|null>;
  stateRef: import("react").RefObject<DebugSessionState|null>;
  consoleGenerationRef: import("react").RefObject<number>;
  mountedRef: import("react").MutableRefObject<boolean>;
  capabilitiesRef: import("react").RefObject<Record<string,unknown>>;
  logConsole: (category: string,text: string) => void;
  activeSessionIdRef: import("react").RefObject<string|null>;
  sessionsRef: import("react").RefObject<Map<string,DebugSessionRecord>>;
  stopEpochRef: import("react").RefObject<number>;
}

export function useDebugInspection(context: UseDebugInspectionContext) {
  const { sessionIdRef,stateRef,consoleGenerationRef,mountedRef,capabilitiesRef,logConsole,activeSessionIdRef,sessionsRef,stopEpochRef }=context;

  const evaluate=useCallback(async (expression: string,context="repl"): Promise<EvaluateResult> => {
    const id=sessionIdRef.current;
    const current=stateRef.current;
    if(!id) return { value: "",variablesReference: 0,type: null };
    const reqGen=consoleGenerationRef.current;
    const reqSessionId=id;
    const frameId=current?.selectedFrameId??current?.frames[0]?.id;
    try {
      const resp=await dapSendRequest(id,"evaluate",{ expression,frameId,context });
      if(!mountedRef.current||consoleGenerationRef.current!==reqGen||sessionIdRef.current!==reqSessionId) {
        return { value: "",variablesReference: 0,type: null };
      }
      return parseEvaluate(resp);
    } catch(error) {
      if(!mountedRef.current||consoleGenerationRef.current!==reqGen||sessionIdRef.current!==reqSessionId) {
        return { value: "",variablesReference: 0,type: null };
      }
      return {
        value: error instanceof Error? error.message:String(error),
        variablesReference: 0,
        type: null,
      };
    }
  },[]);

  const readMemory=useCallback(async (
    request: DebugMemoryReadRequest,
  ): Promise<DebugMemoryReadResult|null> => {
    const id=sessionIdRef.current;
    const memoryReference=request.memoryReference.trim().slice(0,MAX_MEMORY_REFERENCE_LENGTH);
    if(
      !id
      ||capabilitiesRef.current.supportsReadMemoryRequest!==true
      ||!memoryReference
      ||!Number.isSafeInteger(request.count)
      ||request.count<=0
      ||request.count>MAX_MEMORY_READ_BYTES
      ||(request.offset!==undefined
        &&(!Number.isSafeInteger(request.offset)||Math.abs(request.offset)>Number.MAX_SAFE_INTEGER))
    ) return null;
    const body=await dapSendRequest(id,"readMemory",buildReadMemoryArgs({
      ...request,
      memoryReference,
    })).catch((error) => {
      logConsole("stderr",`readMemory failed: ${errorText(error)}\n`);
      return null;
    });
    if(activeSessionIdRef.current!==id||!sessionsRef.current.get(id)?.live) return null;
    return body==null? null:parseReadMemoryResponse(body);
  },[logConsole]);

  const writeMemory=useCallback(async (
    request: DebugMemoryWriteRequest,
  ): Promise<DebugMemoryWriteResult|null> => {
    const id=sessionIdRef.current;
    const memoryReference=request.memoryReference.trim().slice(0,MAX_MEMORY_REFERENCE_LENGTH);
    if(
      !id
      ||capabilitiesRef.current.supportsWriteMemoryRequest!==true
      ||!memoryReference
      ||!request.data
      ||request.data.length>131072
      ||(request.offset!==undefined
        &&(!Number.isSafeInteger(request.offset)||Math.abs(request.offset)>Number.MAX_SAFE_INTEGER))
    ) return null;
    const body=await dapSendRequest(id,"writeMemory",buildWriteMemoryArgs({
      ...request,
      memoryReference,
    })).catch((error) => {
      logConsole("stderr",`writeMemory failed: ${errorText(error)}\n`);
      return null;
    });
    if(activeSessionIdRef.current!==id||!sessionsRef.current.get(id)?.live) return null;
    return body==null? null:parseWriteMemoryResponse(body);
  },[logConsole]);

  const disassemble=useCallback(async (
    request: DebugDisassembleRequest,
  ): Promise<DebugDisassembledInstruction[]> => {
    const id=sessionIdRef.current;
    const memoryReference=request.memoryReference.trim().slice(0,MAX_MEMORY_REFERENCE_LENGTH);
    const validOffset=(value: number|undefined) => value===undefined
      ||(Number.isSafeInteger(value)&&Math.abs(value)<=Number.MAX_SAFE_INTEGER);
    if(
      !id
      ||capabilitiesRef.current.supportsDisassembleRequest!==true
      ||!memoryReference
      ||!Number.isSafeInteger(request.instructionCount)
      ||request.instructionCount<=0
      ||request.instructionCount>MAX_DISASSEMBLE_INSTRUCTIONS
      ||!validOffset(request.offset)
      ||!validOffset(request.instructionOffset)
    ) return [];
    const body=await dapSendRequest(id,"disassemble",buildDisassembleArgs({
      ...request,
      memoryReference,
    })).catch((error) => {
      logConsole("stderr",`disassemble failed: ${errorText(error)}\n`);
      return null;
    });
    if(activeSessionIdRef.current!==id||!sessionsRef.current.get(id)?.live) return [];
    return body==null? []:parseDisassembleResponse(body);
  },[logConsole]);

  const hoverEvaluate=useCallback(async (expression: string): Promise<EvaluateResult|null> => {
    const id=sessionIdRef.current;
    const current=stateRef.current;
    if(!id||!expression.trim()||current?.status!=="stopped") return null;
    const reqGen=consoleGenerationRef.current;
    const reqSessionId=id;
    const frameId=current.selectedFrameId??current.frames[0]?.id;
    if(frameId==null) return null;
    // A hover over a non-expression (a keyword, a type name) legitimately fails;
    // resolve to null so the editor simply shows no tooltip.
    const body=await dapSendRequest(id,"evaluate",{ expression,frameId,context: "hover" })
      .catch(() => null);
    if(!mountedRef.current||consoleGenerationRef.current!==reqGen||sessionIdRef.current!==reqSessionId) {
      return null;
    }
    if(body==null) return null;
    const result=parseEvaluate(body);
    return result.value? result:null;
  },[]);

  const setVariable=useCallback(async (
    variablesReference: number,
    name: string,
    value: string,
  ): Promise<EvaluateResult|null> => {
    const id=sessionIdRef.current;
    if(!id) return null;
    try {
      const body=await dapSendRequest(id,"setVariable",{ variablesReference,name,value });
      const rec=body&&typeof body==="object"? (body as Record<string,unknown>):{};
      return {
        value: typeof rec.value==="string"? rec.value:"",
        variablesReference: typeof rec.variablesReference==="number"? rec.variablesReference:0,
        type: typeof rec.type==="string"? rec.type:null,
      };
    } catch(error) {
      logConsole("stderr",`Set value failed: ${error instanceof Error? error.message:String(error)}\n`);
      return null;
    }
  },[logConsole]);

  const fetchVariables=useCallback(async (variablesReference: number,token?: DebugRequestToken): Promise<unknown> => {
    const id=token?.sessionId??sessionIdRef.current;
    if(!id) return { variables: [] };
    if(token&&(token.sessionId!==sessionIdRef.current||token.stopEpoch!==stopEpochRef.current)) {
      return { variables: [] };
    }
    const res=await dapSendRequest(id,"variables",{ variablesReference }).catch(() => ({ variables: [] }));
    if(token&&(token.sessionId!==sessionIdRef.current||token.stopEpoch!==stopEpochRef.current)) {
      return { variables: [] };
    }
    return res;
  },[]);

  const fetchScopes=useCallback(async (frameId: number,token?: DebugRequestToken): Promise<unknown> => {
    const id=token?.sessionId??sessionIdRef.current;
    if(!id) return { scopes: [] };
    if(token&&(token.sessionId!==sessionIdRef.current||token.stopEpoch!==stopEpochRef.current)) {
      return { scopes: [] };
    }
    const res=await dapSendRequest(id,"scopes",{ frameId }).catch(() => ({ scopes: [] }));
    if(token&&(token.sessionId!==sessionIdRef.current||token.stopEpoch!==stopEpochRef.current)) {
      return { scopes: [] };
    }
    return res;
  },[]);

  const fetchSource=useCallback(async (sourceReference: number): Promise<string|null> => {
    const id=sessionIdRef.current;
    if(!id||sourceReference<=0) return null;
    // The spec wants both the shorthand and the full `source` object; adapters
    // differ in which they read.
    const body=await dapSendRequest(id,"source",{
      sourceReference,
      source: { sourceReference },
    }).catch(() => null);
    const content=(body as { content?: unknown; }|null)?.content;
    return typeof content==="string"&&content? content:null;
  },[]);
  return { evaluate,hoverEvaluate,readMemory,writeMemory,disassemble,setVariable,fetchVariables,fetchScopes,fetchSource };
}
