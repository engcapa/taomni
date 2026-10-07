import type { Tab } from "../types";
import type { SurfaceDescriptor } from "../types/workspace";

/** Resolve identity from explicit bindings only; never infer membership from selection. */
export function tabToSurfaceDescriptor(tab: Tab): SurfaceDescriptor {
  if (tab.surface) return tab.surface;
  const surfaceId = tab.id;
  const workspaceId = tab.codeWorkspace?.workspaceId ?? tab.git?.sourceWorkspaceId;
  switch (tab.type) {
    case "terminal": case "sftp": case "rdp": case "vnc": case "database":
    case "redis": case "hbase-shell": case "mail": case "object-storage": case "proxy-test":
      return { scope: "session", kind: tab.type, surfaceId, sessionRef: tab.sessionId
        ? { kind: "canonical", sessionId: tab.sessionId }
        : { kind: "ephemeral", runtimeId: tab.sftp?.sessionId ?? tab.id } };
    case "git": case "code-workspace":
      return workspaceId
        ? { scope: "workspace", kind: tab.type === "git" ? "changes" : "files", surfaceId, workspaceId }
        : { scope: "unavailable", kind: tab.type, surfaceId, reason: "missing-workspace" };
    case "file-browser":
      return tab.sessionId
        ? { scope: "session", kind: tab.type, surfaceId, sessionRef: { kind: "canonical", sessionId: tab.sessionId } }
        : { scope: "global", kind: tab.type, surfaceId };
    case "welcome": case "settings": case "nettools": case "sockscap": case "mfa": case "lan-chat": case "mail-unified":
      return { scope: "global", kind: tab.type, surfaceId };
    default:
      return { scope: "unavailable", kind: tab.type, surfaceId, reason: "unknown-kind" };
  }
}
