import { afterEach, describe, expect, it } from "vitest";
import { setLocale, t as translate } from "../../lib/i18n";
afterEach(() => setLocale("en"));
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
    // "proxy" also finds Mobile Web reverse-proxy domains in network settings.
    const ids = matchingIds("proxy", t);
    expect(ids).toEqual(["app-proxy", "mobile-service", "ai-acp"]);
    expect(matchingGroupIds(ids)).toEqual(["network", "ai"]);
  });

  it("matches the sftp double-click settings entry under the terminal group", () => {
    // terms match via term.includes(query); identity `t` skips titleKeys.
    const ids = matchingIds("double click", t);
    expect(ids).toEqual(["sftp"]);
    expect(groupIdForEntry("sftp")).toBe("terminal");
  });

  it("matches Kotlin toolchain settings under the code group", () => {
    const ids = matchingIds("kotlin", t);
    expect(ids).toEqual(["sdks"]);
    expect(groupIdForEntry("sdks")).toBe("code");
  });

  it.each(["en", "zh-CN"] as const)("finds mobile settings through localized visible titles in %s", locale => {
    setLocale(locale);
    for (const key of ["mobileSettings.title", "mobileSettings.allowOpenSessions", "mobileSettings.hostsTitle", "mobileSettings.allowAllHosts", "feishuSettings.title"]) {
      expect(matchingIds(translate(key), translate)).toContain("mobile-service");
    }
    expect(groupIdForEntry("mobile-service")).toBe("network");
  });

  it("preserves group order even when entry list is reordered", () => {
    expect(matchingGroupIds(["ai-acp", "app-proxy", "language"])).toEqual([
      "ai",
      "network",
      "general",
    ]);
  });
});
