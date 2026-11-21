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
import {
  sortCiAsc,
  sortCiDesc,
  sortDecimalCommaAsc,
  sortDecimalCommaDesc,
  sortDecimalDotAsc,
  sortDecimalDotDesc,
  sortIntAsc,
  sortIntDesc,
  sortLengthAsc,
  sortLengthDesc,
  sortLexAsc,
  sortLexDesc,
  sortLocaleAsc,
  sortLocaleDesc,
  sortLines,
  sortLinesList,
} from "./sort";
import {
  convertCaseRange,
  convertCaseText,
  properKeepRest,
  properKeepRestText,
  randomCase,
  randomCaseText,
  sentence,
  sentenceKeepRest,
  sentenceKeepRestText,
  sentenceText,
  type NotepadCaseKind,
} from "./case";
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
import * as transformsIndex from "./index";

/** Small deterministic linear-congruential generator so random/shuffle results are reproducible. */
function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

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

describe("notepad blank line insertion and seeded shuffle (V-04 extension)", () => {
  it("inserts blank lines above and below the range, including empty documents", () => {
    const startAbove = insertBlankLineAbove("abc", { from: 0, to: 0 });
    expect(startAbove.text).toBe("\nabc");
    expect(startAbove.selection).toEqual({ from: 0, to: 0 });
    expect(startAbove.changed).toBe(true);
    expect(startAbove.beforeLines).toBe(1);
    expect(startAbove.afterLines).toBe(2);

    const endBelow = insertBlankLineBelow("a\nb", { from: 3, to: 3 });
    expect(endBelow.text).toBe("a\nb\n");
    expect(endBelow.selection).toEqual({ from: 4, to: 4 });

    expect(insertBlankLineAbove("", { from: 0, to: 0 }).text).toBe("\n");
    expect(insertBlankLineBelow("", { from: 0, to: 0 }).text).toBe("\n");
    expect(insertBlankLineAbove("", { from: 0, to: 0 }).afterLines).toBe(2);

    // A selection spanning several lines inserts relative to the whole spanned block.
    expect(insertBlankLineAbove("a\nb\nc", { from: 2, to: 3 }).text).toBe("a\n\nb\nc");
    expect(insertBlankLineBelow("a\nb\nc", { from: 0, to: 2 }).text).toBe("a\n\nb\nc");
    expect(insertBlankLineBelow("a\nb\nc", { from: 5, to: 5 }).text).toBe("a\nb\nc\n");
  });

  it("shuffles deterministically with an injected RNG and keeps trailing newlines at the end", () => {
    const sample = "a\nb\nc\nd";
    const first = shuffleLines(sample, { from: 0, to: 0 }, true, seededRng(7));
    const second = shuffleLines(sample, { from: 0, to: 0 }, true, seededRng(7));
    expect(first.text).toBe(second.text);
    expect(first.text.split("\n").sort()).toEqual(["a", "b", "c", "d"]);

    // The rng may also be passed as the third argument, as documented on the helper.
    expect(shuffleLines(sample, { from: 0, to: 0 }, seededRng(7)).text).toBe(first.text);

    const trailing = shuffleLines("alpha\nbeta\ngamma\n", { from: 0, to: 0 }, true, seededRng(11));
    expect(trailing.text.endsWith("\n")).toBe(true);
    expect(trailing.text.split("\n").filter(Boolean).sort()).toEqual(["alpha", "beta", "gamma"]);

    // Empty selection with wholeIfEmpty=false shuffles only the current (single) line.
    const currentOnly = shuffleLines("a\nb", { from: 0, to: 0 }, false, seededRng(3));
    expect(currentOnly.changed).toBe(false);
    expect(currentOnly.text).toBe("a\nb");

    // Only the selected lines are shuffled; lines outside the span stay in place.
    const selected = shuffleLines("keep\nb\na", { from: 5, to: 8 }, true, seededRng(5));
    expect(selected.text.startsWith("keep\n")).toBe(true);
    expect(selected.text.split("\n").slice(1).sort()).toEqual(["a", "b"]);
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
    expect(sortLinesList(["1,50", "1,2", "-0,4"], { kind: "dc" })).toEqual(["-0,4", "1,2", "1,50"]);
    expect(sortLinesList(["10.5", "2.75", "-1.25"], { kind: "dd" })).toEqual(["-1.25", "2.75", "10.5"]);
    expect(sortLinesList(["xxx", "a", "yy", "b"], { kind: "len" })).toEqual(["a", "b", "yy", "xxx"]);

    const localeLines = ["banana", "Apple", "apple", "cherry", "résumé", "resume", "ecole", "éclair"];
    const localeAsc = sortLinesList(localeLines, { kind: "loc", locale: "en" });
    expect(localeAsc).toEqual(["apple", "Apple", "banana", "cherry", "éclair", "ecole", "resume", "résumé"]);
    expect(sortLinesList(localeLines, { kind: "loc", locale: "en", descending: true })).toEqual([...localeAsc].reverse());
  });

  it("sorts decimals tolerantly, puts invalid values last in both directions, and keeps equal keys stable", () => {
    expect(sortLinesList(["1.234,5", "999,75", "  42,0  ", "-3,5"], { kind: "dc" })).toEqual([
      "-3,5",
      "  42,0  ",
      "999,75",
      "1.234,5",
    ]);
    expect(sortLinesList(["1,234.5", "999.75", "  42.0  ", "-3.5"], { kind: "dd" })).toEqual([
      "-3.5",
      "  42.0  ",
      "999.75",
      "1,234.5",
    ]);

    // Invalid values keep their relative order and always end up after the numeric ones.
    const mixed = ["oops", "1,5", "abc", "-2,25"];
    expect(sortLinesList(mixed, { kind: "dc" })).toEqual(["-2,25", "1,5", "oops", "abc"]);
    expect(sortLinesList(mixed, { kind: "dc", descending: true })).toEqual(["1,5", "-2,25", "oops", "abc"]);

    // Ambiguous thousands grouping is treated as invalid instead of guessing.
    expect(sortLinesList(["1.23", "2,5"], { kind: "dc" })).toEqual(["2,5", "1.23"]);

    // Descending reverses the numeric comparison but equal keys keep their original order.
    expect(sortLinesList(["2,0", "2,00", "1,0"], { kind: "dc", descending: true })).toEqual(["2,0", "2,00", "1,0"]);
  });

  it("preserves equality stability and supports column-key sorting", () => {
    const lines = ["row1 20 first", "row2 10 second", "row3 20 third"];
    const sorted = sortLinesList(lines, { kind: "int", columnRange: { start: 5, end: 8 } });
    expect(sorted).toEqual(["row2 10 second", "row1 20 first", "row3 20 third"]);
    const result = sortLines("c\na\nb", { from: 0, to: 0 }, { kind: "lex" });
    expect(result.text).toBe("a\nb\nc");
  });

  it("exposes every sort key and direction used by the Notepad menu", () => {
    expect(sortLexAsc("b\nA\na\nB", { from: 0, to: 0 }).text).toBe("A\nB\na\nb");
    expect(sortLexDesc("b\nA\na\nB", { from: 0, to: 0 }).text).toBe("b\na\nB\nA");

    expect(sortCiAsc("b1\na2\nA1\nB2", { from: 0, to: 0 }).text).toBe("A1\na2\nb1\nB2");
    expect(sortCiDesc("b1\na2\nA1\nB2", { from: 0, to: 0 }).text).toBe("B2\nb1\na2\nA1");

    const locale = "banana\napple\néclair\necole";
    expect(sortLocaleAsc(locale, { from: 0, to: 0 }, { locale: "en" }).text).toBe("apple\nbanana\néclair\necole");
    expect(sortLocaleDesc(locale, { from: 0, to: 0 }, { locale: "en" }).text).toBe("ecole\néclair\nbanana\napple");

    expect(sortIntAsc("10\n2\n-3\n100", { from: 0, to: 0 }).text).toBe("-3\n2\n10\n100");
    expect(sortIntDesc("10\n2\n-3\n100", { from: 0, to: 0 }).text).toBe("100\n10\n2\n-3");

    expect(sortDecimalCommaAsc("1,5\n-2,25\nn/a", { from: 0, to: 0 }).text).toBe("-2,25\n1,5\nn/a");
    expect(sortDecimalCommaDesc("1,5\n-2,25\nn/a", { from: 0, to: 0 }).text).toBe("1,5\n-2,25\nn/a");
    expect(sortDecimalDotAsc("1.5\n-2.25\nn/a", { from: 0, to: 0 }).text).toBe("-2.25\n1.5\nn/a");
    expect(sortDecimalDotDesc("1.5\n-2.25\nn/a", { from: 0, to: 0 }).text).toBe("1.5\n-2.25\nn/a");

    expect(sortLengthAsc("xxx\na\nyy\nb", { from: 0, to: 0 }).text).toBe("a\nb\nyy\nxxx");
    expect(sortLengthDesc("xxx\na\nyy\nb", { from: 0, to: 0 }).text).toBe("xxx\nyy\na\nb");

    // Empty selection sorts the whole document by default and can be restricted to the current line.
    expect(sortLexAsc("b\na", { from: 0, to: 0 }).text).toBe("a\nb");
    expect(sortLexDesc("a\nb", { from: 0, to: 0 }, { wholeIfEmpty: false }).changed).toBe(false);

    // Selected lines only, plus the rectangular column option.
    expect(sortLexAsc("keep\nb\na", { from: 5, to: 8 }).text).toBe("keep\na\nb");
    expect(
      sortIntAsc("row1 20 first\nrow2 10 second\nrow3 20 third", { from: 0, to: 0 }, {
        columnRange: { start: 5, end: 8 },
      }).text,
    ).toBe("row2 10 second\nrow1 20 first\nrow3 20 third");
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

  it("keeps Chinese/Unicode text intact across all 8 modes", () => {
    const input = "中文 HELLO 世界";
    const expected: Record<NotepadCaseKind, string> = {
      upper: "中文 HELLO 世界",
      lower: "中文 hello 世界",
      proper: "中文 Hello 世界",
      properBlend: "中文 HELLO 世界",
      sentence: "中文 hello 世界",
      sentenceBlend: "中文 HELLO 世界",
      invert: "中文 hello 世界",
      random: "中文 HELLO 世界",
    };
    for (const [kind, want] of Object.entries(expected)) {
      expect(convertCaseText(input, kind as NotepadCaseKind, () => 0.1)).toBe(want);
    }
  });

  it("title-cases while keeping the remaining characters of every word unchanged", () => {
    expect(properKeepRestText("hello WORLD foo_bar 中文 test-1abc")).toBe("Hello WORLD Foo_Bar 中文 Test-1abc");
    expect(properKeepRestText("中 文 hello 世界")).toBe("中 文 Hello 世界");
    expect(properKeepRest("say hello WORLD", { from: 4, to: 9 })).toMatchObject({
      text: "say Hello WORLD",
      selection: { from: 4, to: 9 },
      changed: true,
    });
    expect(properKeepRest("hello", { from: 2, to: 2 })).toMatchObject({ text: "hello", changed: false });
  });

  it("applies sentence case per sentence boundary and per line", () => {
    expect(sentenceText("hello world. HOW ARE you? fine! next")).toBe("Hello world. How are you? Fine! Next");
    expect(sentenceText("first line\nsecond LINE\nthird")).toBe("First line\nSecond line\nThird");
    expect(sentenceText("HELLO！ world")).toBe("Hello！ World");
    expect(sentenceText("你好。 hello 世界！HELLO")).toBe("你好。 Hello 世界！hello");
    expect(sentence("one TWO. three FOUR", { from: 9, to: 14 }).text).toBe("one TWO. Three FOUR");
    expect(sentence("Hello.", { from: 0, to: 6 }).changed).toBe(false);
  });

  it("applies sentence case (blend) with the same boundaries but without touching the rest", () => {
    expect(sentenceKeepRestText("hello WORLD. how ARE you\naGAIN")).toBe("Hello WORLD. How ARE you\nAGAIN");
    expect(sentenceKeepRestText("中文 HELLO 世界")).toBe("中文 HELLO 世界");
    expect(sentenceKeepRest("say hello. HOW", { from: 4, to: 9 }).text).toBe("say Hello. HOW");
  });

  it("randomizes only letters and is deterministic with an injected RNG", () => {
    expect(randomCaseText("ab1 2中!?AB", () => 0.1)).toBe("AB1 2中!?AB");
    expect(randomCaseText("ab1 2中!?AB", () => 0.9)).toBe("ab1 2中!?ab");

    let calls = 0;
    const countingRng = () => {
      calls += 1;
      return 0.1;
    };
    expect(randomCaseText("a1 中!b", countingRng)).toBe("A1 中!B");
    expect(calls).toBe(2);

    const withSeed = randomCaseText("The Quick Brown Fox 123!", seededRng(42));
    expect(withSeed).toBe(randomCaseText("The Quick Brown Fox 123!", seededRng(42)));
    expect(withSeed.replace(/[A-Za-z]/g, "x")).toBe("xxx xxxxx xxxxx xxx 123!");

    expect(randomCase("one two", { from: 4, to: 7 }, () => 0.1).text).toBe("one TWO");
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

  it("converts every space run to a TAB (all occurrences, custom tab size, tabs, empty input)", () => {
    expect(spacesToTabsAll("a    b    c", { from: 0, to: 0 }, 4).text).toBe("a\tb\tc");
    expect(spacesToTabsAll("    a      b", { from: 0, to: 0 }, 2).text).toBe("\t\ta\t\t\tb");
    expect(spacesToTabsAll("     ", { from: 0, to: 0 }, 4).text).toBe("\t ");
    expect(spacesToTabsAll("  \t  a", { from: 0, to: 0 }, 2).text).toBe("\t\t\ta");
    expect(spacesToTabsAll("", { from: 0, to: 0 }).text).toBe("");
    // Line-granular selection: only the selected lines are converted.
    expect(spacesToTabsAll("    a\n    b\n    c", { from: 6, to: 11 }, 4).text).toBe("    a\n\tb\n    c");
  });

  it("converts every TAB to spaces at the right column and handles tab-size edges", () => {
    expect(tabsToSpaces("a\tb\tc", { from: 0, to: 0 }, 4).text).toBe("a   b   c");
    expect(tabsToSpaces("ab\tc", { from: 0, to: 0 }, 4).text).toBe("ab  c");
    expect(tabsToSpaces("a \tb", { from: 0, to: 0 }, 4).text).toBe("a   b");
    expect(tabsToSpaces("\ta", { from: 0, to: 0 }, 2).text).toBe("  a");
    expect(tabsToSpaces("\ta", { from: 0, to: 0 }, 0).text).toBe(" a");
    expect(tabsToSpaces("", { from: 0, to: 0 }).text).toBe("");
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

describe("notepad transforms public exports", () => {
  it("exports all extended transforms from the transforms index", () => {
    const names = [
      "properKeepRest",
      "sentence",
      "sentenceKeepRest",
      "randomCase",
      "sortLexAsc",
      "sortLexDesc",
      "sortCiAsc",
      "sortCiDesc",
      "sortLocaleAsc",
      "sortLocaleDesc",
      "sortIntAsc",
      "sortIntDesc",
      "sortDecimalCommaAsc",
      "sortDecimalCommaDesc",
      "sortDecimalDotAsc",
      "sortDecimalDotDesc",
      "sortLengthAsc",
      "sortLengthDesc",
      "insertBlankLineAbove",
      "insertBlankLineBelow",
      "shuffleLines",
      "spacesToTabsAll",
      "tabsToSpaces",
    ];
    for (const name of names) {
      const exported = transformsIndex as unknown as Record<string, unknown>;
      expect(typeof exported[name]).toBe("function");
    }
  });
});
