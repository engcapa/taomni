import {
  type DebugMemoryReadRequest,
  type DebugMemoryReadResult,
  type DebugMemoryWriteRequest,
  type DebugMemoryWriteResult,
  type DebugDisassembleRequest,
  type DebugDisassembledInstruction,
} from "./types";
import { asRecord } from "./shared";

export const MAX_MEMORY_REFERENCE_LENGTH = 4096;

export const MAX_MEMORY_READ_BYTES = 65536;

export const MAX_DISASSEMBLY_INSTRUCTIONS = 4096;

export const MAX_MEMORY_DATA_LENGTH = 131072;

/** Build a standard DAP `readMemory` request. */
export function buildReadMemoryArgs(request: DebugMemoryReadRequest) {
  const args: {
    memoryReference: string;
    offset?: number;
    count: number;
  } = {
    memoryReference: request.memoryReference.trim().slice(0, MAX_MEMORY_REFERENCE_LENGTH),
    count: request.count,
  };
  if (request.offset !== undefined) args.offset = request.offset;
  return args;
}

/** Parse a DAP `readMemory` response without trusting adapter field types. */
export function parseReadMemoryResponse(body: unknown): DebugMemoryReadResult {
  const rec = asRecord(body);
  const unreadableBytes = typeof rec.unreadableBytes === "number"
    && Number.isSafeInteger(rec.unreadableBytes)
    && rec.unreadableBytes >= 0
    ? Math.min(rec.unreadableBytes, MAX_MEMORY_READ_BYTES)
    : 0;
  return {
    address: typeof rec.address === "string" && rec.address
      ? rec.address.slice(0, MAX_MEMORY_REFERENCE_LENGTH)
      : null,
    unreadableBytes,
    data: typeof rec.data === "string" ? rec.data.slice(0, MAX_MEMORY_DATA_LENGTH) : "",
  };
}

/** Build a standard DAP `writeMemory` request. */
export function buildWriteMemoryArgs(request: DebugMemoryWriteRequest) {
  const args: {
    memoryReference: string;
    offset?: number;
    data: string;
    allowPartial?: boolean;
  } = {
    memoryReference: request.memoryReference.trim().slice(0, MAX_MEMORY_REFERENCE_LENGTH),
    data: request.data.slice(0, MAX_MEMORY_DATA_LENGTH),
  };
  if (request.offset !== undefined) args.offset = request.offset;
  if (request.allowPartial !== undefined) args.allowPartial = request.allowPartial;
  return args;
}

/** Parse a DAP `writeMemory` response. */
export function parseWriteMemoryResponse(body: unknown): DebugMemoryWriteResult {
  const bytesWritten = asRecord(body).bytesWritten;
  return {
    bytesWritten: typeof bytesWritten === "number"
      && Number.isSafeInteger(bytesWritten)
      && bytesWritten >= 0
      ? Math.min(bytesWritten, MAX_MEMORY_READ_BYTES)
      : null,
  };
}

/** Build a standard DAP `disassemble` request. */
export function buildDisassembleArgs(request: DebugDisassembleRequest) {
  const args: {
    memoryReference: string;
    offset?: number;
    instructionOffset?: number;
    instructionCount: number;
    resolveSymbols?: boolean;
  } = {
    memoryReference: request.memoryReference.trim().slice(0, MAX_MEMORY_REFERENCE_LENGTH),
    instructionCount: request.instructionCount,
  };
  if (request.offset !== undefined) args.offset = request.offset;
  if (request.instructionOffset !== undefined) args.instructionOffset = request.instructionOffset;
  if (request.resolveSymbols !== undefined) args.resolveSymbols = request.resolveSymbols;
  return args;
}

/** Parse and bound a DAP `disassemble` response. */
export function parseDisassembleResponse(body: unknown): DebugDisassembledInstruction[] {
  const instructions = asRecord(body).instructions;
  if (!Array.isArray(instructions)) return [];
  return instructions.slice(0, MAX_DISASSEMBLY_INSTRUCTIONS).flatMap((value) => {
    const rec = asRecord(value);
    if (typeof rec.address !== "string" || !rec.address.trim()) return [];
    const source = asRecord(rec.location);
    const location = Object.keys(source).length > 0
      ? {
        path: typeof source.path === "string" && source.path ? source.path.slice(0, MAX_MEMORY_REFERENCE_LENGTH) : null,
        name: typeof source.name === "string" && source.name ? source.name.slice(0, MAX_MEMORY_REFERENCE_LENGTH) : null,
        sourceReference: typeof source.sourceReference === "number"
          && Number.isSafeInteger(source.sourceReference)
          && source.sourceReference > 0
          ? source.sourceReference
          : null,
      }
      : null;
    return [{
      address: rec.address.slice(0, MAX_MEMORY_REFERENCE_LENGTH),
      instruction: typeof rec.instruction === "string" ? rec.instruction.slice(0, MAX_MEMORY_REFERENCE_LENGTH) : "",
      instructionBytes: typeof rec.instructionBytes === "string" ? rec.instructionBytes.slice(0, MAX_MEMORY_REFERENCE_LENGTH) : null,
      symbol: typeof rec.symbol === "string" && rec.symbol ? rec.symbol.slice(0, MAX_MEMORY_REFERENCE_LENGTH) : null,
      location,
      line: typeof rec.line === "number" && rec.line > 0 ? rec.line : null,
      column: typeof rec.column === "number" && rec.column > 0 ? rec.column : null,
      endLine: typeof rec.endLine === "number" && rec.endLine > 0 ? rec.endLine : null,
      endColumn: typeof rec.endColumn === "number" && rec.endColumn > 0 ? rec.endColumn : null,
    }];
  });
}

/** Decode DAP base64 memory into a compact, readable hexadecimal string. */
export function decodeMemoryData(data: string): string {
  if (!data) return "";
  try {
    const binary = globalThis.atob(data);
    return Array.from(binary, (character) => character.charCodeAt(0).toString(16).padStart(2, "0")).join(" ");
  } catch {
    return "";
  }
}

/** Encode user-entered hexadecimal bytes into DAP base64. Returns null on invalid input. */
export function encodeMemoryData(value: string): string | null {
  const source = value.trim();
  if (!source) return null;
  const tokens = source.split(/[\s,]+/).filter(Boolean);
  const compact = tokens.length === 1 ? tokens[0].replace(/^0x/i, "") : "";
  const bytes = compact && /^(?:[0-9a-f]{2})+$/i.test(compact)
    ? compact.match(/[0-9a-f]{2}/gi) ?? []
    : tokens.map((token) => token.replace(/^0x/i, ""));
  if (bytes.some((token) => !/^(?:[0-9a-f]{2})$/i.test(token))) return null;
  if (bytes.length === 0 || bytes.length > MAX_MEMORY_READ_BYTES) return null;
  const binary = bytes.map((token) => String.fromCharCode(Number.parseInt(token, 16))).join("");
  try {
    return globalThis.btoa(binary);
  } catch {
    return null;
  }
}
