import { describe, expect, it } from "vitest";
import {
  dedupeAdjacentLines,
  dedupeLines,
  duplicateLine,
  insertBlankLineAbove,
  insertBlankLineBelow,
  joinLines,
  moveSelectedLines,
  removeBlankLines,
  removeEmptyLines,
  reverseLines,
  shuffleLines,
  splitLinesAtColumn,
} from "./lines";
import { sortLines, sortLinesList } from "./sort";
import { convertCaseRange, convertCaseText } from "./case";
import {
  eolToSpace,
  spacesToTabsAll,
  spacesToTabsLeading,
  tabsToSpaces,
  trimBothSpaces,
  trimLeadingSpaces,
  trimTrailingSpaces,
} from "./whitespace";
import { applyColumnInsert, formatColumnCell, previewColumnCells } from "./column";
import { buildSearchRegExp, resolveReplacementText, unescapeExtended, validateSearchPattern } from "./escape";
import { formatDateTimeCustom, redactText, runMimeTransform } from "./mime";

describe("notepad pure line transforms (V-04)", () => {
  it("duplicates, moves, joins, splits, and inserts blank lines", () => {
    expect(duplicateLine("alpha\nbeta", { from: 1, to: 1 }).text).toBe("alpha\nalpha\nbeta");
    expect(moveSelectedLines("one\ntwo\nthree", { from: 4, to: 7 }, -1).text).toBe("two\none\nthree");
    expect(moveSelectedLines("one\ntwo\nthree", { from: 1, to: 1 }, 1).text).toBe("two\none\nthree");
    expect(joinLines("  foo  \n  bar\n  baz", { from: 0, to: 19 }).text).toBe("  foo bar baz");
    expect(splitLinesAtColumn("hello world test", { from: 0, to: 0 }, 11).text).toBe("hello world\ntest");
    expect(insertBlankLineAbove("a\nb", { from: 2, to: 2 }).text).toBe("a\n\nb");
    expect(insertBlankLineBelow("a\nb", { from: 0, to: 0 }).text).toBe("a\n\nb");
  });

  it("dedupes, removes empty/blank lines, reverses, and deterministically shuffles", () => {
    const sample = "a\na\nb\n\n  \na\nc";
    expect(dedupeLines(sample, { from: 0, to: 0 }).text).toBe("a\nb\n\n  \nc");
    expect(dedupeAdjacentLines(sample, { from: 0, to: 0 }).text).toBe("a\nb\n\n  \na\nc");
    expect(removeEmptyLines(sample, { from: 0, to: 0 }).text).toBe("a\na\nb\n  \na\nc");
    expect(removeBlankLines(sample, { from: 0, to: 0 }).text).toBe("a\na\nb\na\nc");
    expect(reverseLines("1\n2\n3", { from: 0, to: 0 }).text).toBe("3\n2\n1");

    const seq = [0.2, 0.7, 0.1];
    let idx = 0;
    const shuffled = shuffleLines("a\nb\nc\nd", { from: 0, to: 0 }, true, () => seq[idx++ % seq.length]);
    expect(shuffled.text.split("\n").sort()).toEqual(["a", "b", "c", "d"]);
  });
});

describe("notepad stable sorting across 7 modes (V-03)", () => {
  it("sorts lexicographically, case-insensitively, locale-aware, integers, decimals, and line lengths stably", () => {
    expect(sortLinesList(["b", "A", "a", "B"], { kind: "lex" })).toEqual(["A", "B", "a", "b"]);
    expect(sortLinesList(["b1", "a2", "A1", "B2"], { kind: "ci" })).toEqual(["A1", "a2", "b1", "B2"]);
    expect(sortLinesList(["b", "A", "a", "B"], { kind: "ci" })).toEqual(["A", "a", "b", "B"]);
    expect(sortLinesList(["a", "A"], { kind: "ci" })).toEqual(["a", "A"]);
    expect(sortLinesList(["10", "2", "-3", "100"], { kind: "int" })).toEqual(["-3", "2", "10", "100"]);
    expect(sortLinesList(["10", "2", "-3", "100"], { kind: "int", descending: true })).toEqual(["100", "10", "2", "-3"]);
    expect(sortLinesList(["v 1,50", "v 1,2", "v -0,4"], { kind: "dc" })).toEqual(["v -0,4", "v 1,2", "v 1,50"]);
    expect(sortLinesList(["10.5", "2.75", "-1.25"], { kind: "dd" })).toEqual(["-1.25", "2.75", "10.5"]);
    expect(sortLinesList(["xxx", "a", "yy", "b"], { kind: "len" })).toEqual(["a", "b", "yy", "xxx"]);
    const loc = sortLinesList(["北京", "上海", "广州"], { kind: "loc", locale: "zh" });
    expect(loc).toHaveLength(3);
  });

  it("preserves equality stability and supports column-key sorting", () => {
    const lines = ["row1 20 first", "row2 10 second", "row3 20 third"];
    const sorted = sortLinesList(lines, { kind: "int", columnRange: { start: 5, end: 8 } });
    expect(sorted).toEqual(["row2 10 second", "row1 20 first", "row3 20 third"]);
    const result = sortLines("c\na\nb", { from: 0, to: 0 }, { kind: "lex" });
    expect(result.text).toBe("a\nb\nc");
  });
});

