import { beforeEach, describe, expect, it } from "vitest";
import { computeNewTerminalTitle, updateDuplicateAutoTitle, useAppStore } from "../../appStore";
import { tab } from "./harness";

export function registerappStoreEditing1Cases() {

  describe("appStore status writes", () => {
    it("does not publish equal status messages but publishes semantic changes", () => {
      const originalStatus = useAppStore.getState().statusMessage;
      useAppStore.setState({ statusMessage: "Ready" });
      const beforeEqualWrite = useAppStore.getState();
      let notifications = 0;
      const unsubscribe = useAppStore.subscribe(() => {
        notifications += 1;
      });

      try {
        useAppStore.getState().setStatusMessage("Ready");
        expect(useAppStore.getState()).toBe(beforeEqualWrite);
        expect(notifications).toBe(0);

        useAppStore.getState().setStatusMessage("Typing");
        expect(useAppStore.getState().statusMessage).toBe("Typing");
        expect(notifications).toBe(1);
      } finally {
        unsubscribe();
        useAppStore.setState({ statusMessage: originalStatus });
      }
    });
  });

  describe("appStore.moveTab", () => {
    beforeEach(() => {
      useAppStore.setState({
        tabs: [tab("a"), tab("b"), tab("c"), tab("d")],
        activeTabId: "a",
        recentWorkspaceIdByWorkspaceInstance: {},
      });
    });

    it("moves a tab before a later target", () => {
      useAppStore.getState().moveTab("a", "c", "before");
      expect(useAppStore.getState().tabs.map((t) => t.id)).toEqual(["b", "a", "c", "d"]);
    });

    it("moves a tab after a later target", () => {
      useAppStore.getState().moveTab("a", "c", "after");
      expect(useAppStore.getState().tabs.map((t) => t.id)).toEqual(["b", "c", "a", "d"]);
    });

    it("moves a tab before an earlier target", () => {
      useAppStore.getState().moveTab("d", "b", "before");
      expect(useAppStore.getState().tabs.map((t) => t.id)).toEqual(["a", "d", "b", "c"]);
    });

    it("moves a tab after an earlier target", () => {
      useAppStore.getState().moveTab("d", "b", "after");
      expect(useAppStore.getState().tabs.map((t) => t.id)).toEqual(["a", "b", "d", "c"]);
    });

    it("is a no-op when source and target are the same", () => {
      const before = useAppStore.getState().tabs;
      useAppStore.getState().moveTab("b", "b", "before");
      expect(useAppStore.getState().tabs).toBe(before);
    });

    it("is a no-op when dropping a tab onto its existing neighbor in the no-shift direction", () => {
      const before = useAppStore.getState().tabs;
      useAppStore.getState().moveTab("b", "a", "after");
      expect(useAppStore.getState().tabs).toBe(before);
      useAppStore.getState().moveTab("b", "c", "before");
      expect(useAppStore.getState().tabs).toBe(before);
    });

    it("ignores unknown ids", () => {
      const before = useAppStore.getState().tabs;
      useAppStore.getState().moveTab("missing", "a", "after");
      expect(useAppStore.getState().tabs).toBe(before);
      useAppStore.getState().moveTab("a", "missing", "after");
      expect(useAppStore.getState().tabs).toBe(before);
    });

    it("preserves the active tab id even after reordering", () => {
      useAppStore.setState({ activeTabId: "a" });
      useAppStore.getState().moveTab("a", "d", "after");
      expect(useAppStore.getState().activeTabId).toBe("a");
      expect(useAppStore.getState().tabs.map((t) => t.id)).toEqual(["b", "c", "d", "a"]);
    });
  });

  describe("appStore.duplicateTab", () => {
    beforeEach(() => {
      useAppStore.setState({
        tabs: [tab("a"), tab("b"), tab("c"), tab("d")],
        activeTabId: "a",
      });
    });

    it("inserts the copy immediately to the right of the original (issue #120)", () => {
      useAppStore.getState().duplicateTab("b");
      const ids = useAppStore.getState().tabs.map((t) => t.id);
      expect(ids).toHaveLength(5);
      // Copy sits at index 2, right after the source "b" — not at the end.
      expect(ids.slice(0, 2)).toEqual(["a", "b"]);
      expect(ids.slice(3)).toEqual(["c", "d"]);
      expect(ids[2]).not.toBe("b");
    });

    it("activates the new copy", () => {
      useAppStore.getState().duplicateTab("b");
      const { tabs, activeTabId } = useAppStore.getState();
      expect(activeTabId).toBe(tabs[2].id);
    });

    it("carries over the source tab fields with a fresh closable copy", () => {
      useAppStore.setState({
        tabs: [tab("a"), tab("locked", { closable: false, title: "Server", hasNewOutput: true })],
        activeTabId: "a",
      });
      useAppStore.getState().duplicateTab("locked");
      const copy = useAppStore.getState().tabs[2];
      // Copy gets the next sequence number in the "Server" family.
      expect(copy.title).toBe("Server-1");
      expect(copy.type).toBe("terminal");
      expect(copy.closable).toBe(true);
      expect(copy.hasNewOutput).toBe(false);
    });

    it("increments the -N suffix across same-prefix open tabs", () => {
      useAppStore.setState({
        tabs: [
          tab("s0", { title: "Server" }),
          tab("s1", { title: "Server-1" }),
          tab("other", { title: "Other" }),
        ],
        activeTabId: "s0",
      });
      const activeTitle = () => {
        const { tabs, activeTabId } = useAppStore.getState();
        return tabs.find((t) => t.id === activeTabId)?.title;
      };
      // Duplicating the base bumps to the next free family number.
      useAppStore.getState().duplicateTab("s0");
      expect(activeTitle()).toBe("Server-2");
      // Duplicating an already-numbered member continues the same family.
      useAppStore.getState().duplicateTab("s1");
      expect(activeTitle()).toBe("Server-3");
    });

    it("only carries terminalInitialCwd onto terminal copies", () => {
      useAppStore.setState({
        tabs: [
          tab("term", { title: "Local" }),
          tab("rdp", { type: "rdp", title: "Desktop" }),
        ],
        activeTabId: "term",
      });
      useAppStore.getState().duplicateTab("term", { terminalInitialCwd: "/home/me" });
      expect(useAppStore.getState().tabs[1].terminalInitialCwd).toBe("/home/me");
      useAppStore.getState().duplicateTab("rdp", { terminalInitialCwd: "/home/me" });
      expect(useAppStore.getState().tabs.find((t) => t.id !== "rdp" && t.title === "Desktop-1")?.terminalInitialCwd).toBeUndefined();
    });

    it("can carry a live terminal profile onto terminal copies", () => {
      const terminalProfile = {
        fontFamily: "\"JetBrains Mono\", monospace",
        fontSize: 18,
        fontLigatures: false,
        theme: "kanagawa-wave",
        scrollback: 10000,
        cursorStyle: "block" as const,
        cursorBlink: true,
        showScrollbar: true,
        webglRenderer: true,
        copyOnSelect: false,
        allowRemoteOsc52Clipboard: false,
        rightClickBehavior: "menu" as const,
        readOnly: false,
        bracketedPaste: true,
        multilinePasteConfirm: true,
        syntaxMode: "default" as const,
        loggingEnabled: false,
        inlineSuggestions: true,
        inlineSuggestionsMax: 2000,
        inlineSuggestionsSource: "history" as const,
        aiCommandRewriteEnabled: false,
        aiCommandRewriteShortcut: "Ctrl+K",
        aiInlineQqRender: false,
        commonCommands: [],
        commonCommandsShortcut: "Ctrl+Shift+P",
      };
      useAppStore.setState({
        tabs: [
          tab("term", { title: "Local" }),
          tab("rdp", { type: "rdp", title: "Desktop" }),
        ],
        activeTabId: "term",
      });

      useAppStore.getState().duplicateTab("term", { terminalProfile });
      expect(useAppStore.getState().tabs[1].terminalProfile).toMatchObject({
        fontSize: 18,
        theme: "kanagawa-wave",
      });

      useAppStore.getState().duplicateTab("rdp", { terminalProfile });
      expect(useAppStore.getState().tabs.find((t) => t.id !== "rdp" && t.title === "Desktop-1")?.terminalProfile).toBeUndefined();
    });

    it("duplicates code workspaces as a new runtime instance of the same definition", () => {
      const root = { id: "root-a", name: "repo", path: "/repo/app", kind: "git" as const };
      useAppStore.setState({
        tabs: [
          tab("code", {
            type: "code-workspace",
            title: "Code · repo",
            codeWorkspace: {
              repoRoot: "/repo/app",
              workspaceId: "workspace-definition",
              workspaceInstanceId: "workspace-instance-original",
              name: "repo",
              roots: [root],
              looseFiles: [],
              initialFile: null,
            },
          }),
        ],
        activeTabId: "code",
      });

      useAppStore.getState().duplicateTab("code");

      const copy = useAppStore.getState().tabs[1];
      expect(copy.codeWorkspace?.workspaceId).toBe("workspace-definition");
      expect(copy.codeWorkspace?.workspaceInstanceId).toMatch(/^workspace-instance-/);
      expect(copy.codeWorkspace?.workspaceInstanceId).not.toBe("workspace-instance-original");
    });

    it("mints a unique id distinct from the source", () => {
      useAppStore.getState().duplicateTab("a");
      const ids = useAppStore.getState().tabs.map((t) => t.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("is a no-op for an unknown id", () => {
      const before = useAppStore.getState().tabs;
      useAppStore.getState().duplicateTab("missing");
      expect(useAppStore.getState().tabs).toBe(before);
    });

    it("duplicates the last tab adjacently, which is also the end", () => {
      useAppStore.getState().duplicateTab("d");
      const ids = useAppStore.getState().tabs.map((t) => t.id);
      expect(ids.slice(0, 4)).toEqual(["a", "b", "c", "d"]);
      expect(ids).toHaveLength(5);
    });
  });

  describe("updateDuplicateAutoTitle", () => {
    it("replaces the cwd prefix but keeps the allocated suffix", () => {
      expect(updateDuplicateAutoTitle("repo-1", "other")).toBe("other-1");
      expect(updateDuplicateAutoTitle("Production · repo-3", "Production · log")).toBe("Production · log-3");
    });

    it("returns the new prefix when no suffix is present", () => {
      expect(updateDuplicateAutoTitle("repo", "other")).toBe("other");
    });
  });

  describe("computeNewTerminalTitle", () => {
    it("keeps the requested title when no terminal title family exists", () => {
      expect(computeNewTerminalTitle("Local terminal", ["root@example.test"])).toBe("Local terminal");
    });

    it("adds the next -N suffix when the requested terminal title already exists", () => {
      expect(computeNewTerminalTitle("Local terminal", ["Local terminal", "Local terminal-1"])).toBe(
        "Local terminal-2",
      );
    });

    it("continues an existing suffixed family even when the base title is closed", () => {
      expect(computeNewTerminalTitle("PowerShell", ["PowerShell-2"])).toBe("PowerShell-3");
    });
  });
}
