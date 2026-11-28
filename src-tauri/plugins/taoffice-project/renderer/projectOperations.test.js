import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { detailsFor, editProject, modelForProject, taskRecords } from "./projectOperations.js";
import { recalculateSchedule } from "./projectSchedule.js";
import { parseProject, projectCopy } from "./projectXml.js";

const fixture = readFileSync(resolve("qa-ui-auto-tests/fixtures/taoffice/shift-work.mppx"));
function edit(project, uid, action) {
  const result = editProject(project, modelForProject(project), uid, action);
  if (!result) return project;
  const model = modelForProject(result.project);
  const dates = result.recalculate && model ? recalculateSchedule(model, new Map()) : undefined;
  return parseProject(projectCopy(result.project, new Map(), dates));
}

describe("Project task editing", () => {
  it("adds a task, changes work dates and dependencies, and stores progress and allocation in MSPDI", () => {
    let document = parseProject(fixture);
    document = edit(document, null, { kind: "addTask", name: "Publish notes & metrics" });
    expect(document.tasks.at(-1)).toMatchObject({ uid: "4", name: "Publish notes & metrics" });
    document = edit(document, "4", { kind: "link", uid: "2", type: "1", lag: "0" });
    expect(document.tasks.at(-1).start).toBe("2026-12-03T13:00:00");
    document = edit(document, "4", { kind: "dates", start: "2026-12-04T08:00", finish: "2026-12-04T12:00" });
    expect(document.tasks.at(-1).finish).toBe("2026-12-04T12:00:00");
    document = edit(document, "4", { kind: "assignment", resource: "8", units: "50" });
    document = edit(document, "4", { kind: "progress", progress: "25" });
    expect(detailsFor(taskRecords(document.xml), "4")).toMatchObject({
      progress: "25", links: [{ uid: "2", type: "1" }], assignments: [{ resource: "8", units: 50 }],
    });
    expect(document.xml).toContain("<ActualDuration>PT1H0M0S</ActualDuration>");
    expect(document.xml).toContain("<RemainingDuration>PT3H0M0S</RemainingDuration>");
    expect(document.xml).toContain("<Units>0.5</Units><Work>PT2H0M0S</Work>");
  });

  it("removes inbound links and assignments with a deleted task and keeps unrelated OPC-style XML ranges", () => {
    const initial = parseProject(fixture);
    const revised = edit(initial, "1", { kind: "removeTask" });
    expect(revised.tasks.map((task) => task.uid)).toEqual(["2", "3"]);
    expect(detailsFor(taskRecords(revised.xml), "2").links).toEqual([]);
    expect(revised.xml).not.toContain("<TaskUID>1</TaskUID>");
    expect(revised.xml).toContain("<Notes>Preserve this assignment.</Notes>");
    expect(revised.xml).toContain("<Baseline><Number>0</Number><Start>2026-12-01T08:00:00</Start><Finish>2026-12-01T10:00:00</Finish></Baseline>");
  });

  it("rejects dependency cycles and invalid progress without changing the original", () => {
    const project = parseProject(fixture);
    expect(() => edit(project, "1", { kind: "link", uid: "2", type: "1", lag: "0" })).toThrow("cycle");
    expect(() => edit(project, "2", { kind: "progress", progress: "101" })).toThrow("percentage");
    expect(project.tasks[0].predecessors).toEqual([]);
  });

  it("expands self-closing prefixed task and assignment groups while preserving namespace bindings", () => {
    const xml = '<m:Project xmlns:m="http://schemas.microsoft.com/project"><m:StartDate>2026-12-01T08:00:00</m:StartDate><m:Tasks/><m:Resources><m:Resource><m:UID>8</m:UID><m:Name>Engineer</m:Name></m:Resource></m:Resources><m:Assignments /></m:Project>';
    let project = parseProject(new TextEncoder().encode(xml));
    project = edit(project, null, { kind: "addTask", name: "Build" });
    project = edit(project, "1", { kind: "assignment", resource: "8", units: "10" });
    expect(project.xml).toContain("<m:TaskUID>1</m:TaskUID>");
    expect(detailsFor(taskRecords(project.xml), "1").assignments[0]).toMatchObject({ resource: "8", units: 10 });
  });
});
