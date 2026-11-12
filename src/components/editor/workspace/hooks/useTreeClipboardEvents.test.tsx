import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTreeClipboardEvents } from "./useTreeClipboardEvents";

function Harness({ run }: { run: (commandId: string, context?: import("../workspaceCommands").WorkspaceCommandContext) => boolean }) {
  const pane = useRef<HTMLElement>(null);
  const runner = useRef(run);
  useTreeClipboardEvents(pane, runner);
  return <><aside ref={pane} tabIndex={0} data-testid="pane">
    <div data-testid="code-workspace-tree"><button data-testid="row">file.txt</button><input data-testid="field" /></div>
    <button data-testid="toolbar">New</button>
  </aside><textarea data-testid="editor" /></>;
}
afterEach(cleanup);

describe("native tree clipboard event ownership", () => {
  it.each(["copy", "cut", "paste"])("routes %s once from a tree row without a keydown", (operation) => {
    const run = vi.fn(() => true);
    const { unmount } = render(<Harness run={run} />);
    const event = new Event(operation, { bubbles: true, cancelable: true });
    fireEvent(screen.getByTestId("row"), event);
    expect(event.defaultPrevented).toBe(true);
    expect(run).toHaveBeenCalledExactlyOnceWith(`workspace.tree.${operation}`, { focus: "tree" });
    unmount();
    fireEvent(window, new Event(operation));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("uses the focused row for AppKit document-target events but leaves editable fields and toolbar alone", () => {
    const run = vi.fn(() => true);
    render(<Harness run={run} />);
    screen.getByTestId("row").focus();
    fireEvent(document.body, new Event("paste", { bubbles: true, cancelable: true }));
    expect(run).toHaveBeenCalledTimes(1);
    for (const id of ["field", "editor", "toolbar"]) {
      const element = screen.getByTestId(id);
      element.focus();
      const event = new Event("paste", { bubbles: true, cancelable: true });
      fireEvent(element, event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch an already owned clipboard event", () => {
    const run = vi.fn(() => true);
    render(<Harness run={run} />);
    const event = new Event("copy", { bubbles: true, cancelable: true });
    event.preventDefault();
    fireEvent(screen.getByTestId("row"), event);
    expect(run).not.toHaveBeenCalled();
  });
});
