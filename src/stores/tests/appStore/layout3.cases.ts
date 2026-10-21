import { beforeEach, describe, expect, it } from "vitest";
import type { RecentWorkspace, Tab } from "../../../types";
import { recentWorkspaceIdFromParts, useAppStore, type CodeWorkspaceContext } from "../../appStore";
import { tab } from "./harness";

export function registerappStoreLayout3Cases() {

  describe("appStore.recentWorkspaces", () => {
    beforeEach(() => {
      window.localStorage.clear();
      useAppStore.setState({
        tabs: [{ id: "welcome", type: "welcome", title: "Welcome", closable: false }],
        activeTabId: "welcome",
        codeWorkspaceByTab: {},
        recentWorkspaces: [],
        recentWorkspaceIdByWorkspaceInstance: {},
        welcomeRecentSessionLimit: 20,
      });
    });

    const workspaceContext = (
      roots: Array<{ id: string; name: string; path: string; kind: "git" | "folder"; }>,
    ): CodeWorkspaceContext => ({
      repoRoot: roots[0]?.path ?? "",
      activePath: null,
      openPaths: [],
      dirtyPaths: [],
      roots,
      looseFiles: [],
      activeFile: null,
      openFiles: [],
      dirtyFiles: [],
      lsp: null,
    });

    const codeWorkspaceTab = (
      id: string,
      roots: Array<{ id: string; name: string; path: string; kind: "git" | "folder"; }>,
      workspaceInstanceId: string,
    ): Tab => tab(id, {
      type: "code-workspace",
      title: `Code · ${roots[0]?.name ?? "Workspace"}`,
      codeWorkspace: {
        repoRoot: roots[0]?.path ?? "",
        workspaceId: recentWorkspaceIdFromParts(roots, []),
        workspaceInstanceId,
        name: roots[0]?.name ?? "Workspace",
        roots,
        looseFiles: [],
        initialFile: null,
      },
    });

    const recentWorkspace = (
      roots: Array<{ id: string; name: string; path: string; kind: "git" | "folder"; }>,
      lastOpenedAt: number,
    ): RecentWorkspace => ({
      id: recentWorkspaceIdFromParts(roots, []),
      name: roots[0]?.name ?? "Workspace",
      roots,
      looseFiles: [],
      lastOpenedAt,
      lastActiveFile: null,
      isGitRepo: roots.some((root) => root.kind === "git"),
    });

    it("records a code workspace tab from the latest workspace context", () => {
      const root = {
        id: "root-main",
        name: "taomni",
        path: "/work/taomni",
        kind: "git" as const,
      };
      useAppStore.setState({
        tabs: [
          { id: "welcome", type: "welcome", title: "Welcome", closable: false },
          tab("code", {
            type: "code-workspace",
            title: "Code · taomni",
            codeWorkspace: {
              repoRoot: "/work/taomni",
              workspaceId: "workspace-taomni",
              name: "taomni",
              roots: [root],
              looseFiles: [],
              initialFile: null,
            },
          }),
        ],
        codeWorkspaceByTab: {
          code: {
            repoRoot: "/work/taomni",
            activePath: "src/App.tsx",
            openPaths: ["src/App.tsx"],
            dirtyPaths: [],
            roots: [root],
            looseFiles: [],
            activeFile: { kind: "root", rootId: "root-main", path: "src/App.tsx" },
            openFiles: [{ kind: "root", rootId: "root-main", path: "src/App.tsx" }],
            dirtyFiles: [],
            lsp: null,
          },
        },
      });

      useAppStore.getState().recordCodeWorkspaceTab("code");

      const recent = useAppStore.getState().recentWorkspaces;
      expect(recent).toHaveLength(1);
      expect(recent[0]).toMatchObject({
        name: "taomni",
        roots: [root],
        isGitRepo: true,
        lastActiveFile: { kind: "root", rootId: "root-main", path: "src/App.tsx" },
      });
      expect(JSON.parse(window.localStorage.getItem("taomni.recentWorkspaces.v1") ?? "[]")).toHaveLength(1);
    });

    it("builds recent workspace ids from the path definition, not runtime root ids", () => {
      const singleA = [{ id: "root-a", name: "repo", path: "/repo/app", kind: "git" as const }];
      const singleB = [{ id: "root-b", name: "repo", path: "/repo/app", kind: "git" as const }];
      const multi = [
        { id: "root-a", name: "repo", path: "/repo/app", kind: "git" as const },
        { id: "root-c", name: "data", path: "/data/repo2", kind: "folder" as const },
      ];

      expect(recentWorkspaceIdFromParts(singleA, [])).toBe(recentWorkspaceIdFromParts(singleB, []));
      expect(recentWorkspaceIdFromParts(singleA, [])).not.toBe(recentWorkspaceIdFromParts(multi, []));
    });

    it("replaces earlier recent definitions when the same workspace instance changes roots", () => {
      const roots3 = [
        { id: "root-1", name: "kiro.rs", path: "/repo/kiro.rs", kind: "git" as const },
        { id: "root-2", name: "api", path: "/repo/api", kind: "folder" as const },
        { id: "root-3", name: "web", path: "/repo/web", kind: "folder" as const },
      ];
      const roots4 = [...roots3, { id: "root-4", name: "docs", path: "/repo/docs", kind: "folder" as const }];
      const roots5 = [...roots4, { id: "root-5", name: "tools", path: "/repo/tools", kind: "folder" as const }];
      useAppStore.setState({
        tabs: [
          { id: "welcome", type: "welcome", title: "Welcome", closable: false },
          codeWorkspaceTab("code", roots3, "workspace-instance-a"),
        ],
        recentWorkspaces: [
          recentWorkspace(roots4, 4),
          recentWorkspace(roots3, 3),
        ],
        recentWorkspaceIdByWorkspaceInstance: {
          "workspace-instance-a": recentWorkspaceIdFromParts(roots3, []),
        },
      });

      useAppStore.getState().setTabCodeWorkspaceContext("code", workspaceContext(roots5));

      const recent = useAppStore.getState().recentWorkspaces;
      expect(recent).toHaveLength(1);
      expect(recent[0].id).toBe(recentWorkspaceIdFromParts(roots5, []));
      expect(recent[0].roots.map((root) => root.name)).toEqual(["kiro.rs", "api", "web", "docs", "tools"]);
      expect(JSON.parse(window.localStorage.getItem("taomni.recentWorkspaces.v1") ?? "[]")).toHaveLength(1);
    });

    it("keeps an old recent definition when another workspace instance still uses it", () => {
      const roots1 = [
        { id: "root-1", name: "kiro.rs", path: "/repo/kiro.rs", kind: "git" as const },
      ];
      const roots2 = [...roots1, { id: "root-2", name: "api", path: "/repo/api", kind: "folder" as const }];
      useAppStore.setState({
        tabs: [
          { id: "welcome", type: "welcome", title: "Welcome", closable: false },
          codeWorkspaceTab("code-a", roots1, "workspace-instance-a"),
          codeWorkspaceTab("code-b", roots1, "workspace-instance-b"),
        ],
      });

      useAppStore.getState().setTabCodeWorkspaceContext("code-a", workspaceContext(roots1));
      useAppStore.getState().setTabCodeWorkspaceContext("code-b", workspaceContext(roots1));
      useAppStore.getState().setTabCodeWorkspaceContext("code-a", workspaceContext(roots2));

      expect(useAppStore.getState().recentWorkspaces.map((workspace) => workspace.id)).toEqual([
        recentWorkspaceIdFromParts(roots2, []),
        recentWorkspaceIdFromParts(roots1, []),
      ]);
    });

    it("persists, limits, removes, and clears recent workspace entries", () => {
      useAppStore.setState({ welcomeRecentSessionLimit: 2 });
      const workspace = (name: string, path: string, lastOpenedAt: number): RecentWorkspace => ({
        id: name,
        name,
        roots: [{ id: `root-${name}`, name, path, kind: "folder" }],
        looseFiles: [],
        lastOpenedAt,
        lastActiveFile: null,
        isGitRepo: false,
      });

      useAppStore.getState().upsertRecentWorkspace(workspace("one", "/tmp/one", 1));
      useAppStore.getState().upsertRecentWorkspace(workspace("two", "/tmp/two", 2));
      useAppStore.getState().upsertRecentWorkspace(workspace("three", "/tmp/three", 3));

      expect(useAppStore.getState().recentWorkspaces.map((item) => item.name)).toEqual(["three", "two"]);
      expect(JSON.parse(window.localStorage.getItem("taomni.recentWorkspaces.v1") ?? "[]")).toHaveLength(2);

      const removeId = useAppStore.getState().recentWorkspaces[0].id;
      useAppStore.getState().removeRecentWorkspace(removeId);
      expect(useAppStore.getState().recentWorkspaces.map((item) => item.name)).toEqual(["two"]);

      useAppStore.getState().clearRecentWorkspaces();
      expect(useAppStore.getState().recentWorkspaces).toEqual([]);
      expect(window.localStorage.getItem("taomni.recentWorkspaces.v1")).toBe("[]");
    });
  });

  describe("appStore.sidebar", () => {
    beforeEach(() => {
      window.localStorage.clear();
      useAppStore.setState({
        tabs: [tab("welcome", { type: "welcome", closable: false })],
        activeTabId: "welcome",
        sidebarCollapsed: true,
      });
    });

    it("persists explicit sidebar collapsed changes", () => {
      useAppStore.getState().setSidebarCollapsed(false);
      expect(useAppStore.getState().sidebarCollapsed).toBe(false);
      expect(window.localStorage.getItem("taomni.sidebarCollapsed")).toBe("false");

      useAppStore.getState().setSidebarCollapsed(true);
      expect(useAppStore.getState().sidebarCollapsed).toBe(true);
      expect(window.localStorage.getItem("taomni.sidebarCollapsed")).toBe("true");
    });

    it("persists sidebar toggle changes", () => {
      useAppStore.getState().toggleSidebar();
      expect(useAppStore.getState().sidebarCollapsed).toBe(false);
      expect(window.localStorage.getItem("taomni.sidebarCollapsed")).toBe("false");
    });
  });

  describe("appStore.sidebar per tab group (ED-PARITY-027)", () => {
    beforeEach(() => {
      window.localStorage.clear();
      useAppStore.setState({
        tabs: [tab("welcome", { type: "welcome", closable: false }), tab("t1"), tab("cw", { type: "code-workspace" })],
        activeTabId: "welcome",
        sidebarCollapsed: false,
        mergeToolWindowRail: true,
        sidebarCollapsedByGroup: { "code-workspace": true, terminal: true, other: false },
      });
    });

    it("applies a group's state without rewriting the launch state", () => {
      window.localStorage.setItem("taomni.sidebarCollapsed", "false");
      useAppStore.setState({ activeTabId: "t1" });
      useAppStore.getState().applySidebarForActiveTab();
      expect(useAppStore.getState().sidebarCollapsed).toBe(true);
      // Quitting here must not start the next launch (Welcome) collapsed.
      expect(window.localStorage.getItem("taomni.sidebarCollapsed")).toBe("false");

      useAppStore.setState({ activeTabId: "welcome" });
      useAppStore.getState().applySidebarForActiveTab();
      expect(useAppStore.getState().sidebarCollapsed).toBe(false);
    });

    it("remembers manual changes per group and keeps only the other group in the legacy key", () => {
      useAppStore.setState({ activeTabId: "t1", sidebarCollapsed: true });
      useAppStore.getState().setSidebarCollapsed(false);
      expect(useAppStore.getState().sidebarCollapsedByGroup).toEqual({ "code-workspace": true, terminal: false, other: false });
      expect(window.localStorage.getItem("taomni.sidebarCollapsed")).toBeNull();
      expect(JSON.parse(window.localStorage.getItem("taomni.sidebarCollapsedByGroup.v1") ?? "null"))
        .toEqual({ "code-workspace": true, terminal: false });

      useAppStore.setState({ activeTabId: "cw" });
      useAppStore.getState().applySidebarForActiveTab();
      expect(useAppStore.getState().sidebarCollapsed).toBe(true);
      useAppStore.getState().setActiveSideTab("tools");
      expect(useAppStore.getState().sidebarCollapsedByGroup["code-workspace"]).toBe(false);
      expect(window.localStorage.getItem("taomni.sidebarCollapsed")).toBeNull();

      useAppStore.setState({ activeTabId: "welcome" });
      useAppStore.getState().toggleSidebar();
      expect(useAppStore.getState().sidebarCollapsedByGroup.other).toBe(true);
      expect(window.localStorage.getItem("taomni.sidebarCollapsed")).toBe("true");
    });

    it("keeps the single global state when the bar is not merged", () => {
      useAppStore.setState({ mergeToolWindowRail: false, activeTabId: "t1" });
      useAppStore.getState().setSidebarCollapsed(true);
      expect(window.localStorage.getItem("taomni.sidebarCollapsed")).toBe("true");
      expect(window.localStorage.getItem("taomni.sidebarCollapsedByGroup.v1")).toBeNull();
      useAppStore.getState().applySidebarForActiveTab();
      expect(useAppStore.getState().sidebarCollapsed).toBe(true);
    });
  });

  describe("appStore.terminalSplit", () => {
    beforeEach(() => {
      window.localStorage.clear();
      useAppStore.setState({
        tabs: [tab("a"), tab("b"), tab("settings", { type: "settings" })],
        activeTabId: "a",
        terminalSplitActive: false,
        terminalSplitLayout: "horizontal",
        terminalSplitInputLockedTabIds: new Set(),
        multiExecSelectedTabIds: new Set(),
      });
    });

    it("toggles terminal split view and keeps a terminal active", () => {
      useAppStore.setState({ activeTabId: "settings" });

      useAppStore.getState().toggleTerminalSplit();

      expect(useAppStore.getState().terminalSplitActive).toBe(true);
      expect(useAppStore.getState().activeTabId).toBe("a");

      useAppStore.getState().toggleTerminalSplit();

      expect(useAppStore.getState().terminalSplitActive).toBe(false);
    });

    it("persists terminal split layout", () => {
      useAppStore.getState().setTerminalSplitLayout("grid");

      expect(useAppStore.getState().terminalSplitLayout).toBe("grid");
      expect(window.localStorage.getItem("taomni.terminalSplitLayout")).toBe("grid");
    });

    it("toggles pane input locks", () => {
      useAppStore.getState().toggleTerminalSplitInputLock("b");

      expect(useAppStore.getState().terminalSplitInputLockedTabIds.has("b")).toBe(true);

      useAppStore.getState().toggleTerminalSplitInputLock("b");

      expect(useAppStore.getState().terminalSplitInputLockedTabIds.has("b")).toBe(false);
    });

    it("exits split when activating a non-terminal tab", () => {
      useAppStore.setState({ terminalSplitActive: true });

      useAppStore.getState().setActiveTab("settings");

      expect(useAppStore.getState().activeTabId).toBe("settings");
      expect(useAppStore.getState().terminalSplitActive).toBe(false);
    });

    it("cleans closed tab ids from split locks and MultiExec selection", () => {
      useAppStore.setState({
        terminalSplitActive: true,
        terminalSplitInputLockedTabIds: new Set(["b"]),
        multiExecSelectedTabIds: new Set(["a", "b"]),
      });

      useAppStore.getState().removeTab("b");

      expect(useAppStore.getState().terminalSplitInputLockedTabIds.has("b")).toBe(false);
      expect(useAppStore.getState().multiExecSelectedTabIds.has("b")).toBe(false);
      expect(useAppStore.getState().multiExecSelectedTabIds.has("a")).toBe(true);
    });
  });
}
