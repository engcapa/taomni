import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { setLocale } from "../../../lib/i18n";
import { HistoryPopover } from "./HistoryPopover";

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
