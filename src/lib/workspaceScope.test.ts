import { describe, expect, it } from "vitest";
import type { Tab, TabKind } from "../types";
import { tabToSurfaceDescriptor } from "./workspaceScope";

const tab = (type: TabKind, patch: Partial<Tab> = {}): Tab => ({ id: "runtime", type, title: type, closable: true, ...patch });
describe("surface identity", () => {
  it.each(["terminal", "sftp", "rdp", "vnc", "database", "redis", "hbase-shell", "mail", "object-storage", "proxy-test"] as const)("keeps %s canonical identity separate from runtime", (kind) => {
    expect(tabToSurfaceDescriptor(tab(kind, { sessionId: "saved" }))).toMatchObject({ scope: "session", sessionRef: { kind: "canonical", sessionId: "saved" } });
    expect(tabToSurfaceDescriptor(tab(kind))).toMatchObject({ scope: "session", sessionRef: { kind: "ephemeral", runtimeId: "runtime" } });
  });
  it.each(["welcome", "settings", "nettools", "sockscap", "mfa", "lan-chat", "mail-unified"] as const)("keeps %s outside any workspace", (kind) => {
    expect(tabToSurfaceDescriptor(tab(kind))).toEqual({ scope: "global", kind, surfaceId: "runtime" });
  });
  it("does not silently assign legacy Git to a selected workspace", () => {
    expect(tabToSurfaceDescriptor(tab("git", { git: { repoRoot: "/repo" } }))).toMatchObject({ scope: "unavailable", reason: "missing-workspace" });
    expect(tabToSurfaceDescriptor(tab("git", { git: { repoRoot: "/repo", sourceWorkspaceId: "durable" } }))).toMatchObject({ scope: "workspace", workspaceId: "durable", kind: "changes" });
    expect(tabToSurfaceDescriptor(tab("code-workspace", { codeWorkspace: { repoRoot: "/repo", workspaceId: "durable" } }))).toMatchObject({ scope: "workspace", kind: "files" });
  });
  it("preserves explicit scope, distinguishes file sessions, and rejects unknown kinds", () => {
    const surface = { scope: "session" as const, kind: "terminal" as const, surfaceId: "stable", sessionRef: { kind: "canonical" as const, sessionId: "saved" }, workspaceId: "a" };
    expect(tabToSurfaceDescriptor(tab("terminal", { surface }))).toEqual(surface);
    expect(tabToSurfaceDescriptor(tab("file-browser"))).toMatchObject({ scope: "global" });
    expect(tabToSurfaceDescriptor(tab("file-browser", { sessionId: "saved" }))).toMatchObject({ scope: "session" });
    expect(tabToSurfaceDescriptor(tab("placeholder"))).toMatchObject({ scope: "unavailable", reason: "unknown-kind" });
    expect(tabToSurfaceDescriptor(tab("future" as TabKind))).toMatchObject({ scope: "unavailable", kind: "future" });
  });
});
