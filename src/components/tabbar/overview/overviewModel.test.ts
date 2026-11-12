import { describe, expect, it } from "vitest";
import { filterOverviewItems, type PreviewItem } from "./overviewModel";

const items: PreviewItem[] = [
  { id: "a", title: "ProductionDatabase", kind: "SSH", group: "Operations", endpoint: "admin@prod-eu-1:22", summary: "build completed", active: false, outputActive: false },
  { id: "b", title: "README.md", kind: "FILE", group: "中文工作区", endpoint: "src/README.md", summary: "unsaved draft", active: true, outputActive: false },
  { id: "c", title: "Build", kind: "Local", group: "Sessions", endpoint: "/tmp/project", summary: "new worker output", active: false, outputActive: true },
];
const ids = (query: string) => filterOverviewItems(items, query).map((item) => item.id);

describe("overview fuzzy matching", () => {
  it("matches initials/subsequences case-insensitively", () => {
    expect(ids("PDB")).toEqual(["a"]);
    expect(ids("prd-e1")).toEqual(["a"]);
  });
  it("matches words across metadata and bounded preview fields", () => {
    expect(ids("ssh completed")).toEqual(["a"]);
    expect(ids("中文 unsaved")).toEqual(["b"]);
    expect(ids("worker /tmp")).toEqual(["c"]);
  });
  it("returns exact empty/no-match collections and keeps original no-query order", () => {
    expect(ids("  ")).toEqual(["a", "b", "c"]);
    expect(ids("missing-zzzzzz")).toEqual([]);
    expect(filterOverviewItems([], "build")).toEqual([]);
  });
  it("does not move cards when output activity changes", () => {
    expect(filterOverviewItems(items.map((item) => ({ ...item, outputActive: !item.outputActive })), "").map((item) => item.id)).toEqual(["a", "b", "c"]);
  });
});
