import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextMenu, useContextMenu, type MenuItem } from "./ContextMenu";

afterEach(cleanup);

describe("ContextMenu", () => {
  it("keeps the hook controller stable across unrelated rerenders", () => {
    const controllers: Array<ReturnType<typeof useContextMenu>> = [];

    function Harness({ nonce }: { nonce: number }) {
      const contextMenu = useContextMenu();
      controllers.push(contextMenu);
      return (
        <div data-nonce={nonce}>
          <button
            type="button"
            onClick={() => contextMenu.showAt(10, 10, [{ label: "Inspect" }])}
          >
            Open menu
          </button>
          {contextMenu.render}
        </div>
      );
    }

    const rendered = render(<Harness nonce={0} />);
    const initial = controllers[controllers.length - 1];

    rendered.rerender(<Harness nonce={1} />);
    expect(controllers[controllers.length - 1]).toBe(initial);

    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    const opened = controllers[controllers.length - 1];
    expect(opened).not.toBe(initial);
    expect(opened.show).toBe(initial.show);
    expect(opened.showAt).toBe(initial.showAt);
    expect(opened.close).toBe(initial.close);
    expect(screen.getByTestId("context-menu-item-inspect")).toBeInTheDocument();

    rendered.rerender(<Harness nonce={2} />);
    expect(controllers[controllers.length - 1]).toBe(opened);
  });

  it("renders a flat menu and closes after a leaf click", () => {
    const onClose = vi.fn();
    const onClick = vi.fn();
    const items: MenuItem[] = [{ label: "Connect", onClick }];

    render(<ContextMenu items={items} x={10} y={10} onClose={onClose} />);

    fireEvent.click(screen.getByTestId("context-menu-item-connect"));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("opens a submenu on hover and portals its items outside the parent surface", () => {
    const onClose = vi.fn();
    const items: MenuItem[] = [
      {
        label: "Import",
        children: [
          { label: "From file", onClick: vi.fn() },
          { label: "From archive", onClick: vi.fn() },
        ],
      },
    ];

    render(<ContextMenu items={items} x={10} y={10} onClose={onClose} />);

    // Submenu is closed until the parent row is hovered.
    expect(screen.queryByTestId("context-menu-item-from-file")).not.toBeInTheDocument();

    fireEvent.mouseEnter(screen.getByTestId("context-menu-item-import").parentElement!);

    const child = screen.getByTestId("context-menu-item-from-file");
    expect(child).toBeInTheDocument();
    // Portaled to <body>, not nested inside the triggering surface.
    const parentSurface = screen.getByTestId("context-menu-item-import").closest("[data-testid='context-menu']");
    expect(parentSurface?.contains(child)).toBe(false);
  });

  it("keeps the menu open when interacting inside a portaled submenu", () => {
    const onClose = vi.fn();
    const leafClick = vi.fn();
    const items: MenuItem[] = [
      { label: "More", children: [{ label: "Deep action", onClick: leafClick }] },
    ];

    render(<ContextMenu items={items} x={10} y={10} onClose={onClose} />);
    fireEvent.mouseEnter(screen.getByTestId("context-menu-item-more").parentElement!);

    const deep = screen.getByTestId("context-menu-item-deep-action");
    // A mousedown inside the portaled submenu must not dismiss the whole menu.
    fireEvent.mouseDown(deep);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(deep);
    expect(leafClick).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes when clicking outside any menu surface", () => {
    const onClose = vi.fn();
    render(<ContextMenu items={[{ label: "Connect", onClick: vi.fn() }]} x={10} y={10} onClose={onClose} />);

    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("supports keyboard navigation with arrow keys, skips separators and disabled items, and applies with Enter", () => {
    const onClose = vi.fn();
    const onClick1 = vi.fn();
    const onClick2 = vi.fn();
    const onClick3 = vi.fn();
    const items: MenuItem[] = [
      { label: "Item 1", onClick: onClick1 },
      { separator: true, label: "sep" },
      { label: "Item 2 (Disabled)", disabled: true, onClick: onClick2 },
      { label: "Item 3", onClick: onClick3 },
    ];

    render(<ContextMenu items={items} x={10} y={10} onClose={onClose} />);

    const item1 = screen.getByTestId("context-menu-item-item-1");
    const item3 = screen.getByTestId("context-menu-item-item-3");

    // Initially first selectable item is active
    expect(item1).toHaveAttribute("data-active", "true");

    // ArrowDown skips separator and disabled item, moves to Item 3
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(item3).toHaveAttribute("data-active", "true");
    expect(item1).not.toHaveAttribute("data-active");

    // Press Enter on Item 3
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onClick3).toHaveBeenCalledTimes(1);
    expect(onClick1).not.toHaveBeenCalled();
    expect(onClick2).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("takes focus when opened so editor navigation keys are not targeted at the editor", () => {
    render(<ContextMenu items={[{ label: "Inspect" }]} x={10} y={10} onClose={vi.fn()} />);

    expect(screen.getByTestId("context-menu")).toHaveFocus();
  });

  it("closes on Escape key press", () => {
    const onClose = vi.fn();
    render(<ContextMenu items={[{ label: "Action" }]} x={10} y={10} onClose={onClose} />);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  describe("code-candidates appearance", () => {
    it("renders code candidate styling without default hover background classes", () => {
      const items: MenuItem[] = [
        { label: "Quick Fixes", disabled: true },
        { label: "Add type annotation", onClick: vi.fn() },
        { label: "Import class", onClick: vi.fn() },
      ];

      render(<ContextMenu appearance="code-candidates" items={items} x={10} y={10} onClose={vi.fn()} />);

      const menu = screen.getByTestId("context-menu");
      expect(menu).toHaveAttribute("data-appearance", "code-candidates");
      expect(menu.style.background).toBe("var(--taomni-code-tooltip-bg)");

      const header = screen.getByTestId("context-menu-item-quick-fixes");
      const fix1 = screen.getByTestId("context-menu-item-add-type-annotation");
      const fix2 = screen.getByTestId("context-menu-item-import-class");

      // Initial active index skips disabled header and selects first candidate
      expect(fix1).toHaveAttribute("data-active", "true");
      expect(fix2).not.toHaveAttribute("data-active");
      expect(header).not.toHaveAttribute("data-active");

      // Buttons under code-candidates do not have hover:bg-[var(--taomni-hover)] class
      expect(fix1.className).not.toContain("hover:bg-[var(--taomni-hover)]");
      expect(fix2.className).not.toContain("hover:bg-[var(--taomni-hover)]");
    });

    it("moves focus on arrow navigation and does not leave hover selection on previous item", () => {
      const items: MenuItem[] = [
        { label: "Fix 1", onClick: vi.fn() },
        { label: "Fix 2", onClick: vi.fn() },
      ];

      render(<ContextMenu appearance="code-candidates" items={items} x={10} y={10} onClose={vi.fn()} />);

      const fix1 = screen.getByTestId("context-menu-item-fix-1");
      const fix2 = screen.getByTestId("context-menu-item-fix-2");

      expect(fix1).toHaveAttribute("data-active", "true");
      expect(fix2).not.toHaveAttribute("data-active");

      // ArrowDown moves active to Fix 2
      fireEvent.keyDown(window, { key: "ArrowDown" });
      expect(fix2).toHaveAttribute("data-active", "true");
      expect(fix1).not.toHaveAttribute("data-active");

      // Hovering or moving mouse without physical displacement does not steal focus back
      fireEvent.mouseMove(fix1, { movementX: 0, movementY: 0 });
      expect(fix2).toHaveAttribute("data-active", "true");
      expect(fix1).not.toHaveAttribute("data-active");

      // Physical mouse move on Fix 1 reactivates it
      fireEvent.mouseMove(fix1, { movementX: 2, movementY: 1 });
      expect(fix1).toHaveAttribute("data-active", "true");
      expect(fix2).not.toHaveAttribute("data-active");
    });

    it("does not activate disabled headers on mouse hover or move", () => {
      const items: MenuItem[] = [
        { label: "Header", disabled: true },
        { label: "Fix", onClick: vi.fn() },
      ];

      render(<ContextMenu appearance="code-candidates" items={items} x={10} y={10} onClose={vi.fn()} />);

      const header = screen.getByTestId("context-menu-item-header");
      const fix = screen.getByTestId("context-menu-item-fix");

      expect(fix).toHaveAttribute("data-active", "true");
      expect(header).not.toHaveAttribute("data-active");

      fireEvent.mouseEnter(header);
      expect(header).not.toHaveAttribute("data-active");
      expect(fix).toHaveAttribute("data-active", "true");

      fireEvent.mouseMove(header, { movementX: 5, movementY: 5 });
      expect(header).not.toHaveAttribute("data-active");
      expect(fix).toHaveAttribute("data-active", "true");
    });
  });
});

