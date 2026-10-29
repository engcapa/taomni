import { expect, it } from "vitest";
import { projectTreeNavigationTarget } from "./projectTreeNavigationModel";
import type { ProjectTreeRow } from "./projectTreeRows";

const rows: ProjectTreeRow[] = [
  { key: "a", selection: { kind: "root", rootId: "a" }, expanded: true, level: 1, render: () => null },
  { key: "compact", selection: { kind: "dir", rootId: "a", path: "src/main/java" }, expanded: true, level: 2, render: () => null },
  ...Array.from({ length: 300 }, (_, index): ProjectTreeRow => ({
    key: `file-${index}`, selection: { kind: "file", ref: { kind: "root", rootId: "a", path: `src/main/java/${index}.java` } }, level: 3, render: () => null,
  })),
  { key: "heading", render: () => null },
  { key: "b", selection: { kind: "root", rootId: "b" }, expanded: false, level: 1, render: () => null },
  { key: "loose", selection: { kind: "file", ref: { kind: "loose", id: "outside", path: "/outside.txt" } }, level: 1, render: () => null },
];

it("uses visible compact ancestry for an offscreen file and crosses roots without selecting headings", () => {
  expect(projectTreeNavigationTarget(rows, rows[250].selection!, "ArrowLeft")).toEqual({ kind: "select", row: rows[1] });
  expect(projectTreeNavigationTarget(rows, rows[301].selection!, "ArrowDown")).toEqual({ kind: "select", row: rows[303] });
  expect(projectTreeNavigationTarget(rows, rows[303].selection!, "ArrowUp")).toEqual({ kind: "select", row: rows[301] });
  expect(projectTreeNavigationTarget(rows, null, "End")).toEqual({ kind: "select", row: rows[304] });
  expect(projectTreeNavigationTarget(rows, rows[304].selection!, "ArrowLeft")).toBeNull();
  expect(projectTreeNavigationTarget(rows, null, "Enter")).toBeNull();
});

it("expands and collapses the exact directory selected and enters its first visible child", () => {
  expect(projectTreeNavigationTarget(rows, rows[1].selection!, "ArrowLeft")).toEqual({ kind: "toggle", selection: rows[1].selection });
  expect(projectTreeNavigationTarget(rows, rows[1].selection!, "ArrowRight")).toEqual({ kind: "select", row: rows[2] });
  expect(projectTreeNavigationTarget(rows, rows[303].selection!, "ArrowRight")).toEqual({ kind: "toggle", selection: rows[303].selection });
});
