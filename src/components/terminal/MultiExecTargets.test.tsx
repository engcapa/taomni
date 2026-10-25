import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useAppStore } from "../../stores/appStore";
import { MultiExecTargets } from "./MultiExecTargets";

beforeEach(() => useAppStore.setState({
  tabs: [
    { id: "a", type: "terminal", title: "QA Alpha", closable: true },
    { id: "b", type: "terminal", title: "QA Beta", closable: true },
    { id: "db", type: "database", title: "DB", closable: true },
  ],
  activeTabId: "a", activeSideTab: "sessions", multiExecActive: true,
  multiExecSelectedTabIds: new Set(), terminalSplitActive: false,
  terminalSplitInputLockedTabIds: new Set(), tabFilter: { kind: "protocol", protocol: "ssh" },
}));
afterEach(cleanup);

it("selects filtered-out terminals without changing the active tab or clearing its filter", () => {
  render(<MultiExecTargets selectedCount={0} totalCount={2} />);
  fireEvent.click(screen.getByTestId("multiexec-targets"));
  expect(screen.getAllByTestId("multiexec-target-checkbox")).toHaveLength(2);
  fireEvent.change(screen.getByTestId("multiexec-target-search"), { target: { value: "Beta" } });
  fireEvent.click(screen.getByTestId("multiexec-target-checkbox"));
  expect(useAppStore.getState().multiExecSelectedTabIds).toEqual(new Set(["b"]));
  expect(useAppStore.getState().activeTabId).toBe("a");
  expect(useAppStore.getState().tabFilter).toEqual({ kind: "protocol", protocol: "ssh" });
  fireEvent.keyDown(screen.getByTestId("multiexec-target-search"), { key: "Escape" });
  expect(screen.queryByTestId("multiexec-target-menu")).not.toBeInTheDocument();
  expect(useAppStore.getState().multiExecActive).toBe(true);
});

it("explains locked split inputs and recovers from a search with no matches", () => {
  useAppStore.setState({ terminalSplitActive: true, terminalSplitInputLockedTabIds: new Set(["b"]) });
  render(<MultiExecTargets selectedCount={0} totalCount={2} />);
  fireEvent.click(screen.getByTestId("multiexec-targets"));
  expect(screen.getAllByTestId("multiexec-target-checkbox")[1]).toBeDisabled();
  fireEvent.change(screen.getByTestId("multiexec-target-search"), { target: { value: "missing" } });
  expect(screen.getByTestId("multiexec-target-empty")).toBeVisible();
  fireEvent.change(screen.getByTestId("multiexec-target-search"), { target: { value: "Alpha" } });
  fireEvent.click(screen.getByTestId("multiexec-target-checkbox"));
  expect(useAppStore.getState().multiExecSelectedTabIds).toEqual(new Set(["a"]));
});
