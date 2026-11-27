import { expect, it } from "vitest";
import { parseDelimitedPrefix } from "./delimitedPreview";

it("keeps TSV delimiters, doubled quotes and embedded line breaks inside a quoted cell", () => {
  expect(parseDelimitedPrefix('key\tvalue\r\n1\t"one\ttwo,\n""three"""\r\n2\t', 10, "\t")).toEqual({
    rows: [["key", "value"], ["1", 'one\ttwo,\n"three"'], ["2", ""]], truncated: false,
  });
});

it("omits an incomplete record at the byte boundary and distinguishes an exact row limit", () => {
  expect(parseDelimitedPrefix('a,b\n1,"partial\nmore', 100, ",", false)).toEqual({
    rows: [["a", "b"]], truncated: true,
  });
  expect(parseDelimitedPrefix("a,b\r\n", 1)).toEqual({ rows: [["a", "b"]], truncated: false });
  expect(parseDelimitedPrefix("a,b\r\n", 1, ",", false).truncated).toBe(true);
  expect(parseDelimitedPrefix("a,b\n1,2", 1).rows).toEqual([["a", "b"]]);
});
