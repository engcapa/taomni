import { invoke } from "@tauri-apps/api/core";

export interface GlobalFileMatch {
  path: string;
  name: string;
  isDirectory: boolean;
}

export interface GlobalFileResults {
  entries: GlobalFileMatch[];
  provider: "plocate" | "spotlight" | "windowsSearch" | "boundedScan";
  truncated: boolean;
  scannedRoots: string[];
}

export function validFileQuery(query: string): boolean {
  const length = Array.from(query.trim()).length;
  return length >= 2 && length <= 96;
}

export function searchGlobalFiles(query: string, operationId: string, contextRoot?: string): Promise<GlobalFileResults> {
  return invoke("explorer_global_file_search", { query: query.trim(), operationId, contextRoot: contextRoot || null });
}
