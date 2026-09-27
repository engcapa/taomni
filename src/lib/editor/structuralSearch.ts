import { invoke } from "@tauri-apps/api/core";
import type { StructuralQuery } from "../../components/editor/workspace/companionCapabilities";

/**
 * Structural Search IPC (ED-PARITY-009). The native backend parses Java with
 * tree-sitter and matches templates by AST shape; every response is typed so
 * callers can distinguish "no matches" from "backend unavailable" or "invalid
 * template" without inspecting message text.
 */

export interface StructuralSearchRoot {
  id: string;
  name: string;
  path: string;
}

export interface StructuralSearchRequest {
  requestId: string;
  query: StructuralQuery;
  roots: StructuralSearchRoot[];
  activeFile: { rootId: string; path: string } | null;
}

export interface StructuralPosition {
  /** Zero-based line. */
  line: number;
  /** Zero-based UTF-16 column. */
  character: number;
}

export interface StructuralCapture {
  name: string;
  text: string;
  start: StructuralPosition;
  end: StructuralPosition;
}

export interface StructuralContainer {
  kind: "class" | "interface" | "enum" | "record" | "method" | "constructor";
  name: string;
}

export interface StructuralMatch {
  rootId: string;
  rootName: string;
  path: string;
  start: StructuralPosition;
  end: StructuralPosition;
  startByte: number;
  endByte: number;
  lineText: string;
  matchedText: string;
  captures: StructuralCapture[];
  containers: StructuralContainer[];
}

export interface StructuralBackendInfo {
  id: string;
  parser: string;
  grammar: string;
}

export interface StructuralSearchStats {
  filesScanned: number;
  filesWithParseErrors: number;
  elapsedMs: number;
}

export type StructuralUnavailableReason = "unsupported-language" | "backend-missing";
export type StructuralErrorCode =
  | "invalid-pattern"
  | "unsupported-constraint"
  | "invalid-scope"
  | "invalid-request";

export type StructuralSearchResponse =
  | {
    status: "ok";
    requestId: string;
    backend: StructuralBackendInfo;
    matches: StructuralMatch[];
    truncated: boolean;
    stats: StructuralSearchStats;
  }
  | { status: "unavailable"; requestId: string; reason: StructuralUnavailableReason; message: string }
  | { status: "error"; requestId: string; code: StructuralErrorCode; message: string }
  | { status: "cancelled"; requestId: string; stats: StructuralSearchStats };

export interface StructuralSearchCapabilities {
  available: boolean;
  backend: StructuralBackendInfo;
  languages: string[];
  scopes: string[];
  activeRequests: number;
}

export function structuralSearchCapabilities(): Promise<StructuralSearchCapabilities> {
  return invoke<StructuralSearchCapabilities>("structural_search_capabilities");
}

export function structuralSearchRun(request: StructuralSearchRequest): Promise<StructuralSearchResponse> {
  return invoke<StructuralSearchResponse>("structural_search_run", { request });
}

export function structuralSearchCancel(requestId: string): Promise<boolean> {
  return invoke<boolean>("structural_search_cancel", { requestId });
}

/** `$name$` placeholders in first-appearance order, mirroring the backend scanner. */
export function structuralTemplateVariables(pattern: string): string[] {
  const names: string[] = [];
  for (const match of pattern.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)\$/g)) {
    const name = match[1]!;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

let requestCounter = 0;

export function nextStructuralRequestId(): string {
  requestCounter += 1;
  return `ssr-${Date.now().toString(36)}-${requestCounter}`;
}
