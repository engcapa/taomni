import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ZmodemConflictDialog } from "./ZmodemConflictDialog";

afterEach(cleanup);

it("skips an existing download on Enter and overwrites only after explicit selection", async () => {
  const user = userEvent.setup();
  const resolve = vi.fn();
  render(<ZmodemConflictDialog mode="receive" fileName="report.txt" hasMore onResolve={resolve} />);
  expect(screen.getByRole("dialog")).toHaveTextContent("report.txt");
  expect(screen.getByTestId("zmodem-skip")).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(resolve).toHaveBeenLastCalledWith({ type: "skip", applyToAll: false });
  await user.click(screen.getByRole("checkbox"));
  await user.click(screen.getByTestId("zmodem-overwrite"));
  expect(resolve).toHaveBeenLastCalledWith({ type: "overwrite", applyToAll: true });
});

it("does not offer remote overwrite and Escape skips a single upload conflict", async () => {
  const user = userEvent.setup();
  const resolve = vi.fn();
  render(<ZmodemConflictDialog mode="send" fileName="report.txt" hasMore={false} onResolve={resolve} />);
  expect(screen.queryByTestId("zmodem-overwrite")).toBeNull();
  expect(screen.queryByRole("checkbox")).toBeNull();
  await user.keyboard("{Escape}");
  expect(resolve).toHaveBeenCalledExactlyOnceWith({ type: "skip", applyToAll: false });
});
