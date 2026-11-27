import { SaxesParser } from "saxes";
import { durationText, MINUTE, scheduleDate, scheduleDateText, scheduleDuration } from "./scheduleTime.js";

const PROJECT_NS = "http://schemas.microsoft.com/project";
const PROJECT_FIELDS = new Set(["Name", "ScheduleFromStart", "StartDate", "FinishDate"]);
const TASK_FIELDS = new Set(["UID", "Name", "Start", "Finish", "Duration", "OutlineLevel", "Summary", "Milestone",
  "PercentComplete", "EarlyStart", "EarlyFinish", "LateStart", "LateFinish", "TotalSlack", "Critical"]);
export const MAX_PROJECT_BYTES = 8 * 1024 * 1024;
export const MAX_TASK_NAME = 255;
const MAX_TASKS = 10000;

export function parseProject(bytes) {
  if (bytes.length > MAX_PROJECT_BYTES) throw new Error("Project XML preview is limited to 8 MiB.");
  const xml = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const parser = new SaxesParser({ xmlns: true });
  const stack = [];
  const tasks = [];
  const seen = new Set();
  const header = { values: {}, ranges: {} };
  let summaryTask;
  let task;
  let field;
  parser.on("doctype", () => { throw new Error("Project XML must not declare a document type."); });
  parser.on("opentag", (tag) => {
    stack.push(tag.uri === PROJECT_NS ? tag.local : "");
    if (stack.length > 128) throw new Error("Project XML is nested too deeply.");
    if (stack.length === 1 && stack[0] !== "Project") throw new Error("This file is not a Microsoft Project XML document.");
    if (stack.length === 3 && stack[1] === "Tasks" && stack[2] === "Task") {
      task = { values: {}, predecessors: [], ranges: {} };
    }
    const level = stack.length;
    const name = stack.at(-1);
    const isProjectField = level === 2 && PROJECT_FIELDS.has(name);
    const isTaskField = task && level === 4 && TASK_FIELDS.has(name);
    const isPredecessor = task && level === 5 && stack[3] === "PredecessorLink" && name === "PredecessorUID";
    if (isProjectField || isTaskField || isPredecessor) {
      field = { name, level, tag: tag.name, value: "", start: parser.position, writable: !tag.isSelfClosing };
    } else if (field) {
      field.writable = false;
    }
  });
  parser.on("text", (value) => { if (field && field.level === stack.length) field.value += value; });
  parser.on("cdata", (value) => {
    if (field && field.level === stack.length) {
      field.value += value;
      field.writable = false;
    }
  });
  const preserveFieldMarkup = () => { if (field) field.writable = false; };
  parser.on("comment", preserveFieldMarkup);
  parser.on("processinginstruction", preserveFieldMarkup);
  parser.on("closetag", () => {
    if (field?.level === stack.length) {
      const { name, level, tag, value, start, writable } = field;
      if (level === 5) task.predecessors.push(value.trim());
      else {
        const record = level === 2 ? header : task;
        if (Object.hasOwn(record.values, name)) throw new Error("The Project XML contains duplicate fields.");
        record.values[name] = value;
        if (writable) record.ranges[name] = { start, end: xml.lastIndexOf("</", parser.position - 1), after: parser.position, tag };
      }
      field = undefined;
    }
    if (task && stack.length === 3 && stack[2] === "Task") {
      const { UID, Name, Start, Finish, OutlineLevel, Summary, Milestone, PercentComplete } = task.values;
      const uid = UID?.trim();
      if (!/^\d+$/u.test(uid ?? "") || seen.has(uid)) throw new Error("Project tasks require unique numeric IDs.");
      seen.add(uid);
      if (seen.size > MAX_TASKS) throw new Error("Project preview is limited to 10,000 tasks.");
      const entry = { uid, name: Name ?? "", start: Start?.trim(), finish: Finish?.trim(),
        outline: Math.max(1, Number(OutlineLevel) || 1), summary: isTrue(Summary),
        milestone: isTrue(Milestone) || scheduleDuration(task.values.Duration?.trim()) === 0,
        critical: task.values.Critical === undefined ? undefined : isTrue(task.values.Critical),
        progress: PercentComplete?.trim(), predecessors: task.predecessors, range: task.ranges.Name,
        values: task.values, ranges: task.ranges };
      if (uid === "0") summaryTask = entry;
      else tasks.push(entry);
      task = undefined;
    }
    stack.pop();
  });
  parser.write(xml).close();
  return { xml, title: header.values.Name ?? "", tasks, header, summaryTask };
}

