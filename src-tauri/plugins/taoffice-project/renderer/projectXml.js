import { SaxesParser } from "saxes";

const PROJECT_NS = "http://schemas.microsoft.com/project";
const fields = new Set(["UID", "Name", "Start", "Finish", "OutlineLevel", "Summary", "Milestone", "PercentComplete"]);
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
  let title = "";
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
    const isTitle = level === 2 && name === "Name";
    const isTaskField = task && level === 4 && fields.has(name);
    const isPredecessor = task && level === 5 && stack[3] === "PredecessorLink" && name === "PredecessorUID";
    if (isTitle || isTaskField || isPredecessor) {
      field = { name, level, value: "", start: parser.position, editable: !tag.isSelfClosing };
    } else if (field) {
      field.editable = false;
    }
  });
  parser.on("text", (value) => { if (field && field.level === stack.length) field.value += value; });
  parser.on("cdata", (value) => {
    if (field && field.level === stack.length) {
      field.value += value;
      field.editable = false;
    }
  });
  parser.on("closetag", () => {
    if (field?.level === stack.length) {
      const { name, level, value, start, editable } = field;
      if (level === 2) title = value;
      else if (level === 5) task.predecessors.push(value.trim());
      else {
        if (Object.hasOwn(task.values, name)) throw new Error("A Project task contains duplicate fields.");
        task.values[name] = value;
        if (editable && name === "Name") task.ranges[name] = [start, xml.lastIndexOf("</", parser.position - 1)];
      }
      field = undefined;
    }
    if (task && stack.length === 3 && stack[2] === "Task") {
      const { UID, Name, Start, Finish, OutlineLevel, Summary, Milestone, PercentComplete } = task.values;
      const uid = UID?.trim();
      if (!/^\d+$/u.test(uid ?? "") || seen.has(uid)) throw new Error("Project tasks require unique numeric IDs.");
      seen.add(uid);
      if (seen.size > MAX_TASKS) throw new Error("Project preview is limited to 10,000 tasks.");
      if (uid !== "0") {
        tasks.push({ uid, name: Name ?? "", start: Start?.trim(), finish: Finish?.trim(),
          outline: Number(OutlineLevel || 1), summary: Summary === "1", milestone: Milestone === "1",
          progress: PercentComplete?.trim(), predecessors: task.predecessors, range: task.ranges.Name });
      }
      task = undefined;
    }
    stack.pop();
  });
  parser.write(xml).close();
  return { xml, title, tasks };
}

export function projectCopy(project, edits) {
  const pieces = [];
  let cursor = 0;
  for (const task of project.tasks) {
    if (!edits.has(task.uid)) continue;
    const value = edits.get(task.uid);
    if (!task.range || typeof value !== "string" || !value.trim() || value.length > MAX_TASK_NAME
      || /[\u0000-\u001f\uFFFE\uFFFF\p{Cs}]/u.test(value)) {
      throw new Error("Each task name must contain 1–255 characters on one line.");
    }
    const [start, end] = task.range;
    pieces.push(project.xml.slice(cursor, start), value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"));
    cursor = end;
  }
  pieces.push(project.xml.slice(cursor));
  const bytes = new TextEncoder().encode(pieces.join(""));
  if (bytes.length > MAX_PROJECT_BYTES) throw new Error("The saved copy exceeds 8 MiB.");
  return bytes;
}
