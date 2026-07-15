import { describe, expect, it } from "vitest";
import {
  ENTRY_TO_GROUP,
  SETTINGS_GROUPS,
  SETTINGS_SEARCH_ENTRIES,
  groupIdForEntry,
  matchingGroupIds,
  matchingIds,
} from "./settingsSearch";

const t = (key: string) => key;

describe("settingsSearch groups", () => {
  it("maps every search entry to exactly one group", () => {
    const entryIds = SETTINGS_SEARCH_ENTRIES.map((e) => e.id);
    const grouped = SETTINGS_GROUPS.flatMap((g) => g.entryIds);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect(grouped.sort()).toEqual([...entryIds].sort());
    for (const id of entryIds) {
      expect(groupIdForEntry(id)).toBeTruthy();
      expect(ENTRY_TO_GROUP.get(id)).toBe(groupIdForEntry(id));
    }
  });

  it("returns ordered unique group ids for multi-group matches", () => {
    // "proxy" hits app-proxy (network) then ai-acp (ai).
    const ids = matchingIds("proxy", t);
    expect(ids).toEqual(["app-proxy", "ai-acp"]);
    expect(matchingGroupIds(ids)).toEqual(["network", "ai"]);
  });

  it("matches the sftp double-click settings entry under the terminal group", () => {
    // terms match via term.includes(query); identity `t` skips titleKeys.
    const ids = matchingIds("double click", t);
    expect(ids).toEqual(["sftp"]);
    expect(groupIdForEntry("sftp")).toBe("terminal");
  });

  it("preserves group order even when entry list is reordered", () => {
    expect(matchingGroupIds(["ai-acp", "app-proxy", "language"])).toEqual([
      "ai",
      "network",
      "general",
    ]);
  });
});
