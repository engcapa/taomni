import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastStack, useToastQueue } from "./Toast";

function Harness() {
  const queue = useToastQueue();
  return <>
    {["one", "two", "three", "four"].map((message) => <button type="button" key={message}
      onClick={() => queue.publish({ message, error: message === "two" })}>Publish {message}</button>)}
    <ToastStack {...queue} closeLabel="Dismiss" paused={false} />
  </>;
}
const elapsed = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const publish = (message: string) => fireEvent.click(screen.getByText("Publish " + message));

describe("desktop notifications", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("shows three entries, merges identical passive messages, and starts the queued timer on display", () => {
    render(<Harness />);
    ["one", "two", "three", "four", "two"].forEach(publish);
    expect(screen.getByRole("alert")).toHaveTextContent("two (×2)");
    expect(screen.queryByText("four")).toBeNull();
    elapsed(4000);
    expect(screen.getByRole("status")).toHaveTextContent("four");
    elapsed(4000);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("two");
    fireEvent.keyDown(screen.getByRole("alert"), { key: "Escape" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("preserves the remaining time across overlapping pointer and keyboard pauses", () => {
    render(<Harness />);
    publish("one");
    elapsed(2000);
    const toast = screen.getByRole("status");
    fireEvent.mouseEnter(toast);
    elapsed(8000);
    act(() => toast.focus());
    fireEvent.mouseLeave(toast);
    elapsed(5000);
    expect(toast).toBeInTheDocument();
    act(() => screen.getByText("Publish one").focus());
    elapsed(1999);
    expect(toast).toBeInTheDocument();
    elapsed(1);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
