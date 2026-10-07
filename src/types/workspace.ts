import type { CodeWorkspaceLooseFileInfo, CodeWorkspaceRootInfo } from "./index";

export type WorkspaceView = "overview" | "files" | "terminal" | "preview" | "tao" | "changes" | "mail";
export type SessionSurfaceKind = "terminal" | "sftp" | "rdp" | "vnc" | "database" | "redis" | "hbase-shell" | "mail" | "object-storage" | "proxy-test" | "file-browser";
export type GlobalSurfaceKind = "welcome" | "settings" | "nettools" | "sockscap" | "mfa" | "lan-chat" | "mail-unified" | "file-browser";
export type SessionRef = { kind: "canonical"; sessionId: string } | { kind: "ephemeral"; runtimeId: string };
export type SurfaceDescriptor =
  | { scope: "global"; kind: GlobalSurfaceKind; surfaceId: string; contextWorkspaceId?: string; contextSessionId?: string }
  | { scope: "workspace"; kind: WorkspaceView; surfaceId: string; workspaceId: string }
  | { scope: "session"; kind: SessionSurfaceKind; surfaceId: string; sessionRef: SessionRef; workspaceId?: string }
  | { scope: "unavailable"; kind: string; surfaceId: string; workspaceId?: string; sessionId?: string; reason: "missing-workspace" | "missing-session" | "unknown-kind" | "migration-error" };

export interface WorkspaceMembership {
  workspaceId: string;
  sessionId: string;
  role: "primary" | "attached" | "reference";
  order: number;
  pinned: boolean;
  defaultSurface?: SessionSurfaceKind;
}

/** Durable metadata only. Connection settings and secrets belong to Sessions. */
export interface Workspace {
  id: string;
  name: string;
  description: string;
  roots: CodeWorkspaceRootInfo[];
  looseFiles: CodeWorkspaceLooseFileInfo[];
  legacyRecentId?: string;
  pinned: boolean;
  order: number;
  revision: number;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
  navigation: { activeSurface: WorkspaceView; navigatorCollapsed: boolean; rightPaneOpen: boolean };
  memberships: WorkspaceMembership[];
}
