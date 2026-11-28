import { projectCalendars, projectChild, projectChildren, projectText } from "./projectCalendars.js";
import { DAY, MINUTE, SECOND, scheduleDate, scheduleDuration, shiftWork, workBetween } from "./scheduleTime.js";

const LINK_EVENTS = [["finish", "finish"], ["finish", "start"], ["start", "finish"], ["start", "start"]];
const ELAPSED_FORMATS = new Set([4, 6, 8, 10, 12, 20, 36, 38, 40, 42, 44, 52]);
const PERCENT_FORMATS = new Set([19, 20, 51, 52]);
const flag = (node, field) => ["1", "true"].includes(projectText(node, field));
const date = (node, field) => scheduleDate(projectText(node, field));

function readLinks(node, uid) {
  return projectChildren(node, "PredecessorLink").map((link) => {
    const predecessor = projectText(link, "PredecessorUID");
    const type = Number(projectText(link, "Type") ?? 1);
    const lag = Number(projectText(link, "LinkLag") ?? 0);
    const format = Number(projectText(link, "LagFormat") ?? 5);
    if (!predecessor || !LINK_EVENTS[type] || !Number.isSafeInteger(lag) || Math.abs(lag) > 52_704_000
      || flag(link, "CrossProject")) throw new Error(`Task ${uid} has an unsupported predecessor link.`);
    return { predecessor, events: LINK_EVENTS[type], lag, format };
  });
}

function assignedCalendars(root) {
  const calendars = new Map(projectChildren(projectChild(root, "Resources"), "Resource").map((node) => [
    projectText(node, "UID"), projectText(node, "CalendarUID"),
  ]));
  const assigned = new Map();
  for (const node of projectChildren(projectChild(root, "Assignments"), "Assignment")) {
    const uid = projectText(node, "TaskUID");
    const calendar = calendars.get(projectText(node, "ResourceUID"));
    if (!uid || !calendar || calendar === "-1") continue;
    const ids = assigned.get(uid) ?? [];
    ids.push(calendar);
    assigned.set(uid, ids);
  }
  return assigned;
}

export function scheduleModel(xml) {
  const root = new DOMParser().parseFromString(xml, "application/xml").documentElement;
  const start = date(root, "StartDate");
  const finish = date(root, "FinishDate");
  const backward = ["0", "false"].includes(projectText(root, "ScheduleFromStart"));
  const calendarFor = projectCalendars(root);
  const assigned = assignedCalendars(root);
  const byId = new Map();

  for (const node of projectChildren(projectChild(root, "Tasks"), "Task")) {
    const uid = projectText(node, "UID");
    if (!uid || uid === "0" || flag(node, "IsNull") || ["0", "false"].includes(projectText(node, "Active"))) continue;
    const summary = flag(node, "Summary");
    const start = date(node, "Start");
    const finish = date(node, "Finish");
    const elapsed = ELAPSED_FORMATS.has(Number(projectText(node, "DurationFormat")));
    const calendar = elapsed ? null : calendarFor(projectText(node, "CalendarUID"),
      flag(node, "IgnoreResourceCalendar") ? [] : assigned.get(uid) ?? []);
    const constraint = Number(projectText(node, "ConstraintType") ?? 0);
    const constraintDate = date(node, "ConstraintDate");
    if (!Number.isInteger(constraint) || constraint < 0 || constraint > 7 || (constraint >= 2 && constraintDate === null)) {
      throw new Error(`Task ${uid} has an invalid date constraint.`);
    }
    const originalDuration = scheduleDuration(projectText(node, "Duration"));
    const duration = originalDuration ?? (start !== null && finish !== null ? workBetween(calendar, start, finish) : null);
    if (!summary && (duration === null || duration < 0)) throw new Error(`Task ${uid} has no valid duration.`);

    byId.set(uid, {
      uid, start, finish, summary, calendar, duration, elapsed, constraint, constraintDate,
      outline: Math.max(1, Number(projectText(node, "OutlineLevel")) || 1),
      fixed: flag(node, "Manual") || date(node, "ActualStart") !== null || Number(projectText(node, "PercentComplete")) > 0,
      links: readLinks(node, uid),
    });
  }
  const tasks = [...byId.values()];
  const rootStart = start ?? Math.min(...tasks.map((task) => task.start ?? Infinity));
  const rootFinish = finish ?? Math.max(...tasks.map((task) => task.finish ?? -Infinity));
  if (!Number.isFinite(backward ? rootFinish : rootStart)) throw new Error("The schedule needs a project start or finish date.");
  return { start: rootStart, finish: rootFinish, backward, tasks, byId };
}

