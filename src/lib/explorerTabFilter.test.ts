import { describe, expect, it } from "vitest";
import type { Tab } from "../types";
import {
  EMPTY_EXPLORER_TAB_FILTER,
  explorerTabCategory,
  explorerTabPath,
  filterExplorerTabs,
  hasExplorerTabFilter,
} from "./explorerTabFilter";

const folder = (id: string, title: string, path: string): Tab => ({
  id, type: "file-browser", title, closable: true, fileBrowser: { initialPath: path, explorer: true },
});
const viewer = (id: string, title: string, path: string): Tab => ({
  id, type: "file-viewer", title, closable: true, fileViewer: { path, kind: "text", mode: "source", source: "local" },
});
const tabs = [
  folder("f1", "Downloads", "/home/me/Downloads"),
  folder("f2", "workspace", "/data/Project Workspace"),
  viewer("v1", "README.md", "/data/Project Workspace/README.md"),
  viewer("v2", "notes", "untitled:1"),
];

describe("explorerTabFilter", () => {
  it("maps folder and viewer tabs to the two explorer categories", () => {
    expect(explorerTabCategory(tabs[0])).toBe("folders");
    expect(explorerTabCategory(tabs[2])).toBe("files");
    expect(explorerTabPath(tabs[1])).toBe("/data/Project Workspace");
    expect(explorerTabPath(tabs[2])).toBe("/data/Project Workspace/README.md");
    expect(explorerTabPath(tabs[3])).toBe("untitled:1");
  });

  it("returns every tab for the empty filter and keeps their order", () => {
    expect(filterExplorerTabs(tabs, EMPTY_EXPLORER_TAB_FILTER)).toEqual(tabs);
    expect(hasExplorerTabFilter(EMPTY_EXPLORER_TAB_FILTER)).toBe(false);
  });

  it("filters by category without dropping the other category", () => {
    const folders = filterExplorerTabs(tabs, { category: "folders", query: "" });
    expect(folders.map((tab) => tab.id)).toEqual(["f1", "f2"]);
    expect(hasExplorerTabFilter({ category: "folders", query: "" })).toBe(true);
  });

  it("matches title, initial folder path and viewer path case-insensitively", () => {
    expect(filterExplorerTabs(tabs, { category: "all", query: "readme" }).map((tab) => tab.id)).toEqual(["v1"]);
    expect(filterExplorerTabs(tabs, { category: "all", query: "downloads" }).map((tab) => tab.id)).toEqual(["f1"]);
    expect(filterExplorerTabs(tabs, { category: "all", query: "project workspace" }).map((tab) => tab.id)).toEqual(["f2", "v1"]);
    expect(filterExplorerTabs(tabs, { category: "all", query: "  " })).toEqual(tabs);
  });

  it("combines the category and query and reports no match", () => {
    expect(filterExplorerTabs(tabs, { category: "files", query: "project" }).map((tab) => tab.id)).toEqual(["v1"]);
    expect(filterExplorerTabs(tabs, { category: "folders", query: "readme" })).toEqual([]);
    expect(hasExplorerTabFilter({ category: "all", query: "x" })).toBe(true);
  });
});
