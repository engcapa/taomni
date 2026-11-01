import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TerminalComposer } from "./TerminalComposer";

afterEach(cleanup);

it("keeps a failed command for retry and sends empty Enter explicitly", () => {
  const send = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
  render(<TerminalComposer disabled={false} panelOpen onSend={send} onNotice={vi.fn()} />);
  const command = screen.getByTestId("mobile-terminal-command");
  fireEvent.change(command, { target: { value: "echo 中文" } });
  fireEvent.submit(command.closest("form")!);
  expect(command).toHaveValue("echo 中文");
  fireEvent.submit(command.closest("form")!);
  expect(command).toHaveValue("");
  expect(screen.getByTestId("mobile-terminal-history")).toHaveTextContent("echo 中文");
  fireEvent.submit(command.closest("form")!);
  expect(send.mock.calls).toEqual([["echo 中文", true], ["echo 中文", true], ["", true]]);
});

it("does not send a partially composed Chinese command when Enter accepts an IME candidate", () => {
  const send = vi.fn(() => true);
  render(<TerminalComposer disabled={false} panelOpen={false} onSend={send} onNotice={vi.fn()} />);
  const command = screen.getByTestId("mobile-terminal-command");
  fireEvent.change(command, { target: { value: "echo 中" } });
  fireEvent.compositionStart(command);
  fireEvent.keyDown(command, { key: "Enter", keyCode: 229, isComposing: true });
  fireEvent.submit(command.closest("form")!);
  expect(send).not.toHaveBeenCalled();
  expect(command).toHaveValue("echo 中");
  fireEvent.compositionEnd(command);
  fireEvent.submit(command.closest("form")!);
  expect(send).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledWith("echo 中", true);
});

it("multi-line paste never executes until its explicit send button is pressed", () => {
  const send = vi.fn(() => true);
  render(<TerminalComposer disabled={false} panelOpen onSend={send} onNotice={vi.fn()} />);
  fireEvent.change(screen.getByTestId("mobile-terminal-input"), { target: { value: "first\nsecond" } });
  expect(send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId("mobile-terminal-send"));
  expect(send).toHaveBeenCalledWith("first\nsecond", false);
  fireEvent.click(screen.getByTestId("mobile-terminal-history"));
  expect(screen.getByTestId("mobile-terminal-input")).toHaveValue("first\nsecond");
  fireEvent.click(screen.getByTestId("mobile-terminal-send-enter"));
  expect(send).toHaveBeenLastCalledWith("first\nsecond", true);
});
