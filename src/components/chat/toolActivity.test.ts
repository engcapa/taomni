import { describe, expect, it } from "vitest";
import {
  allToolsSettled,
  isToolActivityLine,
  splitToolActivitySegments,
} from "./toolActivity";

describe("isToolActivityLine", () => {
  it("matches tool-use and result lines from the agent transcript", () => {
    expect(isToolActivityLine("> 🔧 `search_tool`")).toBe(true);
    expect(isToolActivityLine("> 🔧 `run_terminal_command` — ls -la")).toBe(true);
    expect(isToolActivityLine("> ↳ completed")).toBe(true);
    expect(isToolActivityLine("ordinary prose")).toBe(false);
    expect(isToolActivityLine("> quoted text")).toBe(false);
  });
});

describe("splitToolActivitySegments", () => {
  it("returns a single text segment when there are no tools", () => {
    const segs = splitToolActivitySegments("Hello, world.");
    expect(segs).toEqual([{ kind: "text", value: "Hello, world." }]);
  });

  it("extracts a contiguous tool run between prose", () => {
    const source = [
      "Deleting the file now.",
      "",
      "> 🔧 `search_tool`",
      "> ↳ completed",
      "> 🔧 `run_terminal_command` — rm -v /tmp/x",
      "> ↳ removed '/tmp/x'",
      "",
      "Done.",
    ].join("\n");

    const segs = splitToolActivitySegments(source);
    expect(segs).toHaveLength(3);
    expect(segs[0]).toEqual({ kind: "text", value: "Deleting the file now.\n" });
    expect(segs[1].kind).toBe("tools");
    if (segs[1].kind !== "tools") throw new Error("expected tools");
    expect(segs[1].tools).toEqual([
      { tool: "search_tool", result: "completed" },
      { tool: "run_terminal_command", detail: "rm -v /tmp/x", result: "removed '/tmp/x'" },
    ]);
    expect(segs[2]).toEqual({ kind: "text", value: "\nDone." });
  });

  it("keeps interleaved tool groups separate when prose interrupts", () => {
    const source = [
      "> 🔧 `search_tool`",
      "> ↳ completed",
      "working…",
      "> 🔧 `use_tool`",
      "> ↳ ok",
    ].join("\n");

    const segs = splitToolActivitySegments(source);
    expect(segs.map((s) => s.kind)).toEqual(["tools", "text", "tools"]);
    if (segs[0].kind !== "tools" || segs[2].kind !== "tools") throw new Error("expected tools");
    expect(segs[0].tools).toHaveLength(1);
    expect(segs[2].tools[0].tool).toBe("use_tool");
  });

  it("handles tool use without a result preview", () => {
    const segs = splitToolActivitySegments("> 🔧 `list_sessions`\n");
    expect(segs).toHaveLength(1);
    expect(segs[0]).toEqual({
      kind: "tools",
      tools: [{ tool: "list_sessions" }],
    });
  });

  it("tolerates en-dash / hyphen separators in tool detail", () => {
    const segs = splitToolActivitySegments("> 🔧 `Edit` - /tmp/x.rs\n> ↳ ok");
    if (segs[0]?.kind !== "tools") throw new Error("expected tools");
    expect(segs[0].tools[0]).toEqual({ tool: "Edit", detail: "/tmp/x.rs", result: "ok" });
  });
});

describe("allToolsSettled", () => {
  it("is true only when every entry has a result", () => {
    expect(allToolsSettled([])).toBe(false);
    expect(allToolsSettled([{ tool: "a", result: "ok" }])).toBe(true);
    expect(allToolsSettled([{ tool: "a" }, { tool: "b", result: "ok" }])).toBe(false);
  });
});
