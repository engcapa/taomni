import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useShellCloseBridge } from "./useShellCloseBridge";
import { useAppStore } from "../stores/appStore";
import { useShellLayoutStore } from "../stores/shellLayoutStore";
import { registerCloseAdapter, requestTabClose } from "../lib/shell/closeCoordinator";
import type { CloseRisk } from "../lib/shell/types";

function Harness() { return useShellCloseBridge(); }

describe("Shell close result feedback", () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.setState({ tabs: [
      { id: "home", type: "welcome", title: "Home", closable: false },
      { id: "db", type: "terminal", title: "Database", closable: true },
    ], activeTabId: "db", statusMessage: "Ready" });
    useShellLayoutStore.setState({ panels: {} });
  });
  afterEach(cleanup);

  it("retains the completed business result when removing its tab", async () => {
    let pending = true;
    const risk: CloseRisk = { id: "tx", ownerId: "db", kind: "transaction", revision: "1", detail: "1 pending statement",
      choices: ["commit", "rollback", "cancel"] };
    const unregister = registerCloseAdapter("db", {
      getRisks: async () => pending ? [risk] : [],
      resolve: async () => {
        pending = false;
        useAppStore.getState().setStatusMessage("Rolled back 1 pending statement(s).");
      }, flush: async () => undefined,
    });
    try {
      render(<Harness />);
      let result!: ReturnType<typeof requestTabClose>;
      act(() => { result = requestTabClose(["db"]); });
      fireEvent.click(await screen.findByTestId("shell-close-rollback"));
      fireEvent.click(screen.getByTestId("shell-close-confirm"));
      await act(async () => expect((await result).status).toBe("closed"));
      expect(useAppStore.getState().tabs.map((tab) => tab.id)).toEqual(["home"]);
      expect(useAppStore.getState().statusMessage).toBe("Rolled back 1 pending statement(s).");
    } finally { unregister(); }
  });

  it("reports an ordinary close when no adapter produces a business result", async () => {
    render(<Harness />);
    await act(async () => expect((await requestTabClose(["db"])).status).toBe("closed"));
    expect(useAppStore.getState().statusMessage).toBe("Closed tab");
  });
});
