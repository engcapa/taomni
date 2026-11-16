import { describe, expect, it } from "vitest";
import { createChatController } from "./controller";
import { prepareHandoff } from "./handoff";

describe("coding agent handoff context", () => {
  it("captures the goal, selected resources and real outcomes without drafts, thinking or secrets", () => {
    const controller = createChatController();
    controller.hydrateThreads([{ id: "t", title: "Project", updatedAt: 1, messages: [
      { id: "u", role: "user", text: "Create and test a Python project", createdAt: 1, blocks: [] },
      { id: "a", role: "assistant", text: "Plan and test api_key=synthetic-secret", createdAt: 2, blocks: [
        { id: "private", type: "thinking", text: "internal reasoning" },
        { id: "test", type: "action", action: { id: "test", kind: "run_command", title: "Tests", level: "L1", payload: {}, status: "invalid", result: { exitCode: 1, output: "Assertion failed" } } },
      ] },
      { id: "future", role: "user", text: "Future task excluded", createdAt: 3, blocks: [] },
    ] }]);
    controller.setContext({ workspaceId: "tab-project", workspace: "C:/qa/project" });
    controller.setComposerText("Private unsent draft");
    controller.setChips([{ id: "note", kind: "local", label: "Requirements", preview: "Use TypeScript" }, { id: "file", kind: "file", label: "Opaque", fileId: "provider-secret-id" }]);
    const prepared = prepareHandoff(controller.getState(), "a");
    expect(prepared.linkedTabId).toBe("tab-project");
    for (const expected of ["Python project", "Assertion failed", "Use TypeScript", "C:/qa/project"]) expect(prepared.content).toContain(expected);
    for (const excluded of ["synthetic-secret", "internal reasoning", "Private unsent", "Future task", "provider-secret-id"]) expect(prepared.content).not.toContain(excluded);
    expect(() => prepareHandoff(controller.getState(), "missing")).toThrow();
  });
});
