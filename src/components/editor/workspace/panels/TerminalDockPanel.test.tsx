import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { TerminalDockPanel, type TerminalDockHandle } from "./TerminalDockPanel";

vi.mock("../../../terminal/TerminalPanel", () => ({
  TerminalPanel: ({ tabId, initialCwd }: { tabId?: string; initialCwd?: string }) => (
    <div data-testid="mock-terminal" data-tab-id={tabId} data-initial-cwd={initialCwd} />
  ),
}));

afterEach(cleanup);

const roots = [
  { id: "app", name: "app", path: "/repo/app", kind: "git" as const },
  { id: "lib", name: "lib", path: "/repo/lib", kind: "folder" as const },
];

describe("TerminalDockPanel", () => {
  it("starts lazily in the workspace cwd and supports multiple root terminals", async () => {
    const { rerender } = render(
      <TerminalDockPanel
        workspaceInstanceId="ws"
        roots={roots}
        defaultCwd="/repo/app"
        active={false}
      />,
    );
    expect(screen.queryByTestId("mock-terminal")).not.toBeInTheDocument();

    rerender(
      <TerminalDockPanel
        workspaceInstanceId="ws"
        roots={roots}
        defaultCwd="/repo/app"
        active
      />,
    );
    expect(await screen.findByTestId("mock-terminal")).toHaveAttribute("data-initial-cwd", "/repo/app");

    fireEvent.change(screen.getByLabelText("Terminal root directory"), { target: { value: "lib" } });
    fireEvent.click(screen.getByLabelText("New workspace terminal"));
    await waitFor(() => expect(screen.getAllByTestId("mock-terminal")).toHaveLength(2));
    expect(screen.getAllByTestId("mock-terminal")[1]).toHaveAttribute("data-initial-cwd", "/repo/lib");
  });

  it("exposes open-at and closes instances by tab", async () => {
    const handle = createRef<TerminalDockHandle>();
    render(
      <TerminalDockPanel
        ref={handle}
        workspaceInstanceId="ws"
        roots={roots}
        defaultCwd="/repo/app"
        active={false}
      />,
    );
    handle.current?.openAt("/repo/app/src", "src");
    expect(await screen.findByText("src")).toBeInTheDocument();
    expect(screen.getByTestId("mock-terminal")).toHaveAttribute("data-initial-cwd", "/repo/app/src");
    fireEvent.click(screen.getByLabelText("Close src"));
    expect(screen.queryByTestId("mock-terminal")).not.toBeInTheDocument();
  });
});
