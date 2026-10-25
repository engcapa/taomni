import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useTransferStore } from "../../stores/transferStore";
import { FileTransferQueue } from "./FileTransferQueue";

vi.mock("../../lib/i18n", () => ({ useT: () => (key: string) => key }));

afterEach(() => {
  cleanup();
  useTransferStore.setState({ items: [] });
  localStorage.clear();
});

it("restores progress and resume feedback when the queue view reopens", () => {
  useTransferStore.setState({ items: [{
    id: "transfer", sessionId: "ssh", direction: "download", kind: "file",
    localPath: "/local/file", remotePath: "/remote/file", size: 100,
    bytes: 70, rate: 0, eta: 0, state: "running", startedAt: 0,
    phase: "verifying", resumeBytes: 30, restarted: false,
  }] });
  const view = render(<FileTransferQueue onCancel={vi.fn()} />);
  expect(screen.getByText("fileBrowser.transferVerifying")).toBeInTheDocument();
  expect(screen.getByText(/fileBrowser.transferResumed/)).toBeInTheDocument();
  view.unmount();
  render(<FileTransferQueue onCancel={vi.fn()} />);
  expect(screen.getByText("fileBrowser.transferVerifying")).toBeInTheDocument();
  act(() => useTransferStore.getState().patch("transfer", {
    state: "done", bytes: 100, restarted: true, resumeBytes: 0,
  }));
  expect(screen.queryByText("fileBrowser.transferVerifying")).not.toBeInTheDocument();
  expect(screen.queryByText(/fileBrowser.transferResumed/)).not.toBeInTheDocument();
  expect(screen.getByText("fileBrowser.transferRestarted")).toBeInTheDocument();
});
