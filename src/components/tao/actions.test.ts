import { describe, expect, it } from "vitest";
import { actionLevel, parseActionProposals, validateActionProposal } from "./actions";
import type { ActionProposal } from "./ai-chat/ports";

function action(overrides: Partial<ActionProposal> = {}): ActionProposal {
  return {
    id: "a1",
    kind: "run_command",
    level: "L1",
    title: "查看目录",
    payload: { command: "ls -la" },
    ...overrides,
  };
}

describe("Tao action protocol", () => {
  it("recomputes confirmation level and escalates destructive commands", () => {
    expect(actionLevel(action())).toBe("L1");
    expect(actionLevel(action({ payload: { command: "rm -rf ./build" } }))).toBe("L2");
    expect(action({ level: "L1", payload: { command: "rm -rf ./build" } })).toMatchObject({ level: "L1" });
    expect(validateActionProposal(action({ payload: { command: "rm -rf ./build" } }), { terminal: "t1" }).action.level).toBe("L2");
  });

  it("rejects missing payloads and context escapes, including traversal", () => {
    expect(validateActionProposal(action({ payload: {} }), {}).ok).toBe(false);
    expect(validateActionProposal(action({ target: { terminalId: "other" } }), { terminal: "t1" }).reason).toContain("终端");
    expect(validateActionProposal(action({ kind: "write_file", payload: { path: "/work/../outside/a", content: "x" }, level: "L1" }), { workspace: "/work" }).reason).toContain("工作区");
    expect(validateActionProposal(action({ kind: "write_file", payload: { path: "/work/a", content: "x" }, level: "L1" }), { workspace: "/work" }).ok).toBe(true);
  });

  it("parses at most the valid fenced action payloads", () => {
    const text = [
      "before",
      "```tao-action",
      JSON.stringify({ id: "a1", kind: "run_command", title: "List", payload: { command: "ls" } }),
      "```",
      "```tao-action {bad}",
      "```",
    ].join("\n");
    expect(parseActionProposals(text)).toHaveLength(1);
    expect(parseActionProposals(text)[0]).toMatchObject({ id: "a1", kind: "run_command", level: "L1" });
  });
});
