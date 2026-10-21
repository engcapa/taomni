import { type ClipboardCapabilities, type ClipboardTextReadResult } from "../../../../lib/clipboard";
import type { ClipboardSourceEol } from "../workspaceEditorCommands";
import { WorkspaceClipboardStore } from "./store";

/**
 * Workspace-scoped clipboard session (§8.17.6 N9.3/N14.4, upgraded §8.18.4 P0-C3).
 *
 * One single-slot session per workspace instance: copy/cut in ANY split view
 * writes it and paste in ANY split view reads it, so rectangular/multi-caret
 * payloads survive crossing editor leaves. The store is refcounted — every
 * editor host acquires a handle on mount and releases on unmount; when the
 * count reaches zero the payload is cleared immediately so closed workspaces
 * never leak clipboard state.
 */
export interface EditorClipboardSession {
  sessionId: string;
  /** View that produced the payload (informational; never used for routing). */
  sourceViewId: string | null;
  segments: string[] | null;
  rectangular: boolean;
  plainText: string;
  sourceEol: ClipboardSourceEol;
  createdAt: number;
  /**
   * True when the system clipboard write/read failed but the workspace
   * session still holds the full payload — surfaces stay "unavailable"
   * instead of silently degrading to plain full text.
   */
  systemClipboardUnavailable?: boolean;
  /**
   * §8.19.5: producers mark secret-like payloads (vault material, masked
   * fields); sensitive payloads fill the live slot but NEVER enter history.
   */
  sensitive?: boolean;
}

/** Why a written payload did not enter the history ring (§8.19.5). */
export type ClipboardHistoryExclusion =
  | "recorded"
  | "history-disabled"
  | "oversized-item"
  | "sensitive";

/** Why the session/history was cleared (typed for diagnostics). */
export type ClipboardClearReason = "workspace-close" | "user" | "privacy-policy";

/**
 * Paste plan produced before any dispatch (§8.18.4): selections, segments and
 * target facts are frozen so the single ChangeSet dispatch is deterministic
 * and one undo restores everything.
 */
export interface PastePlan {
  /** One entry per caret; `null` falls back to whole-text insert. */
  readonly perCaret: readonly (string | null)[];
  readonly rectangular: boolean;
  readonly sourceEol: ClipboardSourceEol;
  /** True when segments could not be mapped 1:1 and the documented fallback applies. */
  readonly degraded: false | "fewer-segments-cycled" | "extra-segments-dropped" | "whole-block";
}

export interface HistoryEntry {
  session: EditorClipboardSession;
  bytes: number;
}

export interface ClipboardConsumerLease {
  (): "detached" | "already-detached";
  readonly token: string;
  readonly consumerId: string;
  readonly kind: string;
  detach(): "detached" | "already-detached";
}

export type ClipboardPermissionState = "unknown" | "granted" | "denied";

export interface ClipboardPermissionAdapter {
  queryPermission(): Promise<ClipboardPermissionState>;
  subscribe?(listener: (permission: ClipboardPermissionState) => void): () => void;
}

export interface GuardedClipboardIO {
  writeText?: (text: string) => Promise<void>;
  readTextResult?: () => Promise<ClipboardTextReadResult>;
}

export type GuardedSystemEffect = "not-performed" | "performed" | "unknown";

export type GuardedSystemWriteResult =
  | { outcome: "success"; systemEffect: "performed"; }
  | { outcome: "denied"; systemEffect: "not-performed" | "performed"; }
  | { outcome: "stale-generation"; baseGeneration: number; currentGeneration: number; systemEffect: "performed" | "unknown"; }
  | { outcome: "unavailable" | "error"; error?: string; systemEffect: "unknown"; };

export type GuardedSystemReadResult =
  | { outcome: "success"; text: string; systemEffect: "performed"; }
  | { outcome: "denied"; systemEffect: "not-performed" | "performed"; fallbackSession: EditorClipboardSession | null; }
  | { outcome: "stale-generation"; baseGeneration: number; currentGeneration: number; systemEffect: "performed" | "unknown"; fallbackSession: EditorClipboardSession | null; }
  | { outcome: "unavailable" | "error"; error?: string; systemEffect: "unknown"; fallbackSession: EditorClipboardSession | null; };

export interface NativeClipboardPermissionAdapterOptions {
  isRuntime?: () => boolean;
  probeCapabilities?: () => Promise<ClipboardCapabilities | null>;
}

export interface WorkspaceClipboardSnapshotV3 {
  readonly payloadRevision: number;
  readonly historyRevision: number;
  readonly policyRevision: number;
  readonly permissionGeneration: number;
  readonly lifecycleRevision: number;
  readonly permission: ClipboardPermissionState;
  readonly consumers: readonly { token: string; id: string; kind: string; }[];
  /** Backwards-compatibility alias for payloadRevision */
  readonly revision: number;
  readonly history: readonly EditorClipboardSession[];
  readonly exclusion: ClipboardHistoryExclusion;
  readonly isHistoryEnabled: boolean;
  readonly limits: { maxItems: number; maxTotalBytes: number; };
  readonly consumerCount: number;
}

export type WorkspaceClipboardSnapshot = WorkspaceClipboardSnapshotV3;

export interface WorkspaceClipboardHandle {
  readonly workspaceId: string;
  attachConsumer(consumerId?: string, kind?: string): ClipboardConsumerLease;
  getSnapshot(): WorkspaceClipboardSnapshotV3;
  subscribe(listener: (snapshot: WorkspaceClipboardSnapshotV3) => void): () => void;
  write(input: Parameters<WorkspaceClipboardStore["write"]>[0]): EditorClipboardSession;
  read(): EditorClipboardSession | null;
  clear(reason?: ClipboardClearReason): void;
  release(): void;
  historyEntries(): readonly EditorClipboardSession[];
  pasteFromHistory(index: number): EditorClipboardSession | null;
  removeHistoryEntry(index: number): boolean;
  clearHistory(): void;
  setHistoryEnabled(enabled: boolean): void;
  isHistoryEnabled(): boolean;
  setHistoryLimits(maxItems: number, maxTotalBytes: number): void;
  historyLimits(): { maxItems: number; maxTotalBytes: number; };
  historyExclusion(): ClipboardHistoryExclusion;
  setPermission(permission: ClipboardPermissionState): void;
  permission(): ClipboardPermissionState;
  attachPermissionAdapter(adapter: ClipboardPermissionAdapter): () => void;
  syncPermission(adapter?: ClipboardPermissionAdapter): Promise<ClipboardPermissionState>;
  writeSystemClipboard(text: string, io?: GuardedClipboardIO): Promise<GuardedSystemWriteResult>;
  readSystemClipboard(io?: GuardedClipboardIO): Promise<GuardedSystemReadResult>;
}

export interface WorkspaceSlotState {
  store: WorkspaceClipboardStore;
  payloadRevision: number;
  historyRevision: number;
  policyRevision: number;
  permissionGeneration: number;
  lifecycleRevision: number;
  permission: "unknown" | "granted" | "denied";
  consumers: Map<string, { token: string; id: string; kind: string; }>;
  listeners: Set<(snapshot: WorkspaceClipboardSnapshotV3) => void>;
  rootAcquisitions: number;
  leaseSeq: number;
  cachedSnapshot: WorkspaceClipboardSnapshotV3 | null;
  cachedRevision: string;
}
