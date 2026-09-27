import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StructuralSearchRequest } from "../lib/editor/structuralSearch";

// The browser fixture must return the same AST-exact set as the native
// tree-sitter backend for the IDEA F2 fixture, or browser cases would prove a
// different behaviour than native.

const files = vi.hoisted(() => new Map<string, string>());

vi.mock("./localVfs", () => ({
  vfsReadText: vi.fn(async (path: string) => {
    const text = files.get(path);
    if (text === undefined) throw new Error(`Not found: ${path}`);
    return text;
  }),
  vfsList: vi.fn(async (dir: string) => {
    const entries = new Map<string, "file" | "dir">();
    for (const path of files.keys()) {
      if (!path.startsWith(`${dir}/`)) continue;
      const [head, ...rest] = path.slice(dir.length + 1).split("/");
      entries.set(head!, rest.length > 0 ? "dir" : "file");
    }
    return [...entries].map(([name, fileType]) => ({ name, path: `${dir}/${name}`, fileType }));
  }),
}));

const TARGET = "public class StructuralTarget {\n  void run() {\n    System.out.println(\"alpha\");\n    System.out.println(42);\n    System.out.println(\n        \"beta\");\n    System.out.print(\"not println\");\n    // System.out.println(\"comment\");\n    String text = \"System.out.println(\\\"string\\\");\";\n    System.err.println(\"stderr\");\n  }\n}\n";

function request(pattern: string, text?: string): StructuralSearchRequest {
  return {
    requestId: "r1",
    query: {
      schemaVersion: 1, languageId: "java", pattern, scope: "workspace", matchCase: false,
      variables: { arg: { minCount: 1, maxCount: 1, ...(text ? { text } : {}), invert: false } },
    },
    roots: [{ id: "root", name: "parity009", path: "/preview/parity009" }],
    activeFile: { rootId: "root", path: "src/StructuralTarget.java" },
  };
}

describe("parity009 browser Structural Search fixture", () => {
  beforeEach(() => {
    files.clear();
    files.set("/preview/parity009/src/StructuralTarget.java", TARGET);
    localStorage.setItem("taomni.qa.parity009.enabled", "true");
    localStorage.setItem("taomni.qa.parity009.mode", "normal");
  });

  it("matches the same three AST locations as the native backend and honours Text=42/999", async () => {
    const { parity009Run } = await import("./parity009StructuralSearch");
    const all = await parity009Run(request("System.out.println($arg$);"));
    expect(all.status).toBe("ok");
    if (all.status !== "ok") return;
    expect(all.matches.map((m) => [m.start.line, m.start.character, m.end.line, m.end.character]))
      .toEqual([[2, 4, 2, 32], [3, 4, 3, 27], [4, 4, 5, 16]]);
    expect(all.matches.map((m) => m.captures[0]?.text)).toEqual(["\"alpha\"", "42", "\"beta\""]);
    expect(all.matches[0]!.containers).toEqual([
      { kind: "class", name: "StructuralTarget" },
      { kind: "method", name: "run" },
    ]);
    const one = await parity009Run(request("System.out.println($arg$);", "42"));
    expect(one.status === "ok" && one.matches.map((m) => m.start.line)).toEqual([3]);
    const none = await parity009Run(request("System.out.println($arg$);", "999"));
    expect(none).toMatchObject({ status: "ok", matches: [] });
  });

  it("reports typed unavailable without the fixture and typed errors for bad templates", async () => {
    const { parity009Run, parity009Capabilities } = await import("./parity009StructuralSearch");
    expect(await parity009Run(request("System.out.println($arg$"))).toMatchObject({ status: "error", code: "invalid-pattern" });
    localStorage.removeItem("taomni.qa.parity009.enabled");
    expect(parity009Capabilities().available).toBe(false);
    expect(await parity009Run(request("System.out.println($arg$);"))).toMatchObject({
      status: "unavailable", reason: "backend-missing",
    });
  });

  it("cancels a held request and releases it", async () => {
    const { parity009Run, parity009Cancel, parity009Capabilities } = await import("./parity009StructuralSearch");
    localStorage.setItem("taomni.qa.parity009.mode", "hold");
    const pending = parity009Run(request("System.out.println($arg$);"));
    await Promise.resolve();
    expect(parity009Capabilities().activeRequests).toBe(1);
    expect(parity009Cancel("r1")).toBe(true);
    expect(await pending).toMatchObject({ status: "cancelled" });
    expect(parity009Capabilities().activeRequests).toBe(0);
  });
});
