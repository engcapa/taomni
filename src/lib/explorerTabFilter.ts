import type { Tab } from "../types";

export type ExplorerTabCategory = "all" | "folders" | "files";

export interface ExplorerTabFilter {
  category: ExplorerTabCategory;
  query: string;
}

export const EMPTY_EXPLORER_TAB_FILTER: ExplorerTabFilter = { category: "all", query: "" };

export const EXPLORER_TAB_CATEGORIES: readonly ExplorerTabCategory[] = ["all", "folders", "files"];

/** Explorer surface owns folder tabs and the file viewers opened from it. */
export function explorerTabCategory(tab: Tab): Exclude<ExplorerTabCategory, "all"> {
  return tab.type === "file-browser" ? "folders" : "files";
}

export function explorerTabPath(tab: Tab): string {
  return tab.fileBrowser?.initialPath ?? tab.fileViewer?.path ?? "";
}

export function filterExplorerTabs(tabs: readonly Tab[], filter: ExplorerTabFilter): Tab[] {
  const query = filter.query.trim().toLocaleLowerCase();
  return tabs.filter((tab) => (
    (filter.category === "all" || explorerTabCategory(tab) === filter.category)
    && (!query || [tab.title, explorerTabPath(tab), tab.fileViewer?.title]
      .some((value) => value?.toLocaleLowerCase().includes(query)))
  ));
}

export function hasExplorerTabFilter(filter: ExplorerTabFilter): boolean {
  return filter.category !== "all" || Boolean(filter.query.trim());
}
