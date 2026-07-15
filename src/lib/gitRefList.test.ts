import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  dateMs,
  getRecentBranchNames,
  pickRecentItems,
  rememberRecentBranch,
  rememberRecentTag,
  getRecentTagNames,
  sortByDateThenName,
  loadBranchCollapse,
  saveBranchCollapse,
} from "./gitRefList";

describe("sortByDateThenName", () => {
  it("sorts newest date first then name", () => {
    const items = [
      { name: "b", date: "2024-01-01T00:00:00Z" },
      { name: "a", date: "2025-06-01T00:00:00Z" },
      { name: "c", date: "2025-06-01T00:00:00Z" },
      { name: "old", date: null },
    ];
    expect(sortByDateThenName(items).map((item) => item.name)).toEqual(["a", "c", "b", "old"]);
  });
});

describe("pickRecentItems / rememberRecent*", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it("remembers branches MRU and picks existing ones first", () => {
    rememberRecentBranch("/repo", "feature");
    rememberRecentBranch("/repo", "main");
    expect(getRecentBranchNames("/repo")).toEqual(["main", "feature"]);

    const items = [
      { name: "feature", date: "2024-01-01T00:00:00Z" },
      { name: "main", date: "2023-01-01T00:00:00Z" },
      { name: "hotfix", date: "2025-01-01T00:00:00Z" },
      { name: "gone", date: "2025-02-01T00:00:00Z" },
    ];
    // remembered "gone" is not in items after filter — simulate removed branch
    rememberRecentBranch("/repo", "gone");
    rememberRecentBranch("/repo", "main");
    const recent = pickRecentItems(
      items.filter((item) => item.name !== "gone"),
      getRecentBranchNames("/repo"),
      3,
    );
    expect(recent.map((item) => item.name)).toEqual(["main", "feature", "hotfix"]);
  });

  it("tracks recent tags", () => {
    rememberRecentTag("/repo", "v1");
    rememberRecentTag("/repo", "v2");
    expect(getRecentTagNames("/repo")).toEqual(["v2", "v1"]);
  });
});

describe("collapse persistence", () => {
  beforeEach(() => window.localStorage.clear());

  it("round-trips branch collapse flags", () => {
    saveBranchCollapse({ recent: true, local: false, remote: true });
    expect(loadBranchCollapse()).toEqual({ recent: true, local: false, remote: true });
  });
});

describe("dateMs", () => {
  it("parses iso and returns 0 for empty", () => {
    expect(dateMs(null)).toBe(0);
    expect(dateMs("2024-05-01T12:00:00Z")).toBeGreaterThan(0);
  });
});
