import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Sidebar } from "./Sidebar";
import { useMainRailHostStore } from "../../stores/mainRailHostStore";

afterEach(() => {
  cleanup();
  useMainRailHostStore.setState({ host: null });
});

describe("Sidebar rail (ED-PARITY-027)", () => {
  it("publishes the tool window host only in the collapsed rail", () => {
    const { unmount } = render(<Sidebar compact />);
    const host = screen.getByTestId("sidebar-tool-window-rail");
    expect(useMainRailHostStore.getState().host).toBe(host);
    unmount();
    expect(useMainRailHostStore.getState().host).toBeNull();
    render(<Sidebar />);
    expect(screen.queryByTestId("sidebar-tool-window-rail")).toBeNull();
    expect(useMainRailHostStore.getState().host).toBeNull();
  });
});
