import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CompactKeyboard } from "./CompactKeyboard";
import { NO_MODIFIERS } from "./terminalKeys";

afterEach(cleanup);
it("types directly without focusing an editable field, including shift, symbols, space and Enter", () => {
  const send = vi.fn();
  render(<CompactKeyboard disabled={false} modifiers={NO_MODIFIERS} onSend={send} />);
  fireEvent.click(screen.getByTestId("mobile-type-q"));
  fireEvent.click(screen.getByRole("button", { name: "Shift" }));
  fireEvent.click(screen.getByTestId("mobile-type-A"));
  fireEvent.click(screen.getByRole("button", { name: "切换数字符号" }));
  fireEvent.click(screen.getByTestId("mobile-type-1"));
  fireEvent.click(screen.getByRole("button", { name: "Shift" }));
  fireEvent.click(screen.getByTestId("mobile-type-!"));
  fireEvent.click(screen.getByTestId("mobile-type-space"));
  fireEvent.click(screen.getByTestId("mobile-type-backspace"));
  fireEvent.click(screen.getByTestId("mobile-type-enter"));
  expect(send.mock.calls.map(v => v[0])).toEqual(["q", "A", "1", "!", " ", "\x7f", "\r"]);
  expect(document.activeElement?.matches("input,textarea")).toBe(false);
});
it("uses the terminal's armed modifiers and blocks input when disabled", () => {
  const send = vi.fn();
  const { rerender } = render(<CompactKeyboard disabled={false} modifiers={{ ctrl: true, alt: true }} onSend={send} />);
  fireEvent.click(screen.getByTestId("mobile-type-c"));
  expect(send).toHaveBeenLastCalledWith("\x1b\x03");
  rerender(<CompactKeyboard disabled modifiers={NO_MODIFIERS} onSend={send} />);
  fireEvent.click(screen.getByTestId("mobile-type-c"));
  expect(send).toHaveBeenCalledOnce();
});
