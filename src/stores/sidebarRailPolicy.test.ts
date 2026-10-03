import { afterEach, describe, expect, it } from "vitest";
import {
  MERGE_TOOL_WINDOW_RAIL_KEY,
  SIDEBAR_COLLAPSED_BY_GROUP_KEY,
  readMergeToolWindowRail,
  readSidebarCollapsedByGroup,
  sidebarRailGroup,
  writeMergeToolWindowRail,
  writeSidebarCollapsedByGroup,
} from "./sidebarRailPolicy";

afterEach(() => window.localStorage.clear());

describe("ED-PARITY-027 sidebar rail policy", () => {
  it("groups Code Workspace and terminal tabs; everything else shares one group", () => {
    expect(sidebarRailGroup("code-workspace")).toBe("code-workspace");
    expect(sidebarRailGroup("terminal")).toBe("terminal");
    expect(sidebarRailGroup("sftp")).toBe("other");
    expect(sidebarRailGroup("welcome")).toBe("other");
    expect(sidebarRailGroup(undefined)).toBe("other");
  });

  it("defaults to a merged bar with tool-window groups collapsed", () => {
    expect(readMergeToolWindowRail()).toBe(true);
    expect(readSidebarCollapsedByGroup(false)).toEqual({ "code-workspace": true, terminal: true, other: false });
    expect(readSidebarCollapsedByGroup(true).other).toBe(true);
  });

  it("round-trips the preferences and ignores malformed storage", () => {
    writeMergeToolWindowRail(false);
    expect(window.localStorage.getItem(MERGE_TOOL_WINDOW_RAIL_KEY)).toBe("false");
    expect(readMergeToolWindowRail()).toBe(false);
    writeSidebarCollapsedByGroup({ "code-workspace": false, terminal: true, other: true });
    // "other" is never stored here: it is the legacy key passed in.
    expect(JSON.parse(window.localStorage.getItem(SIDEBAR_COLLAPSED_BY_GROUP_KEY) ?? "null"))
      .toEqual({ "code-workspace": false, terminal: true });
    expect(readSidebarCollapsedByGroup(false)).toEqual({ "code-workspace": false, terminal: true, other: false });
    window.localStorage.setItem(SIDEBAR_COLLAPSED_BY_GROUP_KEY, JSON.stringify({ other: true }));
    expect(readSidebarCollapsedByGroup(false).other).toBe(false);
    window.localStorage.setItem(SIDEBAR_COLLAPSED_BY_GROUP_KEY, "{not json");
    expect(readSidebarCollapsedByGroup(false)).toEqual({ "code-workspace": true, terminal: true, other: false });
    window.localStorage.setItem(SIDEBAR_COLLAPSED_BY_GROUP_KEY, JSON.stringify({ terminal: "yes" }));
    expect(readSidebarCollapsedByGroup(false).terminal).toBe(true);
  });
});
