import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { TabItemProps } from "./model";
import { TabItem } from "./TabItem";

afterEach(cleanup);

it("closes Settings without activating or dragging it during the pointer gesture", () => {
  const props: TabItemProps = {
    tab: { id: "settings", type: "settings", title: "Settings", closable: true },
    translate: (key) => key,
    active: true,
    multiExecActive: false,
    multiExecSelected: false,
    dragging: false,
    draggedId: null,
    dropSide: undefined,
    editing: false,
    draftTitle: "",
    onElementChange: vi.fn(),
    onStartDrag: vi.fn(),
    onDragOverTab: vi.fn(),
    onDragLeaveTab: vi.fn(),
    onDropOnTab: vi.fn(),
    onActivate: vi.fn(),
    onMouseDown: vi.fn(),
    onContextMenu: vi.fn(),
    onDraftTitleChange: vi.fn(),
    onCommitRename: vi.fn(),
    onCancelRename: vi.fn(),
    onStartRename: vi.fn(),
    onShowDetails: vi.fn(),
    onHideDetails: vi.fn(),
    onToggleMultiExecTab: vi.fn(),
    onRemove: vi.fn(),
  };
  render(<TabItem {...props} />);
  const close = screen.getByTestId("tab-close");
  fireEvent.pointerDown(close, { button: 0 });
  fireEvent.mouseDown(close, { button: 0 });
  fireEvent.pointerUp(close, { button: 0 });
  fireEvent.mouseUp(close, { button: 0 });
  fireEvent.click(close);
  expect(props.onActivate).not.toHaveBeenCalled();
  expect(props.onStartDrag).not.toHaveBeenCalled();
  expect(props.onMouseDown).not.toHaveBeenCalled();
  expect(props.onRemove).toHaveBeenCalledExactlyOnceWith("settings");
});
