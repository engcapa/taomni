import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../../appStore";
import { tab } from "./harness";

export function registerappStoreModeRouting1Cases() {
  describe("appStore.modeRouting", () => {
    beforeEach(() => {
      window.localStorage.clear();
      useAppStore.setState({
        tabs: [{ id: "welcome", type: "welcome", title: "Welcome", closable: false }],
        activeTabId: "welcome",
        activeSideTab: "home",
      });
    });

    it("UT-WS-02-01: opening a global tab from Home reveals the Sessions workbench", () => {
      useAppStore.getState().addTab(tab("local-1"));
      expect(useAppStore.getState().activeSideTab).toBe("sessions");
      expect(useAppStore.getState().activeTabId).toBe("local-1");
    });

    it("UT-WS-02-02: activating a global tab from Workspaces reveals it too", () => {
      useAppStore.getState().addTab(tab("ssh-1"));
      useAppStore.setState({ activeSideTab: "workspaces" });
      useAppStore.getState().setActiveTab("ssh-1");
      expect(useAppStore.getState().activeSideTab).toBe("sessions");
    });

    it("UT-WS-02-03: the welcome tab never steals Home mode", () => {
      useAppStore.getState().setActiveTab("welcome");
      expect(useAppStore.getState().activeSideTab).toBe("home");
    });

    it("UT-WS-02-04: Sessions mode is left untouched when it already shows the tab", () => {
      useAppStore.setState({ activeSideTab: "sessions" });
      useAppStore.getState().addTab(tab("local-2"));
      expect(useAppStore.getState().activeSideTab).toBe("sessions");
    });
  });
}
