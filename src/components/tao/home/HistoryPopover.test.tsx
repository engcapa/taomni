import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { setLocale } from "../../../lib/i18n";
import { HistoryPopover } from "./HistoryPopover";
import { TaoPopover, useTaoPopover } from "../ai-chat/Popover";

afterEach(() => { cleanup(); setLocale("en"); });

it("translates history chrome while preserving user titles that match dictionary keys", () => {
  setLocale("en");
  const props = { threads: [{ id: "thread", title: "来源", messages: [], updatedAt: 1 }], sessions: [],
    workspaces: [{ id: "workspace", name: "文件", roots: [], looseFiles: [], lastOpenedAt: 1, isGitRepo: false }],
    demoMode: false, onSelectThread: vi.fn(), onNewThread: vi.fn(), onClose: vi.fn() };
  const { rerender } = render(<HistoryPopover {...props} />);
  expect(screen.getByText("History")).toBeInTheDocument();
  expect(screen.getByTestId("tao-home-history-row")).toHaveTextContent("来源");
  fireEvent.click(screen.getByTestId("tao-home-history-tab-workspaces"));
  expect(screen.getByTestId("tao-home-history-row")).toHaveTextContent("文件");
  rerender(<HistoryPopover {...props} demoMode />);
  expect(screen.getByTestId("tao-home-history-row")).toHaveTextContent("Workspace 1");
  expect(screen.queryByText("文件")).not.toBeInTheDocument();
});

function DeletableHistory({ onDeleteThread = vi.fn(async () => undefined), demoMode = false, running = false }) {
  const owner = useTaoPopover();
  return <><button ref={owner.triggerRef} onClick={() => owner.setOpen(!owner.open)}>History trigger</button>
    <TaoPopover owner={owner} label="History"><HistoryPopover threads={[{ id: "thread", title: "Private thread", messages: [], updatedAt: 1, running }]}
      sessions={[]} workspaces={[]} demoMode={demoMode} onSelectThread={vi.fn()} onNewThread={vi.fn()} onClose={() => owner.close()} onDeleteThread={onDeleteThread} /></TaoPopover></>;
}

it("requires confirmation, lets Escape cancel only the confirmation and dispatches one delete", async () => {
  const remove = vi.fn(async () => undefined);
  render(<DeletableHistory onDeleteThread={remove} />);
  fireEvent.click(screen.getByText("History trigger"));
  fireEvent.click(screen.getByTestId("tao-home-history-delete"));
  expect(screen.getByTestId("confirm-dialog-message")).toHaveTextContent("Private thread");
  expect(remove).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByTestId("confirm-dialog-cancel"), { key: "Escape" });
  expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument();
  expect(screen.getByTestId("tao-home-history-delete")).toHaveFocus();
  expect(screen.getByTestId("tao-home-history-popover")).toBeVisible();
  fireEvent.click(screen.getByTestId("tao-home-history-delete"));
  fireEvent.click(screen.getByTestId("confirm-dialog-cancel"));
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId("tao-home-history-delete"));
  fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));
  await waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
  expect(remove).toHaveBeenCalledWith(expect.objectContaining({ id: "thread" }));
});

it("keeps a failed row available for retry and does not expose its title in presentation mode", async () => {
  const remove = vi.fn(async () => { throw new Error("storage unavailable"); });
  render(<DeletableHistory onDeleteThread={remove} demoMode />);
  fireEvent.click(screen.getByText("History trigger"));
  fireEvent.click(screen.getByTestId("tao-home-history-delete"));
  expect(screen.getByTestId("confirm-dialog-message")).toHaveTextContent("Chat 1");
  expect(screen.queryByText(/Private thread/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));
  expect(await screen.findByRole("alert")).toHaveTextContent("storage unavailable");
  expect(screen.getByTestId("tao-home-history-delete")).toBeEnabled();
});

it("disables deletion during streaming", () => {
  render(<DeletableHistory running />);
  fireEvent.click(screen.getByText("History trigger"));
  expect(screen.getByTestId("tao-home-history-delete")).toBeDisabled();
});
