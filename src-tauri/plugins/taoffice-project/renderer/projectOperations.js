import {
  appendRecord, child, children, field, fieldPatches, insertLink, recordFields, recordTree, writePatches,
} from "./projectRecords.js";
import { MAX_TASK_NAME, parseProject } from "./projectXml.js";
import { ELAPSED_FORMATS, PERCENT_FORMATS, scheduleModel } from "./projectSchedule.js";
import { DAY, MINUTE, durationText, scheduleDate, scheduleDateText, scheduleDuration, workBetween } from "./scheduleTime.js";

const HOUR = 60 * MINUTE;
const encoder = new TextEncoder();
export const LAG_FORMATS = { workingHours: 5, elapsedHours: 4, durationPercent: 19, elapsedPercent: 20 };

function linkLag(entry) {
  const format = Number(field(entry, "LagFormat") ?? 5);
  const elapsed = ELAPSED_FORMATS.has(format);
  const percent = PERCENT_FORMATS.has(format);
  const lagUnit = percent ? (elapsed ? "elapsedPercent" : "durationPercent") : (elapsed ? "elapsedHours" : "workingHours");
  return { lagUnit, lag: Number(field(entry, "LinkLag") ?? 0) / (percent ? 1 : 600) };
}

function byUid(entries) {
  return new Map(entries.map((entry) => [field(entry, "UID"), entry]));
}

export function taskRecords(xml) {
  const root = recordTree(xml);
  return {
    root,
    tasks: byUid(children(child(root, "Tasks"), "Task")),
    links: children(child(root, "Tasks"), "Task"),
    resources: byUid(children(child(root, "Resources"), "Resource")),
    assignments: children(child(root, "Assignments"), "Assignment"),
  };
}

export function detailsFor(records, uid) {
  const task = records.tasks.get(uid);
  return {
    start: field(task, "Start"),
    finish: field(task, "Finish"),
    progress: field(task, "PercentComplete") ?? "0",
    links: children(task, "PredecessorLink").map((entry) => ({
      uid: field(entry, "PredecessorUID"),
      type: field(entry, "Type") ?? "1",
      ...linkLag(entry),
    })),
    assignments: records.assignments.filter((entry) => field(entry, "TaskUID") === uid).map((entry) => ({
      uid: field(entry, "UID"),
      resource: field(entry, "ResourceUID"),
      units: Number(field(entry, "Units") ?? 1) * 100,
    })),
  };
}

export function projectResources(records) {
  return [...records.resources].filter(([uid, entry]) => uid && field(entry, "IsNull") !== "1" && Number(uid) >= 0)
    .map(([uid, entry]) => ({ uid, name: field(entry, "Name") || uid }));
}

function nextUid(values) {
  let largest = 0;
  for (const value of values) {
    if (/^\d+$/u.test(value ?? "")) largest = Math.max(largest, Number(value));
  }
  if (largest >= 2_147_483_647) throw new Error("This project has reached its identifier limit.");
  return String(largest + 1);
}

function remove(entry) {
  return { start: entry.start, end: entry.end, value: "" };
}

function taskDate(value) {
  const full = /^\d{4}-\d\d-\d\dT\d\d:\d\d$/u.test(value ?? "") ? value + ":00" : value;
  const result = scheduleDate(full);
  if (result === null) throw new Error("Enter a valid project date and time.");
  return result;
}

function addTask(records, model, action) {
  const start = model?.start ?? scheduleDate(field(records.root, "StartDate"));
  const name = action.name.trim();
  if (!name || name.length > MAX_TASK_NAME || /[\u0000-\u001f\uFFFE\uFFFF\p{Cs}]/u.test(name)) {
    throw new Error("Each task name must contain 1–255 characters on one line.");
  }
  if (!Number.isFinite(start)) throw new Error("Set a project start date before adding a task.");
  const uid = nextUid(records.tasks.keys());
  const id = nextUid([...records.tasks.values()].map((entry) => field(entry, "ID")));
  const date = scheduleDateText(start);
  return { selected: uid, recalculate: true, patches: [appendRecord(records.root, "Tasks", "Task", (prefix) =>
    recordFields("Task", prefix, { UID: uid, ID: id, Name: name, Active: 1, OutlineLevel: 1, OutlineNumber: id,
      Start: date, Finish: date, Duration: durationText(8 * HOUR), DurationFormat: 5, Summary: 0, PercentComplete: 0 }))] };
}

