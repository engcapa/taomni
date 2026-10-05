import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { BottomDock } from "./BottomDock";
import { ToolWindowRail } from "./ToolWindowRail";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ED-PARITY-010 tool window rail", () => {
  it("renders stripe buttons with pressed state, shortcut titles and disabled reasons", () => {
    const onProject = vi.fn();
    render(
      <ToolWindowRail
        side="left"
        top={[
          { id: "project", label: "Project", icon: null, active: true, shortcut: "Alt+1", onSelect: onProject },
          { id: "commit", label: "Commit", icon: null, active: false, disabled: true, disabledReason: "No Git repository", onSelect: vi.fn() },
        ]}
      />,
    );
    const project = screen.getByTestId("code-workspace-tool-rail-project");
    expect(project).toHaveAttribute("aria-pressed", "true");
    expect(project).toHaveAttribute("title", "Project Alt+1");
    fireEvent.click(project);
    expect(onProject).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("code-workspace-tool-rail-commit")).toBeDisabled();
    expect(screen.getByTestId("code-workspace-tool-rail-commit").getAttribute("title")).toContain("No Git repository");
  });

  it("renders an embedded stripe for the sidebar rail without its own chrome (ED-PARITY-027)", () => {
    render(
      <ToolWindowRail
        side="left"
        embedded
        width={59}
        showNames
        onResize={vi.fn()}
        top={[{ id: "sftp", label: "SFTP", icon: null, active: false, testId: "attached-sftp-toggle", onSelect: vi.fn() }]}
      />,
    );
    const rail = screen.getByTestId("code-workspace-tool-rail-left");
    expect(rail).toHaveAttribute("data-embedded", "true");
    expect(rail.className).toContain("flex-1");
    expect(rail.className).not.toContain("bg-[var(--taomni-code-gutter-bg)]");
    expect(rail.style.width).toBe("100%");
    expect(screen.getByTestId("attached-sftp-toggle")).toHaveTextContent("SFTP");
    expect(screen.queryByTestId("code-workspace-tool-rail-left-resize")).toBeNull();
  });

  it.each(["left", "right"] as const)("keeps pointer and keyboard resizing on the standalone %s rail", (side) => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    const onResize = vi.fn();
    function ResizableRail() {
      const [width, setWidth] = useState(59);
      return <ToolWindowRail side={side} top={[]} showNames width={width} onResize={(next) => {
        onResize(next);
        setWidth(next);
      }} />;
    }
    const { unmount } = render(<ResizableRail />);
    const handle = screen.getByTestId(`code-workspace-tool-rail-${side}-resize`);
    fireEvent.keyDown(handle, { key: side === "left" ? "ArrowRight" : "ArrowLeft" });
    expect(screen.getByTestId(`code-workspace-tool-rail-${side}`)).toHaveStyle({ width: "63px" });
    fireEvent.pointerDown(handle, { button: 0, clientX: 100 });
    fireEvent.pointerMove(window, { clientX: side === "left" ? 120 : 80 });
    expect(screen.getByTestId(`code-workspace-tool-rail-${side}`)).toHaveStyle({ width: "83px" });
    fireEvent.keyDown(handle, { key: "End" });
    expect(handle).toHaveAttribute("aria-valuenow", "100");
    expect(screen.getByTestId(`code-workspace-tool-rail-${side}`)).toHaveStyle({ width: "100px" });
    fireEvent.keyDown(handle, { key: "Home" });
    expect(handle).toHaveAttribute("aria-valuenow", "40");
    expect(screen.getByTestId(`code-workspace-tool-rail-${side}`)).toHaveStyle({ width: "40px" });
    unmount();
    onResize.mockClear();
    fireEvent.pointerMove(window, { clientX: 130 });
    expect(onResize).not.toHaveBeenCalled();
  });

  function DockWithRail() {
    const [host, setHost] = useState<HTMLDivElement | null>(null);
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState("problems");
    return (
      <div>
        <ToolWindowRail side="left" top={[]} bottomSlotRef={setHost} />
        <BottomDock
          railHost={host}
          open={open}
          activeTab={active}
          onOpenChange={setOpen}
          onActiveTabChange={setActive}
          tabs={[
            { id: "problems", label: "Problems", icon: null, content: <div>problems body</div> },
            { id: "terminal", label: "Terminal", icon: null, content: <div>terminal body</div> },
          ]}
        />
      </div>
    );
  }

  it("moves the bottom tool buttons onto the rail and shows an IDEA tool window header", () => {
    render(<DockWithRail />);
    const rail = screen.getByTestId("code-workspace-tool-rail-left");
    const problems = screen.getByTestId("code-workspace-bottom-tab-problems");
    expect(rail.contains(problems)).toBe(true);
    expect(screen.queryByTestId("code-workspace-tool-window-header")).toBeNull();
    fireEvent.click(problems);
    expect(screen.getByTestId("code-workspace-tool-window-title")).toHaveTextContent("Problems");
    expect(screen.getByTestId("code-workspace-bottom-tab-problems")).toHaveAttribute("aria-selected", "true");
    // Clicking the visible window's stripe button hides it (IDEA toggle).
    fireEvent.click(screen.getByTestId("code-workspace-bottom-tab-problems"));
    expect(screen.queryByTestId("code-workspace-tool-window-header")).toBeNull();
    // "More tool windows" always lists every bottom tool.
    fireEvent.click(screen.getByTestId("code-workspace-bottom-tab-overflow"));
    fireEvent.click(screen.getByTestId("code-workspace-bottom-tab-overflow-terminal"));
    expect(screen.getByTestId("code-workspace-tool-window-title")).toHaveTextContent("Terminal");
    fireEvent.click(screen.getByTestId("code-workspace-tool-window-hide"));
    expect(screen.queryByTestId("code-workspace-tool-window-header")).toBeNull();
  });
});
