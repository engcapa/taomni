import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Tab } from "../../types";
import { useExplorerStore } from "../../stores/explorerStore";
import { useExplorerUiStore } from "../../stores/explorerUiStore";
import { ExplorerTabsFilter } from "./ExplorerTabsFilter";

const folder = (index: number): Tab => ({
  id: `folder-${index}`,
  type: "file-browser",
  title: `Folder ${index}`,
  closable: true,
  fileBrowser: { initialPath: `/fixture/${index}`, explorer: true },
});
const viewer = (id: string, title: string, path: string): Tab => ({
  id,
  type: "file-viewer",
  title,
  closable: true,
  fileViewer: { path, kind: "text", mode: "source", source: "local" },
});

beforeEach(() => {
  localStorage.clear();
  useExplorerUiStore.getState().clearTabFilter();
  useExplorerStore.setState({
    tabs: [folder(1), folder(2), viewer("v1", "README.md", "/fixture/README.md")],
    activeTabId: "folder-1",
  });
});
afterEach(() => {
  cleanup();
  useExplorerStore.setState({ tabs: [], activeTabId: null });
  useExplorerUiStore.getState().clearTabFilter();
});

describe("ExplorerTabsFilter", () => {
  it("opens a searchable list of every open tab and activates a picked row", () => {
    render(<ExplorerTabsFilter />);
    const trigger = screen.getByTestId("explorer-tabs-filter-trigger");
    fireEvent.click(trigger);
    expect(screen.getByTestId("explorer-tabs-filter-menu")).toBeInTheDocument();
    expect(screen.getByTestId("explorer-tabs-filter-search")).toHaveFocus();
    expect(screen.getAllByTestId("explorer-tabs-filter-row")).toHaveLength(3);
    expect(screen.getByTestId("explorer-tab-filter-folders")).toHaveTextContent("2");
    expect(screen.getByTestId("explorer-tab-filter-files")).toHaveTextContent("1");
    fireEvent.change(screen.getByTestId("explorer-tabs-filter-search"), { target: { value: "readme" } });
    expect(screen.getAllByTestId("explorer-tabs-filter-row")).toHaveLength(1);
    expect(useExplorerUiStore.getState().tabFilter.query).toBe("readme");
    fireEvent.click(screen.getByTestId("explorer-tabs-filter-row"));
    expect(useExplorerStore.getState().activeTabId).toBe("v1");
    expect(screen.queryByTestId("explorer-tabs-filter-menu")).toBeNull();
  });

  it("applies category filters without closing tabs and auto-selects the first match", () => {
    render(<ExplorerTabsFilter />);
    fireEvent.click(screen.getByTestId("explorer-tabs-filter-trigger"));
    fireEvent.click(screen.getByTestId("explorer-tab-filter-files"));
    expect(useExplorerUiStore.getState().tabFilter).toEqual({ category: "files", query: "" });
    expect(useExplorerStore.getState().tabs).toHaveLength(3);
    expect(screen.getAllByTestId("explorer-tabs-filter-row")).toHaveLength(1);
    expect(useExplorerStore.getState().activeTabId).toBe("v1");
    expect(screen.getByTestId("explorer-tabs-filter-trigger")).toHaveAttribute("data-active", "true");
    fireEvent.click(screen.getByTestId("explorer-tabs-filter-clear"));
    expect(useExplorerUiStore.getState().tabFilter).toEqual({ category: "all", query: "" });
    expect(screen.getAllByTestId("explorer-tabs-filter-row")).toHaveLength(3);
  });

  it("supports keyboard highlighting, Enter activation and Escape focus restore", () => {
    render(<ExplorerTabsFilter />);
    const trigger = screen.getByTestId("explorer-tabs-filter-trigger");
    fireEvent.click(trigger);
    const search = screen.getByTestId("explorer-tabs-filter-search");
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    const highlighted = screen.getAllByTestId("explorer-tabs-filter-row")[1];
    expect(highlighted).toHaveAttribute("data-highlighted", "true");
    fireEvent.keyDown(search, { key: "Enter" });
    expect(useExplorerStore.getState().activeTabId).toBe("folder-2");
    expect(screen.queryByTestId("explorer-tabs-filter-menu")).toBeNull();
    fireEvent.click(trigger);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("explorer-tabs-filter-menu")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("reports an empty result and leaves no category match selected", () => {
    useExplorerStore.setState({ tabs: [folder(1)], activeTabId: "folder-1" });
    render(<ExplorerTabsFilter />);
    fireEvent.click(screen.getByTestId("explorer-tabs-filter-trigger"));
    fireEvent.change(screen.getByTestId("explorer-tabs-filter-search"), { target: { value: "nothing" } });
    expect(screen.queryAllByTestId("explorer-tabs-filter-row")).toHaveLength(0);
    expect(screen.getByTestId("explorer-tabs-filter-empty")).toBeInTheDocument();
    expect(useExplorerStore.getState().activeTabId).toBe("folder-1");
  });

  it("renders nothing when no Explorer tab is open", () => {
    useExplorerStore.setState({ tabs: [], activeTabId: null });
    const { container } = render(<ExplorerTabsFilter />);
    expect(container).toBeEmptyDOMElement();
  });
});