function isTrue(value) {
  return ["1", "true"].includes(value?.trim());
}

function xmlText(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function replaceField(changes, record, field, value, required = false) {
  const range = record.ranges[field];
  if (range) changes.push({ ...range, value: xmlText(value) });
  else if (required || Object.hasOwn(record.values, field)) throw new Error(`The Project XML ${field} field cannot be updated.`);
}

function replaceDate(changes, record, field, date, required) {
  if (scheduleDate(record.values[field]?.trim()) !== date) replaceField(changes, record, field, scheduleDateText(date), required);
}

function taskScheduleChanges(changes, task, result) {
  replaceDate(changes, task, "Start", result.start, true);
  replaceDate(changes, task, "Finish", result.finish, true);
  if (result.early) {
    replaceDate(changes, task, "EarlyStart", result.early.start);
    replaceDate(changes, task, "EarlyFinish", result.early.finish);
    replaceDate(changes, task, "LateStart", result.late.start);
    replaceDate(changes, task, "LateFinish", result.late.finish);
    const slack = Math.round(result.slack / MINUTE * 10);
    if (Number(task.values.TotalSlack) !== slack) replaceField(changes, task, "TotalSlack", String(slack));
    if (isTrue(task.values.Critical) !== result.critical) replaceField(changes, task, "Critical", result.critical ? "1" : "0");
  }
  if (result.duration === undefined || scheduleDuration(task.values.Duration?.trim()) === result.duration) return;
  if (result.duration === 0 && !isTrue(task.values.Milestone)) replaceField(changes, task, "Milestone", "1");
  if (Object.hasOwn(task.values, "Duration")) {
    replaceField(changes, task, "Duration", durationText(result.duration), true);
  } else if (task.ranges.Finish) {
    const { after, tag } = task.ranges.Finish;
    const durationTag = tag.replace(/Finish$/u, "Duration");
    changes.push({ start: after, end: after, value: `<${durationTag}>${durationText(result.duration)}</${durationTag}>` });
  }
}

export function projectCopy(project, edits, schedule) {
  const changes = [];
  for (const task of project.tasks) {
    const result = schedule?.get(task.uid);
    if (result) taskScheduleChanges(changes, task, result);
    if (!edits.has(task.uid)) continue;
    const value = edits.get(task.uid);
    if (!task.range || typeof value !== "string" || !value.trim() || value.length > MAX_TASK_NAME
      || /[\u0000-\u001f\uFFFE\uFFFF\p{Cs}]/u.test(value)) {
      throw new Error("Each task name must contain 1–255 characters on one line.");
    }
    if (value !== task.name) replaceField(changes, task, "Name", value, true);
  }
  if (schedule?.size) {
    const values = [...schedule.values()];
    const start = Math.min(...values.map((task) => task.start));
    const finish = Math.max(...values.map((task) => task.finish));
    const backward = ["0", "false"].includes(project.header.values.ScheduleFromStart?.trim());
    if (backward) replaceDate(changes, project.header, "StartDate", start);
    else replaceDate(changes, project.header, "FinishDate", finish);
    if (project.summaryTask) taskScheduleChanges(changes, project.summaryTask, { start, finish });
  }

  const pieces = [];
  let cursor = 0;
  for (const { start, end, value } of changes.sort((left, right) => left.start - right.start)) {
    pieces.push(project.xml.slice(cursor, start), value);
    cursor = end;
  }
  pieces.push(project.xml.slice(cursor));
  const bytes = new TextEncoder().encode(pieces.join(""));
  if (bytes.length > MAX_PROJECT_BYTES) throw new Error("The saved copy exceeds 8 MiB.");
  return bytes;
}