function buildGraph(model) {
  const tasks = model.tasks.filter((task) => !task.summary);
  const degrees = new Map(tasks.map((task) => [task.uid, task.links.length]));
  const followers = new Map(tasks.map((task) => [task.uid, []]));
  for (const task of model.tasks) {
    if (task.summary && task.links.length) throw new Error(`Summary task ${task.uid} has its own dependencies.`);
    for (const link of task.links) {
      if (!followers.has(link.predecessor)) throw new Error(`Task ${task.uid} depends on a missing or summary task.`);
      followers.get(link.predecessor).push({ task, link });
    }
  }
  const ordered = tasks.filter((task) => degrees.get(task.uid) === 0);
  for (let index = 0; index < ordered.length; index++) {
    for (const { task } of followers.get(ordered[index].uid)) {
      const count = degrees.get(task.uid) - 1;
      degrees.set(task.uid, count);
      if (count === 0) ordered.push(task);
    }
  }
  if (ordered.length !== tasks.length) throw new Error("Project dependencies contain a cycle.");
  return { ordered, followers };
}

function lagged(task, link, when, predecessorDuration, direction) {
  const amount = PERCENT_FORMATS.has(link.format)
    ? Math.round(predecessorDuration * link.lag / 100)
    : link.lag * MINUTE / 10;
  if (!amount) return when;
  return shiftWork(ELAPSED_FORMATS.has(link.format) ? null : task.calendar, when, amount * direction);
}

function startForFinish(task, finish, duration) {
  if (!duration || !task.calendar) return finish - duration;
  const start = shiftWork(task.calendar, finish, -duration);
  // A finish at the start of a working interval may require moving past a break.
  return shiftWork(task.calendar, start, duration) < finish ? shiftWork(task.calendar, start, SECOND) : start;
}

function dateBounds(task, minimum, maximum) {
  const constraint = task.constraintDate;
  return {
    earliestStart: [2, 4].includes(task.constraint) ? Math.max(minimum, constraint) : minimum,
    earliestFinish: [3, 6].includes(task.constraint) ? constraint : -Infinity,
    latestStart: [2, 5].includes(task.constraint) ? constraint : Infinity,
    latestFinish: [3, 7].includes(task.constraint) ? Math.min(maximum, constraint) : maximum,
  };
}

function checkedDates(task, bounds, start, finish) {
  if (!Number.isFinite(start) || !Number.isFinite(finish) || start > finish || start < bounds.earliestStart
    || start > bounds.latestStart || finish < bounds.earliestFinish || finish > bounds.latestFinish) {
    throw new Error(`Task ${task.uid} cannot meet its dates, calendar, and dependency constraints.`);
  }
  return { start, finish };
}

function earlyDates(task, bounds, duration) {
  if (task.fixed) return checkedDates(task, bounds, task.start, task.finish);
  const lower = Math.max(bounds.earliestStart, Number.isFinite(bounds.earliestFinish)
    ? startForFinish(task, bounds.earliestFinish, duration) : -Infinity);
  const start = duration ? shiftWork(task.calendar, lower, 0) : lower;
  return checkedDates(task, bounds, start, duration ? shiftWork(task.calendar, start, duration) : start);
}

