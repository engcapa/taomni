import type { CodeWorkspaceTabInfo } from "../../types";

export const TAB_LANES = ["home", "connect", "build", "communicate", "utility"] as const;
export type TabLane = typeof TAB_LANES[number];
export type BusinessLane = Exclude<TabLane, "home">;
export type NavigatorArea = "home" | "sessions" | "workspaces";
export type DockEdge = "left" | "right" | "top" | "bottom";
export type PanelKind = "sftp" | "git" | "problems" | "workspace-terminal";
export type PanelOwner =
  | { kind: "tab"; tabId: string; restoreRef?: string }
  | { kind: "workspace"; tabId: string; workspaceInstanceId: string; restoreRef?: string }
  | { kind: "background"; resourceKey: string; restoreRef?: string };
export type PanelPlacement =
  | { kind: "dock"; edge: "right" | "bottom" }
  | { kind: "primary"; tabId: string }
  | { kind: "detached"; windowLabel: string };
export interface PanelInstance {
  id: string;
  kind: PanelKind;
  owner: PanelOwner;
  generation: number;
  phase: "initializing" | "ready" | "failed" | "closing";
  requestedOpen: boolean;
  pinned: boolean;
  preferredSize?: number;
  placement: PanelPlacement;
  operation: null | { id: string; type: "promote" | "detach" | "reattach" | "close" };
  error: null | { code: string; message: string; retryable: boolean };
}
export type PanelVisibility = "visible" | "hidden" | "suppressed-by-tao" | "inactive-owner" | "detached-placeholder";
export type ShellRestoreSource =
  | { kind: "run-entry"; identity: string }
  | { kind: "workspace"; workspaceInstanceId: string; workspace: CodeWorkspaceTabInfo };
export interface PanelPreference { edge: "right" | "bottom"; size: number; pinned: boolean }
export interface PersistedShellLayoutV2 {
  version: 2;
  navigator: { width: number; collapsedByLane: Record<TabLane, boolean>; lastArea: NavigatorArea };
  panelDefaults: Record<PanelKind, PanelPreference>;
  panelOverrides: Record<string, PanelPreference>;
  tao: { edge: DockEdge; width: number; height: number; pinned: boolean; opacity: number; ribbonOffsetRatio: number };
  restoreSources: Record<string, ShellRestoreSource>;
  restoredTabs: Record<string, { laneOverride?: BusinessLane; pinned: boolean; order: number }>;
  lastActiveRestoreRef?: string;
  recentPanels: Array<{ kind: PanelKind; restoreRef: string; preferredPlacement: "dock" | "detached"; lastUsedAt: number }>;
}
export type CloseChoice = "save" | "discard" | "commit" | "rollback" | "background" | "cancel-job" | "retry" | "cancel" | "dock" | "close-instance";
interface RiskBase { id: string; ownerId: string; revision: string; detail: string }
export type CloseRisk =
  | (RiskBase & { kind: "surface"; choices: readonly ("dock" | "close-instance" | "cancel")[] })
  | (RiskBase & { kind: "dirty"; choices: readonly ("save" | "discard" | "cancel")[] })
  | (RiskBase & { kind: "transaction"; choices: readonly ("commit" | "rollback" | "cancel")[] })
  | (RiskBase & { kind: "job"; choices: readonly ("background" | "cancel-job" | "cancel")[] })
  | (RiskBase & { kind: "flush-error"; choices: readonly ("retry" | "cancel")[] });
export interface MoveTicket {
  operationId: string;
  panelId: string;
  generation: number;
  source: PanelPlacement;
  destination: PanelPlacement;
  snapshotRef?: string;
  ready: boolean;
}
export type RevealResult = { status: "revealed"; targetKey: string } | { status: "cancelled" }
  | { status: "failed"; code: "missing" | "auth" | "unavailable"; message: string };
export type ShellTarget =
  | { kind: "tab"; tabId?: string; restoreRef?: string }
  | { kind: "panel"; panelId?: string; panelKind: PanelKind; owner: PanelOwner }
  | { kind: "chat"; threadId: string; chatTabId?: string }
  | { kind: "note"; noteId: string }
  | { kind: "mail"; accountId: string; messageId?: string }
  | { kind: "transfer"; jobId: string; panelId?: string };
export interface ShellSurfaceAdapter {
  id: string;
  owner: PanelOwner;
  capabilities: { dock: boolean; promote: boolean; detach: boolean; duplicate: boolean };
  reveal(signal: AbortSignal): Promise<RevealResult>;
  getCloseRisks(): Promise<CloseRisk[]>;
  resolveCloseRisk(risk: CloseRisk, choice: CloseChoice, signal: AbortSignal): Promise<void>;
  flush(signal: AbortSignal): Promise<void>;
  prepareMove(destination: PanelPlacement, operationId: string): Promise<MoveTicket>;
  commitMove(ticket: MoveTicket): Promise<void>;
  rollbackMove(ticket: MoveTicket): Promise<void>;
  releaseView(): Promise<void>;
}
export interface PanelWindowEnvelope {
  version: 1;
  operationId: string;
  panelId: string;
  generation: number;
  windowLabel: string;
  event: "ready" | "failed" | "request-reattach" | "reattached" | "closed" | "commit" | "cancel" | "request-focus";
  errorCode?: string;
  snapshotRef?: string;
}