describe("notepad 8 case conversions (V-05)", () => {
  it("supports all 8 modes including Unicode", () => {
    expect(convertCaseText("hello 世界", "upper")).toBe("HELLO 世界");
    expect(convertCaseText("HELLO 世界", "lower")).toBe("hello 世界");
    expect(convertCaseText("hello WORLD! foo_bar", "proper")).toBe("Hello World! Foo_Bar");
    expect(convertCaseText("hello XML! foo", "properBlend")).toBe("Hello XML! Foo");
    expect(convertCaseText("hello world. HOW ARE you? fine!", "sentence")).toBe("Hello world. How are you? Fine!");
    expect(convertCaseText("hello XML. how ARE you?", "sentenceBlend")).toBe("Hello XML. How ARE you?");
    expect(convertCaseText("AbCDef 中文", "invert")).toBe("aBcdEF 中文");
    expect(convertCaseText("ab", "random", () => 0.1)).toBe("AB");
    expect(convertCaseRange("one two", { from: 4, to: 7 }, "upper").text).toBe("one TWO");
  });
});

describe("notepad whitespace operations (V-06)", () => {
  it("trims trailing/leading/both, converts tabs and spaces, and converts EOL to space", () => {
    expect(trimTrailingSpaces("  a \t\n b  ", { from: 0, to: 0 }).text).toBe("  a\n b");
    expect(trimLeadingSpaces("  a  \n\tb", { from: 0, to: 0 }).text).toBe("a  \nb");
    expect(trimBothSpaces("  a  \n\tb\t", { from: 0, to: 0 }).text).toBe("a\nb");
    expect(tabsToSpaces("\ta\n\t\tb", { from: 0, to: 0 }, 4).text).toBe("    a\n        b");
    expect(spacesToTabsAll("    a    b", { from: 0, to: 0 }, 4).text).toBe("\ta\tb");
    expect(spacesToTabsLeading("        a    b", { from: 0, to: 0 }, 4).text).toBe("\t\ta    b");
    expect(eolToSpace("one  \n  two\nthree", { from: 0, to: 0 }).text).toBe("one two three");
  });
});

describe("notepad column editor, escape/regex, and MIME toolbox", () => {
  it("formats number sequences across radices with step, repeat, and leading zeros", () => {
    expect(
      previewColumnCells(
        { mode: "number", initial: 10, increment: 2, repeat: 2, radix: 16, leadingZeros: true, width: 3 },
        4,
      ),
    ).toEqual(["00A", "00A", "00C", "00C"]);
    expect(
      formatColumnCell(
        { mode: "number", initial: 1, increment: 1, repeat: 1, radix: 2, leadingZeros: true, width: 4 },
        2,
        4,
      ),
    ).toBe("0011");
    expect(applyColumnInsert("a\nb\nc", { from: 1, to: 5 }, { mode: "text", text: "-X" }).text).toBe("a-X\nb-X\nc-X");
  });

  it("parses extended escapes, validates regex, and builds search regex", () => {
    expect(unescapeExtended("a\\nb\\tc\\0\\x41\\\\")).toBe("a\nb\tc\0A\\");
    expect(resolveReplacementText("\\n$1", "re")).toBe("\n$1");
    expect(validateSearchPattern({ query: "[unclosed", mode: "re", caseSensitive: false, wholeWord: false, dotAll: false })).toBeTruthy();
    const re = buildSearchRegExp({ query: "foo", mode: "normal", caseSensitive: false, wholeWord: true, dotAll: false });
    expect("foobar foo".match(re!)).toEqual(["foo"]);
  });

  it("performs MIME/radix conversions, redaction, and date formatting", () => {
    const encoded = runMimeTransform("b64e", "Taomni 记事本");
    expect(runMimeTransform("b64d", encoded)).toBe("Taomni 记事本");
    expect(runMimeTransform("h2a", runMimeTransform("a2h", "Hi!"))).toBe("Hi!");
    expect(runMimeTransform("d2a", runMimeTransform("a2d", "OK"))).toBe("OK");
    expect(runMimeTransform("b2a", runMimeTransform("a2b", "A"))).toBe("A");
    expect(runMimeTransform("qpd", runMimeTransform("qpe", "A=B\n中"))).toBe("A=B\n中");
    expect(runMimeTransform("urld", runMimeTransform("urle", "a b&c"))).toBe("a b&c");
    expect(() => runMimeTransform("b64d", "not valid base64!!")).toThrow();
    expect(redactText("sec\n12", "●")).toBe("●●●\n●●");
    expect(formatDateTimeCustom("yyyy-MM-dd HH:mm:ss", new Date(2026, 10, 21, 9, 5, 3))).toBe("2026-11-21 09:05:03");
  });
});
