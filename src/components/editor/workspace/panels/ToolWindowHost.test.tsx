import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef, forwardRef, useEffect, useImperativeHandle, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ToolWindowPortal, ToolWindowSlot, useToolWindowNodes } from "./ToolWindowHost";

afterEach(cleanup);

it("keeps background tool handles and drafts while deferring hidden prop construction until reveal", () => {
  const unmount = vi.fn();
  const onSave = vi.fn();
  const handle = createRef<{ append: () => void }>();
  const Panel = forwardRef<{ append: () => void }, { revision: number }>(function Panel({ revision }, ref) {
    const [draft, setDraft] = useState("");
    useImperativeHandle(ref, () => ({ append: () => setDraft((text) => `${text} result`) }));
    useEffect(() => unmount, []);
    return <div><input aria-label="Tool draft" value={draft} onChange={(event) => setDraft(event.target.value)} />
      <button onClick={() => onSave(revision, draft)}>Save tool draft</button></div>;
  });
  const construct = vi.fn((revision: number) => <Panel ref={handle} revision={revision} />);
  const escape = vi.fn();
  function Host({ active, revision, move = false }: { active: boolean; revision: number; move?: boolean }) {
    const nodes = useToolWindowNodes();
    return <>
      <div ref={nodes.setParking} hidden />
      <div key={move ? "bottom" : "left"} hidden={!active}>
        <ToolWindowSlot nodes={nodes} id="run" label="Run" />
      </div>
      <ToolWindowPortal nodes={nodes} id="run" label="Run" active={active}
        onEscape={() => escape(revision)} renderContent={() => construct(revision)} />
    </>;
  }
  const { rerender, unmount: dispose } = render(<Host active={false} revision={1} />);
  // Run/debug callers can use their handle before opening the tool.
  expect(handle.current).not.toBeNull();
  act(() => handle.current!.append());
  expect(screen.getByLabelText("Tool draft")).toHaveValue(" result");
  expect(construct).toHaveBeenCalledTimes(1);
  rerender(<Host active={false} revision={2} />);
  rerender(<Host active={false} revision={3} move />);
  expect(construct).toHaveBeenCalledTimes(1);
  expect(unmount).not.toHaveBeenCalled();
  rerender(<Host active revision={4} move />);
  expect(construct).toHaveBeenLastCalledWith(4);
  expect(screen.getByLabelText("Tool draft")).toBeVisible();
  expect(screen.getByLabelText("Tool draft")).toHaveValue(" result");
  fireEvent.click(screen.getByText("Save tool draft"));
  expect(onSave).toHaveBeenLastCalledWith(4, " result");
  fireEvent.keyDown(screen.getByLabelText("Tool draft"), { key: "Escape" });
  expect(escape).toHaveBeenLastCalledWith(4);
  dispose();
  expect(unmount).toHaveBeenCalledTimes(1);
  expect(handle.current).toBeNull();
});
