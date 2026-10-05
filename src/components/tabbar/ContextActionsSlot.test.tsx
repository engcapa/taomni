import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ContextActionsSlot } from "./ContextActionsSlot";

afterEach(cleanup);

it("focuses the live actions and returns to the trigger on Escape without replacing the portal host", () => {
  const ref = vi.fn();
  const { rerender } = render(<ContextActionsSlot slotRef={ref} hidden={false} owner="terminal" />);
  const host = screen.getByTestId("tab-action-slot");
  const action = document.createElement("button");
  action.textContent = "Detach";
  host.append(action);
  const trigger = screen.getByTestId("tab-actions-more");
  fireEvent.click(trigger);
  expect(action).toHaveFocus();
  fireEvent.keyDown(action, { key: "Escape" });
  expect(trigger).toHaveFocus();
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(trigger);
  rerender(<ContextActionsSlot slotRef={ref} hidden={false} owner="rdp" />);
  expect(screen.getByTestId("tab-action-slot")).toBe(host);
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(ref).toHaveBeenCalledTimes(1);
});