function removeTask(records, task) {
  const index = records.links.indexOf(task);
  const level = Number(field(task, "OutlineLevel") ?? 1);
  const existing = records.links.slice(index + 1);
  const nextSibling = existing.findIndex((entry) => Number(field(entry, "OutlineLevel") ?? 1) <= level);
  const removed = ["1", "true"].includes(field(task, "Summary")) ? [task, ...existing.slice(0, nextSibling < 0 ? undefined : nextSibling)] : [task];
  const ids = new Set(removed.map((entry) => field(entry, "UID")));
  const others = records.links.filter((entry) => !ids.has(field(entry, "UID")));
  const inboundLinks = others.flatMap((entry) => children(entry, "PredecessorLink"))
    .filter((entry) => !["1", "true"].includes(field(entry, "CrossProject")) && ids.has(field(entry, "PredecessorUID")));
  const assignments = records.assignments.filter((entry) => ids.has(field(entry, "TaskUID")));
  return { selected: null, recalculate: others.some((entry) => field(entry, "UID") !== "0"),
    patches: [...removed, ...inboundLinks, ...assignments].map(remove) };
}

function updateDates(task, scheduledTask, action) {
  if (!scheduledTask) throw new Error("The selected task has no editable schedule.");
  const start = taskDate(action.start);
  const finish = taskDate(action.finish);
  if (finish < start || finish - start > DAY * 3660) throw new Error("Finish must be on or after start and within ten years.");
  const duration = workBetween(scheduledTask.calendar, start, finish);
  if (duration === 0 && finish !== start) throw new Error("The selected date range has no working time.");
  const values = { Start: scheduleDateText(start), Finish: scheduleDateText(finish),
    Duration: durationText(duration), Milestone: duration === 0 ? 1 : 0 };
  if (["1", "true"].includes(field(task, "Manual"))) {
    Object.assign(values, { ManualStart: values.Start, ManualFinish: values.Finish, ManualDuration: values.Duration });
  } else if (!scheduledTask.fixed) {
    const useFinish = action.backward;
    Object.assign(values, { ConstraintType: useFinish ? 3 : 2, ConstraintDate: useFinish ? values.Finish : values.Start });
  }
  return fieldPatches(task, values);
}

function updateProgress(task, scheduledTask, action) {
  const progress = Number(action.progress);
  if (action.progress === "" || !Number.isInteger(progress) || progress < 0 || progress > 100) {
    throw new Error("Enter an integer completion percentage between 0 and 100.");
  }
  const duration = scheduledTask?.duration ?? scheduleDuration(field(task, "Duration"));
  const fields = { PercentComplete: progress };
  if (duration !== null) {
    const completed = Math.round(duration * progress / 100);
    fields.ActualDuration = durationText(completed);
    fields.RemainingDuration = durationText(duration - completed);
  }
  fields.ActualStart = progress > 0 ? field(task, "ActualStart") ?? field(task, "Start") ?? null : null;
  fields.ActualFinish = progress === 100 ? field(task, "ActualFinish") ?? field(task, "Finish") ?? null : null;
  return fieldPatches(task, fields);
}

