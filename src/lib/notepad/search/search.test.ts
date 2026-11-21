import { beforeEach, describe, expect, it } from "vitest";
import {
  expandMatchReplacement,
  findAllMatches,
  findNextMatch,
  hasCatastrophicBacktrackingRisk,
  readSearchHistory,
  recordSearchHistory,
  replaceAllInText,
  resetSearchHistoryForTests,
  toSearchResultHits,
} from "./engine";

describe("notepad search engine (V-18..V-24)", () => {
  beforeEach(() => {
    localStorage.clear();
    resetSearchHistoryForTests();
  });

  it("supports Normal, Extended (\\n \\t \\xNN), and RegEx capture replacement (V-18, V-19, V-20)", () => {
    const ext = findAllMatches("a\tb\nc", {
      query: "\\t",
      mode: "ext",
      caseSensitive: true,
      wholeWord: false,
      dotAll: false,
    });
    expect(ext.matches).toHaveLength(1);
    expect(ext.matches[0]).toMatchObject({ from: 1, to: 2 });

    const rep = replaceAllInText("key=10\nkey=25", {
      query: "([a-z]+)=(\\d+)",
      replace: "$1:$2",
      mode: "re",
      caseSensitive: true,
      wholeWord: false,
      wrapAround: true,
      backward: false,
      inSelection: false,
      dotAll: false,
    });
    expect(rep).toEqual({ text: "key:10\nkey:25", count: 2 });

    // DotAll match across newlines
    const dotAll = findAllMatches("start\nend", {
      query: "start.*end",
      mode: "re",
      caseSensitive: true,
      wholeWord: false,
      dotAll: true,
    });
    expect(dotAll.matches).toHaveLength(1);
  });

  it("handles Wrap Around, Backward, In Selection, Whole Word, and Result Hits (V-21, V-22)", () => {
    const text = "foo bar foo baz foo";
    const fwd = findNextMatch(
      text,
      { query: "foo", mode: "normal", caseSensitive: false, wholeWord: true, wrapAround: true, backward: false, inSelection: false, dotAll: false },
      { from: 17, to: 17 },
    );
    expect(fwd).toMatchObject({ wrapped: true, match: { from: 0, to: 3 } });

    const inSel = replaceAllInText(
      text,
      { query: "foo", replace: "X", mode: "normal", caseSensitive: true, wholeWord: true, wrapAround: false, backward: false, inSelection: true, dotAll: false },
      { from: 4, to: 14 },
    );
    expect(inSel.text).toBe("foo bar X baz foo");
    expect(inSel.count).toBe(1);

    const hits = toSearchResultHits({ docId: "d1", name: "a.txt" }, "one\ntwo foo", [
      { from: 8, to: 11, text: "foo", groups: [] },
    ]);
    expect(hits).toEqual([
      { docId: "d1", filePath: undefined, name: "a.txt", line: 1, column: 4, from: 8, to: 11, lineText: "two foo", matchLength: 3 },
    ]);
  });

  it("blocks catastrophic backtracking regexes safely without hanging (V-23) and expands \\n in re replacement", () => {
    expect(hasCatastrophicBacktrackingRisk("(a+)+b")).toBe(true);
    expect(hasCatastrophicBacktrackingRisk("([a-z0-9]+)*$")).toBe(true);
    expect(hasCatastrophicBacktrackingRisk("\\(a\\+\\)+b")).toBe(false);

    const res = findAllMatches("aaaaaaaaaaaaaaaaaaaaaaaaaaaac", {
      query: "(a+)+b",
      mode: "re",
      caseSensitive: true,
      wholeWord: false,
      dotAll: false,
    });
    expect(res.timedOut).toBe(true);
    expect(res.error).toContain("catastrophic backtracking");

    const expanded = expandMatchReplacement(
      { from: 0, to: 2, text: "ab", groups: ["a"] },
      "$1\\nX",
      "re",
    );
    expect(expanded).toBe("a\nX");
  });

  it("reuses unified search history storage", () => {
    recordSearchHistory("find", "needle-one");
    recordSearchHistory("find", "needle-two");
    expect(readSearchHistory("find")).toEqual(["needle-two", "needle-one"]);
  });
});
