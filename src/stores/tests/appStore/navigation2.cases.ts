import { beforeEach, describe, expect, it } from "vitest";
import { VAULT_UNLOCK_MODE_KEY, subscribeUiAppearanceStorage, useAppStore } from "../../appStore";
import { tab } from "./harness";

export function registerappStoreNavigation2Cases() {

  describe("appStore terminal automatic titles", () => {
    beforeEach(() => {
      useAppStore.setState({
        tabs: [],
        activeTabId: null,
        cwdByTab: {},
        terminalRuntimeByTab: {},
      });
    });

    it("resolves a new terminal from cwd, sequences its family, and follows later cd changes", () => {
      useAppStore.setState({
        tabs: [
          tab("existing", { title: "taomni" }),
          tab("pending", {
            title: "Production",
            terminalTitleMode: "pending-auto",
            terminalTitleOperation: "new",
          }),
        ],
      });

      useAppStore.getState().assignTerminalAutoTitle("pending", "/srv/taomni");
      expect(useAppStore.getState().tabs[1]).toMatchObject({ title: "taomni-1", terminalTitleMode: "auto" });

      useAppStore.getState().assignTerminalAutoTitle("pending", "/tmp/other");
      expect(useAppStore.getState().tabs[1].title).toBe("other");
    });

    it("keeps a saved remote session name before the live cwd", () => {
      useAppStore.setState({
        tabs: [tab("remote", {
          title: "Production",
          terminalTitleMode: "pending-auto",
          terminalTitleOperation: "new",
          terminalTitleSessionName: "Production",
        })],
      });

      useAppStore.getState().assignTerminalAutoTitle("remote", "/srv/taomni");
      expect(useAppStore.getState().tabs[0].title).toBe("Production · taomni");

      useAppStore.getState().assignTerminalAutoTitle("remote", "/var/log");
      expect(useAppStore.getState().tabs[0].title).toBe("Production · log");
    });

    it("keeps duplicate force-suffix semantics when resolving a cwd family", () => {
      useAppStore.setState({
        tabs: [tab("copy", {
          title: "Legacy-1",
          terminalTitleMode: "pending-auto",
          terminalTitleOperation: "duplicate",
        })],
      });

      useAppStore.getState().assignTerminalAutoTitle("copy", "/work/repo");
      expect(useAppStore.getState().tabs[0].title).toBe("repo-1");
    });

    it("keeps a resolved duplicate suffix stable across later cwd refreshes", () => {
      useAppStore.setState({
        tabs: [
          tab("source", { title: "repo", terminalTitleMode: "auto" }),
          tab("copy1", {
            title: "repo-1",
            terminalTitleMode: "auto",
            terminalTitleOperation: "duplicate",
          }),
          tab("copy2", {
            title: "repo-2",
            terminalTitleMode: "auto",
            terminalTitleOperation: "duplicate",
          }),
        ],
      });

      useAppStore.getState().assignTerminalAutoTitle("copy1", "/srv/repo");
      expect(useAppStore.getState().tabs[1].title).toBe("repo-1");
    });

    it("follows cd in a resolved duplicate while preserving its suffix", () => {
      useAppStore.setState({
        tabs: [tab("copy", {
          title: "repo-1",
          terminalTitleMode: "auto",
          terminalTitleOperation: "duplicate",
        })],
      });

      useAppStore.getState().assignTerminalAutoTitle("copy", "/tmp/other");
      expect(useAppStore.getState().tabs[0].title).toBe("other-1");
    });

    it("keeps the remote session name when a resolved duplicate changes cwd", () => {
      useAppStore.setState({
        tabs: [tab("copy", {
          title: "Production · repo-1",
          terminalTitleMode: "auto",
          terminalTitleOperation: "duplicate",
          terminalTitleSessionName: "Production",
        })],
      });

      useAppStore.getState().assignTerminalAutoTitle("copy", "/var/log");
      expect(useAppStore.getState().tabs[0].title).toBe("Production · log-1");
    });

    it("never overwrites an explicit manual rename", () => {
      useAppStore.setState({
        tabs: [tab("term", {
          title: "Local terminal",
          terminalTitleMode: "pending-auto",
          terminalTitleOperation: "new",
        })],
      });

      useAppStore.getState().updateTabTitle("term", "Logs");
      useAppStore.getState().assignTerminalAutoTitle("term", "/var/log");
      expect(useAppStore.getState().tabs[0]).toMatchObject({ title: "Logs", terminalTitleMode: "manual" });
    });

    it("names a duplicate immediately when its source cwd was already known", () => {
      useAppStore.setState({ tabs: [tab("source", { title: "Production" })] });
      useAppStore.getState().duplicateTab("source", {
        terminalInitialCwd: "/srv/repo",
        terminalTitlePrefix: "repo",
      });
      expect(useAppStore.getState().tabs[1]).toMatchObject({
        title: "repo-1",
        terminalTitleMode: "auto",
        terminalTitleOperation: "duplicate",
      });
    });

    it("keeps the remote session name when duplicating a known cwd", () => {
      useAppStore.setState({
        tabs: [tab("source", {
          title: "Production · repo",
          terminalTitleMode: "auto",
          terminalTitleSessionName: "Production",
        })],
      });
      useAppStore.getState().duplicateTab("source", {
        terminalInitialCwd: "/srv/repo",
        terminalTitlePrefix: "repo",
      });
      expect(useAppStore.getState().tabs[1].title).toBe("Production · repo-1");
    });

    it("continues the source cwd title family when duplicating an auto-named tab", () => {
      useAppStore.setState({ tabs: [tab("source", { title: "repo-3", terminalTitleMode: "auto" })] });
      useAppStore.getState().duplicateTab("source", {
        terminalInitialCwd: "/srv/repo",
        terminalTitlePrefix: "repo",
      });
      expect(useAppStore.getState().tabs[1].title).toBe("repo-4");
    });

    it("duplicates a manually renamed tab as manual-name + suffix, not cwd basename", () => {
      useAppStore.setState({
        tabs: [tab("source", {
          title: "name",
          terminalTitleMode: "manual",
          terminalTitleSessionName: "Production",
        })],
      });
      useAppStore.getState().duplicateTab("source", {
        terminalInitialCwd: "/srv/repo",
        terminalTitlePrefix: "repo",
      });
      expect(useAppStore.getState().tabs[1]).toMatchObject({
        title: "name-1",
        terminalTitleMode: "manual",
        terminalInitialCwd: "/srv/repo",
        terminalTitleOperation: undefined,
      });
    });

    it("keeps a manual duplicate out of later automatic cwd renames", () => {
      useAppStore.setState({
        tabs: [tab("source", { title: "name", terminalTitleMode: "manual" })],
      });
      useAppStore.getState().duplicateTab("source", {
        terminalInitialCwd: "/srv/repo",
        terminalTitlePrefix: "repo",
      });
      const copyId = useAppStore.getState().tabs[1].id;
      useAppStore.getState().assignTerminalAutoTitle(copyId, "/var/log");
      expect(useAppStore.getState().tabs[1]).toMatchObject({
        title: "name-1",
        terminalTitleMode: "manual",
      });
    });

    it("sequences further duplicates from a manual title family", () => {
      useAppStore.setState({
        tabs: [
          tab("source", { title: "name", terminalTitleMode: "manual" }),
          tab("copy1", { title: "name-1", terminalTitleMode: "manual" }),
        ],
      });
      useAppStore.getState().duplicateTab("source", {
        terminalInitialCwd: "/srv/repo",
        terminalTitlePrefix: "repo",
      });
      expect(useAppStore.getState().tabs[1].title).toBe("name-2");
    });
  });

  describe("appStore terminal runtime", () => {
    it("merges live activity and cleans it with cwd when the tab closes", () => {
      useAppStore.setState({
        tabs: [tab("term")],
        activeTabId: "term",
        cwdByTab: { term: "/work/repo" },
        terminalRuntimeByTab: {},
      });
      useAppStore.getState().setTerminalRuntime("term", {
        backendSessionId: "runtime-1",
        state: "running",
        program: "vite",
      });
      expect(useAppStore.getState().terminalRuntimeByTab.term).toMatchObject({
        backendSessionId: "runtime-1",
        state: "running",
        program: "vite",
      });

      useAppStore.getState().removeTab("term");
      expect(useAppStore.getState().cwdByTab.term).toBeUndefined();
      expect(useAppStore.getState().terminalRuntimeByTab.term).toBeUndefined();
    });
  });

  describe("appStore.uiAppearance", () => {
    it("allows setting and persisting uiFontFamily", () => {
      const font = "Outfit, sans-serif";
      useAppStore.getState().setUiFontFamily(font);
      expect(useAppStore.getState().uiFontFamily).toBe(font);
      expect(window.localStorage.getItem("taomni.uiFontFamily")).toBe(font);
    });

    it("allows setting and persisting uiFontSize", () => {
      const size = 14;
      useAppStore.getState().setUiFontSize(size);
      expect(useAppStore.getState().uiFontSize).toBe(size);
      expect(window.localStorage.getItem("taomni.uiFontSize")).toBe("14");
    });

    it("clamps uiFontSize to the supported settings range", () => {
      useAppStore.getState().setUiFontSize(99);
      expect(useAppStore.getState().uiFontSize).toBe(18);
      expect(window.localStorage.getItem("taomni.uiFontSize")).toBe("18");

      useAppStore.getState().setUiFontSize(3);
      expect(useAppStore.getState().uiFontSize).toBe(10);
      expect(window.localStorage.getItem("taomni.uiFontSize")).toBe("10");
    });

    it("synchronizes UI appearance changes from another window", () => {
      const unsubscribe = subscribeUiAppearanceStorage();
      try {
        window.localStorage.setItem("taomni.uiFontFamily", '"Segoe UI", sans-serif');
        window.dispatchEvent(new StorageEvent("storage", {
          key: "taomni.uiFontFamily",
          newValue: '"Segoe UI", sans-serif',
        }));
        expect(useAppStore.getState().uiFontFamily).toBe('"Segoe UI", sans-serif');

        window.localStorage.setItem("taomni.uiFontSize", "17");
        window.dispatchEvent(new StorageEvent("storage", {
          key: "taomni.uiFontSize",
          newValue: "17",
        }));
        expect(useAppStore.getState().uiFontSize).toBe(17);

        window.localStorage.removeItem("taomni.uiFontSize");
        window.dispatchEvent(new StorageEvent("storage", {
          key: "taomni.uiFontSize",
          newValue: null,
        }));
        expect(useAppStore.getState().uiFontSize).toBe(12);
      } finally {
        unsubscribe();
      }
    });

    it("allows setting and persisting the welcome recent session limit", () => {
      useAppStore.getState().setWelcomeRecentSessionLimit(35);
      expect(useAppStore.getState().welcomeRecentSessionLimit).toBe(35);
      expect(window.localStorage.getItem("taomni.welcomeRecentSessionLimit")).toBe("35");

      useAppStore.getState().setWelcomeRecentSessionLimit(250);
      expect(useAppStore.getState().welcomeRecentSessionLimit).toBe(100);

      useAppStore.getState().setWelcomeRecentSessionLimit(-5);
      expect(useAppStore.getState().welcomeRecentSessionLimit).toBe(1);
    });

    it("allows setting and persisting the vault unlock mode", () => {
      useAppStore.setState({ vaultUnlockMode: "startup" });
      window.localStorage.removeItem(VAULT_UNLOCK_MODE_KEY);

      useAppStore.getState().setVaultUnlockMode("on-demand");
      expect(useAppStore.getState().vaultUnlockMode).toBe("on-demand");
      expect(window.localStorage.getItem(VAULT_UNLOCK_MODE_KEY)).toBe("on-demand");

      useAppStore.getState().setVaultUnlockMode("startup");
      expect(useAppStore.getState().vaultUnlockMode).toBe("startup");
      expect(window.localStorage.getItem(VAULT_UNLOCK_MODE_KEY)).toBe("startup");
    });
  });

  describe("appStore.dbSelectedObjects", () => {
    beforeEach(() => {
      useAppStore.setState({ dbSelectedObjectsByTab: {} });
    });

    it("records, updates, and clears DB tab selected objects", () => {
      useAppStore.getState().setTabDbSelectedObjects("db-tab-1", [
        {
          catalog: "hive",
          schema: "default",
          name: "orders",
          kind: "table",
        },
        {
          catalog: "hive",
          schema: "default",
          name: "sp_sync",
          kind: "procedure",
        },
      ]);

      expect(useAppStore.getState().dbSelectedObjectsByTab["db-tab-1"]).toMatchObject([
        {
          catalog: "hive",
          schema: "default",
          name: "orders",
          kind: "table",
        },
        {
          catalog: "hive",
          schema: "default",
          name: "sp_sync",
          kind: "procedure",
        },
      ]);

      useAppStore.getState().setTabDbSelectedObjects("db-tab-1", [
        {
          catalog: null,
          schema: "public",
          name: "report_v",
          kind: "view",
        },
      ]);
      expect(useAppStore.getState().dbSelectedObjectsByTab["db-tab-1"]).toMatchObject([
        {
          catalog: null,
          schema: "public",
          name: "report_v",
          kind: "view",
        },
      ]);

      useAppStore.getState().setTabDbSelectedObjects("db-tab-1", null);
      expect(useAppStore.getState().dbSelectedObjectsByTab["db-tab-1"]).toBeUndefined();
    });
  });
}