function editLink(records, task, action) {
  const existing = children(task, "PredecessorLink").find((entry) => field(entry, "PredecessorUID") === action.originalUid);
  if (action.kind === "removeLink") return existing ? [remove(existing)] : [];
  const predecessor = records.tasks.get(action.uid);
  const type = Number(action.type);
  const lag = Number(action.lag);
  const format = LAG_FORMATS[action.lagUnit ?? "workingHours"];
  const maxLag = PERCENT_FORMATS.has(format) ? 100 : 87_840;
  if (!predecessor || predecessor === task || ["1", "true"].includes(field(predecessor, "Summary"))
    || action.uid === "0" || !Number.isInteger(type) || type < 0 || type > 3 || !format || !Number.isFinite(lag) || Math.abs(lag) > maxLag) {
    throw new Error("Choose a predecessor, a link type, and a valid lag.");
  }
  if (children(task, "PredecessorLink").some((entry) => entry !== existing && field(entry, "PredecessorUID") === action.uid)) {
    throw new Error("This predecessor has already been assigned to the task.");
  }
  const values = { PredecessorUID: action.uid, Type: type, LinkLag: Math.round(lag * (PERCENT_FORMATS.has(format) ? 1 : 600)), LagFormat: format };
  return existing ? fieldPatches(existing, values) : [insertLink(task, values)];
}

function editAssignment(records, task, scheduledTask, action) {
  const taskUid = field(task, "UID");
  const assignments = records.assignments.filter((entry) => field(entry, "TaskUID") === taskUid);
  const existing = assignments.find((entry) => field(entry, "UID") === action.originalUid);
  if (action.kind === "removeAssignment") return existing ? [remove(existing)] : [];
  const resource = records.resources.get(action.resource);
  const percent = Number(action.units);
  if (!resource || Number(action.resource) < 0 || !Number.isFinite(percent) || percent <= 0 || percent > 10_000) {
    throw new Error("Choose a resource and enter allocation units from 0 to 10,000 percent.");
  }
  if (assignments.some((entry) => entry !== existing && field(entry, "ResourceUID") === action.resource)) {
    throw new Error("This resource is already assigned to the task.");
  }
  if (existing) return fieldPatches(existing, { ResourceUID: action.resource, Units: percent / 100 });
  const uid = nextUid(records.assignments.map((entry) => field(entry, "UID")));
  const start = field(task, "Start");
  const finish = field(task, "Finish");
  const work = scheduledTask?.duration == null ? undefined : durationText(Math.round(scheduledTask.duration * percent / 100));
  return [appendRecord(records.root, "Assignments", "Assignment", (prefix) =>
    recordFields("Assignment", prefix, { UID: uid, TaskUID: taskUid, ResourceUID: action.resource,
      Start: start, Finish: finish, Units: percent / 100, Work: work }))];
}

export function editProject(project, model, uid, action) {
  const records = taskRecords(project.xml);
  const task = records.tasks.get(uid);
  const scheduledTask = model?.byId.get(uid);
  let update;
  if (action.kind === "addTask") {
    update = addTask(records, model, action);
  } else {
    if (!task || uid === "0") throw new Error("The selected task is unavailable.");
    const summary = ["1", "true"].includes(field(task, "Summary"));
    if (summary && action.kind !== "removeTask") throw new Error("Edit individual tasks to update a summary.");
    update = { selected: uid, recalculate: true };
    switch (action.kind) {
      case "removeTask":
        update = removeTask(records, task);
        break;
      case "dates":
        update.patches = updateDates(task, scheduledTask, { ...action, backward: model.backward });
        break;
      case "progress":
        update.patches = updateProgress(task, scheduledTask, action);
        update.recalculate = false;
        break;
      case "link":
      case "removeLink":
        update.patches = editLink(records, task, action);
        break;
      case "assignment":
      case "removeAssignment":
        update.patches = editAssignment(records, task, scheduledTask, action);
        break;
      default:
        throw new Error("The requested task edit is unsupported.");
    }
  }
  if (!update.patches.length) return null;
  const revised = parseProject(encoder.encode(writePatches(project.xml, update.patches)));
  return { project: revised, selected: update.selected, recalculate: update.recalculate };
}

export function modelForProject(project) {
  if (!project.tasks.length) return null;
  return scheduleModel(project.xml);
}
