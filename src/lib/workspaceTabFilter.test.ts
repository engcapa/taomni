import { describe, expect, it } from "vitest";
import type { WorkspaceIsolatedTab } from "../stores/workspacePlatformStore";
import { EMPTY_WORKSPACE_TAB_FILTER, filterWorkspaceTabs, workspaceTabCategory } from "./workspaceTabFilter";

function tab(kind: WorkspaceIsolatedTab["kind"], extra: Partial<WorkspaceIsolatedTab> = {}): WorkspaceIsolatedTab {
  return { id: kind, workspaceId: "one", kind, title: kind, closable: true, createdAt: 1, ...extra };
}

describe("workspace tab navigation filtering", () => {
  it("classifies files, code, saved and local sessions without consulting a runtime", () => {
    const cases = [
      [tab("file"), "files"], [tab("code"), "files"], [tab("git"), "other"],
      [tab("terminal"), "local"], [tab("terminal", { sessionId: "saved", protocol: "SSH" }), "ssh"],
      [tab("terminal", { sessionId: "saved", sessionType: "LocalShell" }), "local"],
      [tab("terminal", { sessionId: "saved", protocol: "Serial" }), "other"],
      [tab("sftp"), "sftp"], [tab("database"), "database"], [tab("rdp"), "remote"], [tab("vnc"), "remote"],
    ] as const;
    for (const [entry, category] of cases) expect(workspaceTabCategory(entry)).toBe(category);
  });

  it("combines category and case-insensitive title, path, host, user and protocol search", () => {
    const file = tab("file", { title: "Notes", filePath: "Docs/Architecture.md" });
    const ssh = tab("terminal", { title: "Production", sessionId: "saved", protocol: "SSH", host: "node.example", username: "ops" });
    const local = tab("terminal", { id: "local", title: "node local" });
    const entries = [file, ssh, local];
    expect(filterWorkspaceTabs(entries, EMPTY_WORKSPACE_TAB_FILTER)).toEqual(entries);
    expect(filterWorkspaceTabs(entries, { category: "files", query: "  ARCHITECTURE  " })).toEqual([file]);
    for (const query of ["production", "EXAMPLE", "ops", "ssh"]) {
      expect(filterWorkspaceTabs(entries, { category: "ssh", query })).toEqual([ssh]);
    }
    expect(filterWorkspaceTabs(entries, { category: "ssh", query: "node" })).toEqual([ssh]);
    expect(filterWorkspaceTabs(entries, { category: "files", query: "node" })).toEqual([]);
    expect(entries).toHaveLength(3);
  });
});
