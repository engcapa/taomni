import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseProject, projectCopy } from "./projectXml.js";
import { taskBar, taskDay, timelineExtent } from "./timeline.js";

const here = dirname(fileURLToPath(import.meta.url));
const bytes = readFileSync(resolve(here, "../../../../qa-ui-auto-tests/fixtures/taoffice/rollout.mppx"));
const input = new Uint8Array(bytes);
const encode = (value) => new TextEncoder().encode(value);

describe("TaOffice Project XML", () => {
  it("opens the task hierarchy, milestone and predecessor and renames only the selected task", () => {
    const project = parseProject(input);
    expect(project.title).toBe("Product rollout");
    expect(project.tasks[1]).toMatchObject({ name: "Pilot review", outline: 2, progress: "25" });
    expect(project.tasks[2]).toMatchObject({ name: "Launch gate", milestone: true, predecessors: ["2"] });
    const copy = projectCopy(project, new Map([["2", "Pilot <review> & approval"]]));
    expect(new TextDecoder().decode(copy)).toBe(bytes.toString().replace("Pilot review", "Pilot &lt;review&gt; &amp; approval"));
    expect(parseProject(copy).tasks[1].name).toBe("Pilot <review> & approval");
  });

  it("uses the date written in the file and computes bounded bars for the whole plan", () => {
    const { tasks } = parseProject(input);
    const extent = timelineExtent(tasks);
    expect(taskBar(tasks[1], extent)).toEqual({ left: 10, width: 30 });
    expect(taskBar(tasks[2], extent)).toEqual({ left: 90, width: 10 });
    expect(taskBar({ start: "2026-02-30", finish: tasks[0].finish }, extent)).toBeNull();
    expect(taskDay("2026-12-02T23:39:00-08:00")).toBe(taskDay("2026-12-02"));
  });

  it("rejects unrelated XML and validates edited names", () => {
    expect(() => parseProject(encode("<Project><Tasks/></Project>"))).toThrow("Microsoft Project XML");
    expect(() => projectCopy(parseProject(input), new Map([["2", "  "]]))).toThrow("task name");
  });
});
