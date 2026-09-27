import { describe, expect, it } from "vitest";
import {
  defaultStructuralQuery,
  searchJavaDocuments,
  type StructuralSearchDocument,
} from "./structuralSearch";

function document(text: string): StructuralSearchDocument {
  return {
    rootId: "root",
    rootName: "fixture",
    rootPath: "/fixture",
    path: "StructuralTarget.java",
    text,
  };
}

describe("Java structural search adapter", () => {
  const source = `class StructuralTarget {
  void run() {
    System.out.println("one");
    System.out.println(42);
    System.out.println(
      7
    );
    // System.out.println(99);
    String fake = "System.out.println(100);";
    System.out.print(1);
    System.err.println(2);
  }
}`;

  it("matches AST method invocations and excludes comments, strings, and near misses", () => {
    const response = searchJavaDocuments(defaultStructuralQuery(), [document(source)]);
    expect(response.kind).toBe("ready");
    if (response.kind !== "ready") return;
    expect(response.backend).toBe("lezer-java");
    expect(response.results).toHaveLength(3);
    expect(response.results.map((result) => result.captures.arg.text)).toEqual(["\"one\"", "42", "7"]);
    expect(response.results[1]?.preview).toBe("System.out.println(42);");
  });

  it("applies exact Text constraints and keeps zero matches as a ready empty result", () => {
    const query = defaultStructuralQuery();
    query.variables.arg = { minCount: 1, maxCount: 1, text: "42" };
    const hit = searchJavaDocuments(query, [document(source)]);
    expect(hit.kind).toBe("ready");
    if (hit.kind === "ready") expect(hit.results).toHaveLength(1);

    query.variables.arg.text = "999";
    const empty = searchJavaDocuments(query, [document(source)]);
    expect(empty).toMatchObject({ kind: "ready", results: [] });
  });

  it("returns typed unavailable for an unsupported template instead of falling back", () => {
    const query = defaultStructuralQuery();
    query.pattern = "System.out.print($arg$);";
    expect(searchJavaDocuments(query, [document(source)])).toMatchObject({ kind: "unavailable" });
  });
});