function lateDates(task, bounds, duration) {
  if (task.fixed) return checkedDates(task, bounds, task.start, task.finish);
  const fromFinish = Number.isFinite(bounds.latestStart) && duration
    ? shiftWork(task.calendar, bounds.latestStart, duration) : bounds.latestStart;
  const upper = Math.min(bounds.latestFinish, fromFinish);
  const finish = duration ? shiftWork(task.calendar, upper, 0, -1) : upper;
  const start = duration ? shiftWork(task.calendar, finish, -duration) : finish;
  return checkedDates(task, bounds, start, finish);
}

function summarizeDates(tasks, dates) {
  const groups = [];
  for (const task of tasks) {
    while (groups.length && groups.at(-1).outline >= task.outline) groups.pop();
    if (task.summary) {
      const range = { start: Infinity, finish: -Infinity };
      dates.set(task.uid, range);
      groups.push({ range, outline: task.outline });
      continue;
    }
    const result = dates.get(task.uid);
    for (const { range } of groups) {
      range.start = Math.min(range.start, result.start);
      range.finish = Math.max(range.finish, result.finish);
    }
  }
  for (const task of tasks) {
    if (task.summary && !Number.isFinite(dates.get(task.uid).start)) dates.delete(task.uid);
  }
}

export function recalculateSchedule(model, durations) {
  const { ordered, followers } = buildGraph(model);
  if (!ordered.length) throw new Error("The project has no schedulable tasks.");
  const durationsByTask = new Map(ordered.map((task) => [task.uid, durations.get(task.uid) ?? task.duration]));
  for (const [uid, duration] of durations) {
    const task = model.byId.get(uid);
    if (!task || task.summary || task.fixed || !Number.isSafeInteger(duration) || duration < 0 || duration > DAY * 3660) {
      throw new Error(`Task ${uid} cannot use the requested duration.`);
    }
  }

  const early = new Map();
  const late = new Map();
  const forward = (start, end) => {
    for (const task of ordered) {
      const bounds = dateBounds(task, start, end);
      for (const link of task.links) {
        const [source, target] = link.events;
        const field = target === "start" ? "earliestStart" : "earliestFinish";
        const anchor = early.get(link.predecessor)[source];
        bounds[field] = Math.max(bounds[field], lagged(task, link, anchor, durationsByTask.get(link.predecessor), 1));
      }
      early.set(task.uid, earlyDates(task, bounds, durationsByTask.get(task.uid)));
    }
  };
  const backward = (start, end) => {
    for (const task of [...ordered].reverse()) {
      const bounds = dateBounds(task, start, end);
      for (const { task: follower, link } of followers.get(task.uid)) {
        const [source, target] = link.events;
        const field = source === "start" ? "latestStart" : "latestFinish";
        const anchor = late.get(follower.uid)[target];
        bounds[field] = Math.min(bounds[field], lagged(follower, link, anchor, durationsByTask.get(task.uid), -1));
      }
      late.set(task.uid, lateDates(task, bounds, durationsByTask.get(task.uid)));
    }
  };

  if (model.backward) {
    backward(-Infinity, model.finish);
    forward(Math.min(...[...late.values()].map((task) => task.start)), model.finish);
  } else {
    forward(model.start, Infinity);
    backward(model.start, Math.max(...[...early.values()].map((task) => task.finish)));
  }

  const result = new Map();
  for (const task of ordered) {
    const first = early.get(task.uid);
    const last = late.get(task.uid);
    const dates = model.backward || task.constraint === 1 ? last : first;
    const slack = workBetween(task.calendar, first.start, last.start);
    result.set(task.uid, { ...dates, early: first, late: last, duration: durationsByTask.get(task.uid),
      slack, critical: slack <= 0 });
  }
  for (const task of ordered) {
    for (const link of task.links) {
      const [source, target] = link.events;
      const threshold = lagged(task, link, result.get(link.predecessor)[source], durationsByTask.get(link.predecessor), 1);
      if (result.get(task.uid)[target] < threshold) throw new Error(`Task ${task.uid} conflicts with a predecessor after scheduling.`);
    }
  }
  summarizeDates(model.tasks, result);
  return result;
}
