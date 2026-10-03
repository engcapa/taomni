import { describe, expect, it } from "vitest";
import { javaSyntaxOutline } from "./javaSyntaxOutline";

describe("ED-PARITY-014 javaSyntaxOutline", () => {
  it("lists types and members in order without method-body locals", () => {
    const source = [
      "package a;",
      "public class App {",
      "  private int count = 1, other;",
      "  public App() {}",
      "  public static void main(String[] args) { Runnable r = () -> {}; }",
      "  enum Color { RED, GREEN }",
      "}",
      "interface Shape { double area(); }",
      "",
    ].join("\n");
    const outline = javaSyntaxOutline(source);
    expect(outline.map((symbol) => [symbol.name, symbol.kind, symbol.depth])).toEqual([
      ["App", 5, 0],
      ["count", 8, 1],
      ["other", 8, 1],
      ["App", 9, 1],
      ["main", 6, 1],
      ["Color", 10, 1],
      ["RED", 22, 2],
      ["GREEN", 22, 2],
      ["Shape", 11, 0],
      ["area", 6, 1],
    ]);
    const main = outline.find((symbol) => symbol.name === "main")!;
    expect(main.detail).toBe("(String[] args)");
    expect(main.selectionRange.start).toEqual({ line: 4, character: 21 });
  });

  it("returns nothing for text without declarations", () => {
    expect(javaSyntaxOutline("// just a comment\n")).toEqual([]);
  });
});
