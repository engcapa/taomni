import { describe, expect, it } from "vitest";
import { describeFilter, filterFromMessage, filterOpsFor, filterProblem, newMailFilter } from "./mailFilters";

describe("mailFilters", () => {
  it("pre-fills a filter from the sender", () => {
    const filter = filterFromMessage({ from: { name: "Boss", address: "boss@example.com" }, subject: "Hi" });
    expect(filter.name).toBe("From Boss");
    expect(filter.conditions).toEqual([{ field: "from", op: "is", value: "boss@example.com" }]);
    expect(filter.actions[0].kind).toBe("moveTo");
    expect(filter.id).not.toBe(filterFromMessage({ from: null, subject: "" }).id);
  });

  it("limits operators to what each field supports", () => {
    expect(filterOpsFor("body").map((op) => op.value)).toEqual(["contains", "notContains"]);
    expect(filterOpsFor("sizeKb").map((op) => op.value)).toEqual(["greaterThan", "lessThan"]);
    expect(filterOpsFor("subject").map((op) => op.value)).toContain("matches");
  });

  it("finds the problem the backend would reject", () => {
    const ok = newMailFilter({
      name: "Reports",
      conditions: [{ field: "subject", op: "contains", value: "report" }],
      actions: [{ kind: "moveTo", value: "Reports" }],
    });
    expect(filterProblem(ok)).toBeNull();
    expect(filterProblem({ ...ok, name: " " })).toMatch(/name/);
    expect(filterProblem({ ...ok, actions: [{ kind: "moveTo", value: "" }] })).toMatch(/folder/);
    expect(filterProblem({ ...ok, actions: [{ kind: "forward", value: "nobody" }] })).toMatch(/email/);
    expect(filterProblem({ ...ok, conditions: [{ field: "sizeKb", op: "greaterThan", value: "x" }] })).toMatch(/number/);
    expect(filterProblem({ ...ok, conditions: [{ field: "subject", op: "matches", value: "(" }] })).toMatch(/regular/);
    expect(filterProblem({ ...ok, conditions: [{ field: "hasAttachment", op: "is", value: "" }] })).toBeNull();
  });

  it("describes a rule in one line", () => {
    const filter = newMailFilter({
      name: "x",
      matchAny: true,
      conditions: [
        { field: "from", op: "is", value: "a@example.com" },
        { field: "subject", op: "contains", value: "urgent" },
      ],
      actions: [{ kind: "star" }, { kind: "moveTo", value: "Work" }],
    });
    expect(describeFilter(filter)).toBe('From is "a@example.com" or Subject contains "urgent" → Star, Move to folder Work');
  });
});
