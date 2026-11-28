import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseProject, projectCopy } from "./projectXml.js";
import { recalculateSchedule, scheduleModel } from "./projectSchedule.js";
import { MINUTE, scheduleDateText } from "./scheduleTime.js";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "../../../../qa-ui-auto-tests/fixtures/taoffice/shift-plan.mppx"));
const HOUR = 60 * MINUTE;
const encode = (value) => new TextEncoder().encode(value);
const decode = (value) => new TextDecoder().decode(value);

describe("Microsoft Project schedule recalculation", () => {
  it("moves linked tasks around nonworking time and saves only changed schedule fields", () => {
    const project = parseProject(source);
    const model = scheduleModel(project.xml);
    const schedule = recalculateSchedule(model, new Map([["1", 16 * HOUR]]));
    expect(scheduleDateText(schedule.get("1").finish)).toBe("2026-12-03T17:00:00");
    expect(scheduleDateText(schedule.get("2").start)).toBe("2026-12-04T08:00:00");
    expect(scheduleDateText(schedule.get("2").finish)).toBe("2026-12-04T12:00:00");
    expect(schedule.get("1")).toMatchObject({ critical: true, slack: 0 });
    expect(schedule.get("3")).toMatchObject({ critical: false, slack: 18 * HOUR });

    const copy = projectCopy(project, new Map(), schedule);
    expect(decode(copy)).toBe(decode(source)
      .replace("<FinishDate>2026-12-03T12:00:00", "<FinishDate>2026-12-04T12:00:00")
      .replace("<Finish>2026-12-01T17:00:00</Finish><Duration>PT8H0M0S", "<Finish>2026-12-03T17:00:00</Finish><Duration>PT16H0M0S")
      .replace("<Start>2026-12-03T08:00:00</Start><Finish>2026-12-03T12:00:00", "<Start>2026-12-04T08:00:00</Start><Finish>2026-12-04T12:00:00"));
    expect(parseProject(copy).tasks[1]).toMatchObject({ start: "2026-12-04T08:00:00", critical: true, predecessors: ["1"] });
  });

  it.each([
    [0, "2026-12-01T13:00:00", "2026-12-01T17:00:00"],
    [1, "2026-12-03T08:00:00", "2026-12-03T12:00:00"],
    [2, "2026-12-01T08:00:00", "2026-12-01T12:00:00"],
    [3, "2026-12-01T08:00:00", "2026-12-01T12:00:00"],
  ])("schedules MSPDI relationship %d", (type, start, finish) => {
    const xml = decode(source).replace("<Type>1</Type></PredecessorLink>", `<Type>${type}</Type></PredecessorLink>`);
    const result = recalculateSchedule(scheduleModel(xml), new Map()).get("2");
    expect([scheduleDateText(result.start), scheduleDateText(result.finish)]).toEqual([start, finish]);
  });

  it("keeps a weekday resource exception and treats negative elapsed lag as wall-clock time", () => {
    const xml = decode(source).replace("<Type>1</Type></PredecessorLink>", "<Type>1</Type><LinkLag>-1200</LinkLag><LagFormat>6</LagFormat></PredecessorLink>")
      .replace("</Calendars>", `<Calendar><UID>2</UID><BaseCalendarUID>1</BaseCalendarUID><Exceptions><Exception>
        <TimePeriod><FromDate>2026-12-01T00:00:00</FromDate><ToDate>2026-12-01T23:59:00</ToDate></TimePeriod>
        <Type>1</Type><DayWorking>0</DayWorking></Exception></Exceptions></Calendar></Calendars>`)
      .replace("</Project>", `<Resources><Resource><UID>5</UID><CalendarUID>2</CalendarUID></Resource></Resources>
        <Assignments><Assignment><TaskUID>2</TaskUID><ResourceUID>5</ResourceUID></Assignment></Assignments></Project>`);
    const withCalendar = recalculateSchedule(scheduleModel(xml), new Map()).get("2");
    expect(scheduleDateText(withCalendar.start)).toBe("2026-12-03T08:00:00");
    const withoutCalendar = recalculateSchedule(scheduleModel(xml.replace("<UID>2</UID><ID>2</ID>", "<UID>2</UID><ID>2</ID><IgnoreResourceCalendar>1</IgnoreResourceCalendar>")), new Map()).get("2");
    expect(scheduleDateText(withoutCalendar.start)).toBe("2026-12-01T15:00:00");
  });

  it("rejects dependency cycles while the input remains viewable and byte-identical", () => {
    const xml = decode(source).replace("<DurationFormat>5</DurationFormat><Critical>1</Critical>",
      "<DurationFormat>5</DurationFormat><Critical>1</Critical><PredecessorLink><PredecessorUID>2</PredecessorUID></PredecessorLink>");
    const project = parseProject(encode(xml));
    expect(() => recalculateSchedule(scheduleModel(project.xml), new Map())).toThrow("cycle");
    expect(decode(projectCopy(project, new Map()))).toBe(xml);
  });
});
