import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
});
