import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommitMessageHover } from "./CommitMessageHover";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("CommitMessageHover", () => {
  it("shows a selectable sticky popup on hover and closes on Escape", () => {
    render(
      <CommitMessageHover
        openDelayMs={100}
        closeDelayMs={50}
        content={{
          subject: "Fix branch filter",
          body: "Add search and sort.",
          meta: "abc1234 · Ada · yesterday",
        }}
      >
        <button type="button">commit row</button>
      </CommitMessageHover>,
    );

    fireEvent.mouseEnter(screen.getByText("commit row").parentElement!);
    act(() => {
      vi.advanceTimersByTime(100);
    });

    const popup = screen.getByTestId("commit-message-hover");
    expect(popup).toBeInTheDocument();
    expect(popup).toHaveTextContent("Fix branch filter");
    expect(popup).toHaveTextContent("Add search and sort.");
    expect(popup.querySelector(".select-text")).toBeTruthy();

    // Moving onto the popup keeps it open past the close delay.
    fireEvent.mouseLeave(screen.getByText("commit row").parentElement!);
    fireEvent.mouseEnter(popup);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByTestId("commit-message-hover")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("commit-message-hover")).not.toBeInTheDocument();
  });

  it("closes when clicking outside", () => {
    render(
      <div>
        <CommitMessageHover
          openDelayMs={0}
          closeDelayMs={50}
          content={{ subject: "Hello" }}
        >
          <span>row</span>
        </CommitMessageHover>
        <button type="button">outside</button>
      </div>,
    );

    fireEvent.mouseEnter(screen.getByText("row").parentElement!);
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(screen.getByTestId("commit-message-hover")).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByText("outside"));
    expect(screen.queryByTestId("commit-message-hover")).not.toBeInTheDocument();
  });
});
