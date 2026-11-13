import { invoke } from "@tauri-apps/api/core";
import type { FileKind } from "./openFile/classifyFile";

export const VIEWER_TEXT_EDIT_LIMIT = 5 * 1024 * 1024;
export const VIEWER_TEXT_HARD_LIMIT = 20 * 1024 * 1024;
export const VIEWER_TEXT_CHUNK_SIZE = 256 * 1024;
export const VIEWER_IMAGE_LIMIT = 32 * 1024 * 1024;
export type ViewerEol = "LF" | "CRLF" | "CR" | "mixed";

export interface ViewerStat {
  path: string;
  size: number;
  mtime: number;
  mime: string;
  isFile: boolean;
}

export interface ViewerTextData {
  path: string;
  content: string;
  hash: string;
  encoding: string;
  bom: boolean;
  eol: ViewerEol;
  mtime: number;
  size: number;
  truncated: boolean;
  nextOffset?: number;
}

export interface ViewerDocument {
  key: string;
  path: string;
  kind: FileKind;
  content: string;
  savedContent: string;
  savedHash: string;
  encoding: string;
  bom: boolean;
  eol: ViewerEol;
  savedEncoding: string;
  savedBom: boolean;
  savedEol: ViewerEol;
  originalLineEndings: string[];
  dirty: boolean;
  mtime: number;
  size: number;
  readOnly: boolean;
  readOnlyReason?: string;
  loading: boolean;
  saving: boolean;
  error?: string;
  external?: ViewerTextData;
  large: boolean;
  truncated: boolean;
  revision: number;
  chunkOffset: number;
  nextOffset: number;
  eof: boolean;
  restored?: boolean;
}

export interface ViewerBytes { bytes: number[]; mime: string; size: number }
export interface ViewerWriteAck { hash: string; size: number; mtime: number }
export interface ViewerTextChunk { content: string; nextOffset: number; eof: boolean }
export interface ViewerTemp { path: string; token: string }

export function viewerStat(path: string): Promise<ViewerStat> {
  return invoke("viewer_stat", { path });
}
export function viewerReadText(path: string, maxBytes = VIEWER_TEXT_EDIT_LIMIT, encoding?: string): Promise<ViewerTextData> {
  return invoke("viewer_read_text", { path, maxBytes, encoding });
}
export function viewerReadBytes(path: string, maxBytes = VIEWER_IMAGE_LIMIT): Promise<ViewerBytes> {
  return invoke("viewer_read_bytes", { path, maxBytes });
}
export function viewerReadTextChunk(path: string, offset: number, encoding?: string): Promise<ViewerTextChunk> {
  return invoke("viewer_read_text_chunk", { path, offset, maxBytes: VIEWER_TEXT_CHUNK_SIZE, encoding });
}
export function viewerWriteText(options: { path: string; content: string; encoding: string; bom: boolean; eol: ViewerEol; expectedHash: string }): Promise<ViewerWriteAck> {
  return invoke("viewer_write_text", options);
}
export function viewerSavePastedImage(options: { docPath: string; dir: string; fileName: string; bytes: number[] }): Promise<{ path: string; relativePath: string }> {
  return invoke("viewer_save_pasted_image", options);
}
export interface ViewerHtmlNetworkOptions {
  proxyMode: "app" | "custom" | "none";
  customProxy?: import("./ipc/proxy").AppProxyConfig;
}
export function viewerHtmlOpen(path: string, allowNetwork: boolean, allowScripts = true, network?: ViewerHtmlNetworkOptions): Promise<{ url: string; token: string }> {
  return invoke("viewer_html_open", { path, allowNetwork, allowScripts, proxyMode: network?.proxyMode ?? "app", customProxy: network?.customProxy });
}
export function viewerHtmlClose(token: string): Promise<void> {
  return invoke("viewer_html_close", { token });
}
export function viewerCreateTemp(fileName: string, bytes: number[]): Promise<ViewerTemp> {
  return invoke("viewer_create_temp", { fileName, bytes });
}
export function viewerReleaseTemp(path: string): Promise<void> {
  return invoke("viewer_release_temp", { path });
}

export function normalizeViewerText(text: string): string {
  return text.replace(/\r\n?|\n/g, "\n");
}
export function viewerTextForDisk(document: Pick<ViewerDocument, "content" | "eol" | "originalLineEndings">): string {
  if (document.eol !== "mixed") return document.content;
  let line = 0;
  const fallback = document.originalLineEndings[0] ?? "\n";
  return document.content.replace(/\n/g, () => document.originalLineEndings[line++] ?? fallback);
}
