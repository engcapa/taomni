import "@testing-library/jest-dom/vitest";
import { act, cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { TerminalKeybar } from "./TerminalKeybar";
import { NO_MODIFIERS, type Modifiers } from "./terminalKeys";

afterEach(() => { cleanup(); vi.useRealTimers(); });

function Harness({ onSend, disabled = false, appCursor = false }: { onSend: (data: string) => void; disabled?: boolean; appCursor?: boolean }) {
  const [modifiers, setModifiers] = useState<Modifiers>(NO_MODIFIERS);
  return <TerminalKeybar disabled={disabled} modifiers={modifiers} onModifiers={setModifiers} onSend={onSend} appCursor={() => appCursor} />;
}

it("sends left and right arrows, and follows application cursor mode", () => {
  const onSend = vi.fn();
  const { rerender } = render(<Harness onSend={onSend} />);
  fireEvent.click(screen.getByTestId("mobile-key-left"));
  fireEvent.click(screen.getByTestId("mobile-key-right"));
  rerender(<Harness onSend={onSend} appCursor />);
  fireEvent.click(screen.getByTestId("mobile-key-up"));
  expect(onSend.mock.calls.map(call => call[0])).toEqual(["\x1b[D", "\x1b[C", "\x1bOA"]);
});

it("arms Ctrl for exactly one key and shows it as pressed", () => {
  const onSend = vi.fn();
  render(<Harness onSend={onSend} />);
  const ctrl = screen.getByTestId("mobile-key-ctrl");
  fireEvent.click(ctrl);
  expect(ctrl).toHaveAttribute("aria-pressed", "true");
  expect(onSend).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId("mobile-key-right"));
  expect(ctrl).toHaveAttribute("aria-pressed", "false");
  fireEvent.click(screen.getByTestId("mobile-key-right"));
  expect(onSend.mock.calls.map(call => call[0])).toEqual(["\x1b[1;5C", "\x1b[C"]);
  fireEvent.click(ctrl); fireEvent.click(ctrl);
  expect(ctrl).toHaveAttribute("aria-pressed", "false");
});

it("repeats a held arrow, keeps its modifier, and does not add a key on release", () => {
  vi.useFakeTimers();
  const onSend = vi.fn();
  render(<Harness onSend={onSend} />);
  fireEvent.click(screen.getByTestId("mobile-key-alt"));
  const left = screen.getByTestId("mobile-key-left");
  fireEvent.pointerDown(left, { button: 0 });
  act(() => { vi.advanceTimersByTime(450 + 80 * 3); });
  fireEvent.pointerUp(left);
  fireEvent.click(left);
  act(() => { vi.advanceTimersByTime(1000); });
  expect(onSend.mock.calls.map(call => call[0])).toEqual(Array(4).fill("\x1b[1;3D"));
  // A later plain tap is a normal single key again.
  fireEvent.pointerDown(left, { button: 0 }); fireEvent.pointerUp(left); fireEvent.click(left);
  expect(onSend).toHaveBeenLastCalledWith("\x1b[D");
  expect(onSend).toHaveBeenCalledTimes(5);
});

it("keeps keyboard focus in the terminal and ignores keys while read-only", () => {
  const onSend = vi.fn();
  render(<Harness onSend={onSend} disabled />);
  const left = screen.getByTestId("mobile-key-left");
  expect(left).toBeDisabled();
  fireEvent.click(left);
  expect(onSend).not.toHaveBeenCalled();
  cleanup();
  render(<Harness onSend={onSend} />);
  const esc = screen.getByTestId("mobile-key-esc");
  const mouseDown = createEvent.mouseDown(esc);
  fireEvent(esc, mouseDown);
  expect(mouseDown.defaultPrevented).toBe(true);
});
