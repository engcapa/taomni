import { describe, expect, it } from "vitest";
import { buildGraph } from "./gitGraph";
import type { GitLogEntry } from "./git";

function entry(oid: string, parents: string[]): GitLogEntry {
  return {
    oid,
    shortOid: oid.slice(0, 7),
    parents,
    authorName: "t",
    authorEmail: "t@e",
    date: "",
    subject: oid,
    refs: [],
  };
}

describe("buildGraph", () => {
  it("keeps a linear history in a single column", () => {
    const rows = buildGraph([entry("A", ["B"]), entry("B", ["C"]), entry("C", [])]);
    expect(rows.map((r) => r.column)).toEqual([0, 0, 0]);
    expect(rows.every((r) => r.width >= 1)).toBe(true);
  });

  it("places a side branch on its own lane and merges back", () => {
    // M merges A and B; both descend from C.
    const rows = buildGraph([
      entry("M", ["A", "B"]),
      entry("A", ["C"]),
      entry("B", ["C"]),
      entry("C", []),
    ]);
    expect(rows.map((r) => r.column)).toEqual([0, 0, 1, 0]);
    // The merge row opens a second lane.
    expect(rows[0].edges.some((e) => e.toColumn === 1)).toBe(true);
    // The final commit closes both lanes into column 0.
    const last = rows[3];
    expect(last.edges.filter((e) => e.toColumn === 0).length).toBeGreaterThanOrEqual(2);
  });
});
