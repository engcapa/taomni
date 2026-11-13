import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { WorkspaceTabStrip } from "../WorkspaceTabStrip";
import { DEFAULT_WORKSPACE_ID, useWorkspacePlatformStore } from "../../../stores/workspacePlatformStore";
import { useWorkspaceUiStore } from "../../../stores/workspaceUiStore";

beforeEach(() => {
  localStorage.clear();
  useWorkspacePlatformStore.getState().reloadFromStorage();
  useWorkspaceUiStore.setState({ tabFilters: {} });
});
afterEach(cleanup);

it("uses the shared prototype folder for Explorer without replacing other workspace kind badges", () => {
  const store = useWorkspacePlatformStore.getState();
  const explorer = store.addExplorerTab(DEFAULT_WORKSPACE_ID, "/project");
  const terminal = store.openLocalTerminalInWorkspace(DEFAULT_WORKSPACE_ID);
  render(<WorkspaceTabStrip />);
  const tabs = screen.getAllByTestId("workspace-tab");
  const filesTab = tabs.find((tab) => tab.dataset.tabId === explorer.id)!;
  const terminalTab = tabs.find((tab) => tab.dataset.tabId === terminal.id)!;
  expect(filesTab.querySelector(".taomni-explorer-tab-icon path")).toHaveAttribute("fill", "var(--ex-folder)");
  expect(filesTab).not.toHaveTextContent("EXPL");
  expect(terminalTab).toHaveTextContent("TERM");
  expect(terminalTab.querySelector(".taomni-explorer-tab-icon")).toBeNull();
});
