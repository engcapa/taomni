import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ListTree } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BottomDock } from "./BottomDock";

const tabs = [
  {
    id: "references",
    label: "References",
    icon: <ListTree aria-hidden="true" />,
    badge: 3,
    content: <div>Reference results</div>,
  },
];

describe("BottomDock", () => {
  afterEach(() => cleanup());

  it("renders the active tab content and collapses it from the tab", () => {
    const onOpenChange = vi.fn();
    render(
      <BottomDock
        open
        activeTab="references"
        tabs={tabs}
        onOpenChange={onOpenChange}
        onActiveTabChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("tabpanel", { name: "References" })).toHaveTextContent("Reference results");
    expect(screen.getByText("3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /References/ }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps inactive and collapsed panels mounted but hidden", () => {
    const twoTabs = [
      ...tabs,
      {
        id: "search",
        label: "Search",
        icon: <ListTree aria-hidden="true" />,
        content: <div>Search results state</div>,
      },
    ];
    const { rerender } = render(
      <BottomDock
        open
        activeTab="references"
        tabs={twoTabs}
        onOpenChange={vi.fn()}
        onActiveTabChange={vi.fn()}
      />,
    );

    expect(screen.getByText("Reference results")).toBeVisible();
    expect(screen.getByText("Search results state")).not.toBeVisible();

    rerender(
      <BottomDock
        open={false}
        activeTab="references"
        tabs={twoTabs}
        onOpenChange={vi.fn()}
        onActiveTabChange={vi.fn()}
      />,
    );
    expect(screen.getByText("Reference results")).not.toBeVisible();
    expect(screen.getByText("Search results state")).not.toBeVisible();
  });

  it("activates and expands a closed tab", () => {
    const onOpenChange = vi.fn();
    const onActiveTabChange = vi.fn();
    render(
      <BottomDock
        open={false}
        activeTab="references"
        tabs={tabs}
        onOpenChange={onOpenChange}
        onActiveTabChange={onActiveTabChange}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: /References/ }));
    expect(onActiveTabChange).toHaveBeenCalledWith("references");
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it("exposes a top resize handle that grows the dock upward", () => {
    const onHeightChange = vi.fn();
    render(
      <BottomDock
        open
        activeTab="references"
        tabs={tabs}
        height={200}
        onHeightChange={onHeightChange}
        onOpenChange={vi.fn()}
        onActiveTabChange={vi.fn()}
      />,
    );

    const handle = screen.getByTestId("code-workspace-bottom-dock-resize");
    fireEvent.pointerDown(handle, { clientY: 400, pointerId: 1 });
    fireEvent.pointerMove(window, { clientY: 300, pointerId: 1 });
    fireEvent.pointerUp(window, { clientY: 300, pointerId: 1 });
    expect(onHeightChange).toHaveBeenCalledWith(300);
  });

  it("supports keyboard resizing with ArrowUp and ArrowDown on resize handle", () => {
    const onHeightChange = vi.fn();
    render(
      <BottomDock
        open
        activeTab="references"
        tabs={tabs}
        height={300}
        onHeightChange={onHeightChange}
        onOpenChange={vi.fn()}
        onActiveTabChange={vi.fn()}
      />,
    );

    const handle = screen.getByTestId("code-workspace-bottom-dock-resize");
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    expect(onHeightChange).toHaveBeenCalledWith(320);

    fireEvent.keyDown(handle, { key: "ArrowDown" });
    expect(onHeightChange).toHaveBeenCalledWith(280);
  });

  it("cleans up drag state cleanly on pointercancel", () => {
    const onHeightChange = vi.fn();
    render(
      <BottomDock
        open
        activeTab="references"
        tabs={tabs}
        height={300}
        onHeightChange={onHeightChange}
        onOpenChange={vi.fn()}
        onActiveTabChange={vi.fn()}
      />,
    );

    const handle = screen.getByTestId("code-workspace-bottom-dock-resize");
    fireEvent.pointerDown(handle, { clientY: 400, pointerId: 1 });
    fireEvent.pointerMove(window, { clientY: 350, pointerId: 1 });
    expect(onHeightChange).toHaveBeenCalledWith(350);

    fireEvent.pointerCancel(window, { pointerId: 1 });
    // Subsequent pointermove should not trigger further height changes
    onHeightChange.mockClear();
    fireEvent.pointerMove(window, { clientY: 300, pointerId: 1 });
    expect(onHeightChange).not.toHaveBeenCalled();
  });

  it("dispatches onEscape when Escape key is pressed inside dock", () => {
    const onEscape = vi.fn();
    render(
      <BottomDock
        open
        activeTab="references"
        tabs={tabs}
        onEscape={onEscape}
        onOpenChange={vi.fn()}
        onActiveTabChange={vi.fn()}
      />,
    );

    const dock = screen.getByTestId("code-workspace-bottom-dock");
    fireEvent.keyDown(dock, { key: "Escape" });
    expect(onEscape).toHaveBeenCalled();
  });

  it("renders tab overflow dropdown when container is narrow", () => {
    let observerCallback: ResizeObserverCallback | null = null;
    const OriginalRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        observerCallback = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;

    try {
      const onActiveTabChange = vi.fn();
      const manyTabs = [
        ...tabs,
        { id: "problems", label: "Problems", icon: <span />, content: <div>Problems</div> },
        { id: "run", label: "Run", icon: <span />, content: <div>Run</div> },
        { id: "terminal", label: "Terminal", icon: <span />, content: <div>Terminal</div> },
      ];
      render(
        <BottomDock
          open
          activeTab="references"
          tabs={manyTabs}
          onOpenChange={vi.fn()}
          onActiveTabChange={onActiveTabChange}
        />,
      );

      // Trigger narrow resize observer: 150px
      act(() => {
        if (observerCallback) {
          (observerCallback as ResizeObserverCallback)(
            [{ contentRect: { width: 150 } } as ResizeObserverEntry],
            {} as ResizeObserver,
          );
        }
      });

      // Check for overflow button
      const overflowBtn = screen.getByTestId("code-workspace-bottom-tab-overflow");
      expect(overflowBtn).toBeInTheDocument();

      // Click to open menu
      fireEvent.click(overflowBtn);
      const menu = screen.getByTestId("code-workspace-bottom-tab-overflow-menu");
      expect(menu).toBeInTheDocument();

      // Click a tab in overflow menu
      const terminalOption = screen.getByTestId("code-workspace-bottom-tab-overflow-terminal");
      fireEvent.click(terminalOption);
      expect(onActiveTabChange).toHaveBeenCalledWith("terminal");
    } finally {
      globalThis.ResizeObserver = OriginalRO;
    }
  });

  it("clamps rendering height to maxHeight as effectiveHeight without calling onHeightChange", () => {
    const onHeightChange = vi.fn();
    render(
      <BottomDock
        open
        activeTab="references"
        tabs={tabs}
        height={449}
        maxHeight={250}
        onHeightChange={onHeightChange}
        onOpenChange={vi.fn()}
        onActiveTabChange={vi.fn()}
      />,
    );

    const handle = screen.getByTestId("code-workspace-bottom-dock-resize");
    expect(handle).toHaveAttribute("aria-valuenow", "250");
    expect(handle).toHaveAttribute("aria-valuemax", "250");
    const body = screen.getByTestId("code-workspace-bottom-dock-body");
    expect(body).toHaveStyle({ height: "200px" });
    expect(onHeightChange).not.toHaveBeenCalled();
  });

  it("cleans up drag state and listeners on visibilitychange", () => {
    const onHeightChange = vi.fn();
    render(
      <BottomDock
        open
        activeTab="references"
        tabs={tabs}
        height={300}
        onHeightChange={onHeightChange}
        onOpenChange={vi.fn()}
        onActiveTabChange={vi.fn()}
      />,
    );

    const handle = screen.getByTestId("code-workspace-bottom-dock-resize");
    fireEvent.pointerDown(handle, { clientY: 400, pointerId: 1 });
    fireEvent.pointerMove(window, { clientY: 350, pointerId: 1 });
    expect(onHeightChange).toHaveBeenCalledWith(350);

    onHeightChange.mockClear();
    fireEvent(document, new Event("visibilitychange"));

    // Moving mouse after visibility change should not trigger height changes
    fireEvent.pointerMove(window, { clientY: 300, pointerId: 1 });
    expect(onHeightChange).not.toHaveBeenCalled();
  });

  it("ignores Escape key during IME composition", () => {
    const onEscape = vi.fn();
    render(
      <BottomDock
        open
        activeTab="references"
        tabs={tabs}
        onEscape={onEscape}
        onOpenChange={vi.fn()}
        onActiveTabChange={vi.fn()}
      />,
    );

    const dock = screen.getByTestId("code-workspace-bottom-dock");
    fireEvent.keyDown(dock, {
      key: "Escape",
      isComposing: true,
      nativeEvent: { isComposing: true },
    });
    expect(onEscape).not.toHaveBeenCalled();
  });

  it("uses preferred height as baseline when dragging in clamped state and discards stale drag events via requestId token", () => {
    const onHeightChange = vi.fn();
    render(
      <BottomDock
        open
        activeTab="references"
        tabs={tabs}
        height={449}
        maxHeight={250}
        onHeightChange={onHeightChange}
        onOpenChange={vi.fn()}
        onActiveTabChange={vi.fn()}
      />,
    );

    const handle = screen.getByTestId("code-workspace-bottom-dock-resize");
    // Start drag at Y=500. Preferred height is 449 (effective clamped to 250).
    fireEvent.pointerDown(handle, { clientY: 500, pointerId: 1 });
    // Drag upward by 20px (delta = 500 - 480 = +20)
    fireEvent.pointerMove(window, { clientY: 480, pointerId: 1 });
    // Next preferred height should be 449 + 20 = 469 (not 250 + 20 = 270)
    expect(onHeightChange).toHaveBeenCalledWith(469);

    onHeightChange.mockClear();
    // Invalidate drag session via blur
    fireEvent.blur(window);
    // Stale pointer move should be discarded by requestId token check
    fireEvent.pointerMove(window, { clientY: 400, pointerId: 1 });
    expect(onHeightChange).not.toHaveBeenCalled();
  });
});
