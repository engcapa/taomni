import { SaxesParser } from "saxes";

const PROJECT_NS = "http://schemas.microsoft.com/project";

const TASK_ORDER = ("UID GUID ID Name Active Manual Type IsNull CreateDate Contact WBS WBSLevel OutlineNumber OutlineLevel Priority " +
  "Start Finish Duration DurationFormat Work Stop Resume ResumeValid EffortDriven Recurring OverAllocated Estimated Milestone Summary " +
  "DisplayAsSummary Critical IsSubproject IsSubprojectReadOnly SubprojectName ExternalTask ExternalTaskProject EarlyStart EarlyFinish " +
  "LateStart LateFinish StartVariance FinishVariance WorkVariance FreeSlack TotalSlack StartSlack FinishSlack FixedCost FixedCostAccrual " +
  "PercentComplete PercentWorkComplete Cost OvertimeCost OvertimeWork ActualStart ActualFinish ActualDuration ActualCost ActualOvertimeCost " +
  "ActualWork ActualOvertimeWork RegularWork RemainingDuration RemainingCost RemainingWork RemainingOvertimeCost RemainingOvertimeWork " +
  "ACWP CV ConstraintType CalendarUID ConstraintDate Deadline LevelAssignments LevelingCanSplit LevelingDelay LevelingDelayFormat " +
  "PreLeveledStart PreLeveledFinish Hyperlink HyperlinkAddress HyperlinkSubAddress IgnoreResourceCalendar Notes HideBar Rollup BCWS BCWP " +
  "PhysicalPercentComplete EarnedValueMethod PredecessorLink ActualWorkProtected ActualOvertimeWorkProtected ExtendedAttribute " +
  "Baseline OutlineCode IsPublished StatusManager CommitmentStart CommitmentFinish CommitmentType StartText FinishText DurationText " +
  "ManualStart ManualFinish ManualDuration TimephasedData Project").split(" ");

const ASSIGNMENT_ORDER = ("UID GUID TaskUID ResourceUID PercentWorkComplete ActualCost ActualFinish ActualOvertimeCost ActualOvertimeWork " +
  "ActualStart ActualWork ACWP Confirmed Cost CostRateTable CostVariance CV Delay Finish FinishVariance Hyperlink HyperlinkAddress " +
  "HyperlinkSubAddress WorkVariance HasFixedRateUnits FixedMaterial LevelingDelay LevelingDelayFormat LinkedFields Milestone Notes " +
  "Overallocated OvertimeCost OvertimeWork PeakUnits RateScale RegularWork RemainingCost RemainingOvertimeCost RemainingOvertimeWork " +
  "RemainingWork ResponsePending Start Stop Resume StartVariance Summary SV Units UpdateNeeded VAC Work WorkContour BCWS BCWP BookingType " +
  "ActualWorkProtected ActualOvertimeWorkProtected CreationDate AssnOwner AssnOwnerGuid BudgetCost BudgetWork ExtendedAttribute " +
  "Baseline TimephasedData").split(" ");

const LINK_ORDER = ["PredecessorUID", "Type", "CrossProject", "CrossProjectName", "LinkLag", "LagFormat"];
const FIELD_ORDER = { Task: TASK_ORDER, Assignment: ASSIGNMENT_ORDER, PredecessorLink: LINK_ORDER };

export function recordTree(xml) {
  const parser = new SaxesParser({ xmlns: true });
  const stack = [];
  let root;
  parser.on("doctype", () => { throw new Error("Project XML must not declare a document type."); });
  parser.on("opentag", (tag) => {
    const parent = stack.at(-1);
    const record = stack.length < 6 ? {
      local: tag.uri === PROJECT_NS ? tag.local : "",
      tag: tag.name, prefix: tag.prefix ? tag.prefix + ":" : "",
      start: xml.lastIndexOf("<", parser.position - 1), content: parser.position,
      end: parser.position, empty: tag.isSelfClosing, children: [], value: "", plain: true,
    } : null;
    if (parent) {
      parent.plain = false;
      if (record) parent.children.push(record);
    }
    if (!stack.length) root = record;
    stack.push(record);
  });
  parser.on("text", (value) => {
    const record = stack.at(-1);
    if (record) record.value += value;
  });
  parser.on("cdata", (value) => {
    const record = stack.at(-1);
    if (record) { record.value += value; record.plain = false; }
  });
  function protectMarkup() {
    const record = stack.at(-1);
    if (record) record.plain = false;
  }
  parser.on("comment", protectMarkup);
  parser.on("processinginstruction", protectMarkup);
  parser.on("closetag", () => {
    const record = stack.pop();
    if (!record) return;
    record.end = parser.position;
    record.close = record.empty ? record.end - 2 : xml.lastIndexOf("</", record.end - 1);
  });
  parser.write(xml).close();
  if (root?.local !== "Project") throw new Error("This file is not a Microsoft Project XML document.");
  return root;
}

export const children = (record, local) => record?.children.filter((child) => child.local === local) ?? [];
export const child = (record, local) => record?.children.find((item) => item.local === local);
export const field = (record, local) => child(record, local)?.value.trim();

export function escapeProjectText(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function element(prefix, name, body) {
  return "<" + prefix + name + ">" + body + "</" + prefix + name + ">";
}

export function recordFields(recordType, prefix, values) {
  return FIELD_ORDER[recordType]
    .filter((name) => values[name] !== undefined)
    .map((name) => element(prefix, name, escapeProjectText(values[name])))
    .join("");
}

function insertionPoint(record, local) {
  const order = FIELD_ORDER[record.local];
  const position = order.indexOf(local);
  for (const entry of record.children) {
    const next = order.indexOf(entry.local);
    if (next > position) return entry.start;
  }
  return record.close;
}

export function fieldPatches(record, fields) {
  const changes = [];
  if (!record || record.empty) throw new Error("The selected Project record cannot be edited.");
  for (const name of FIELD_ORDER[record.local]) {
    if (!Object.hasOwn(fields, name)) continue;
    const value = fields[name];
    const entry = child(record, name);
    if (entry?.value.trim() === String(value) || (!entry && value === null)) continue;
    if (value === null) {
      changes.push({ start: entry.start, end: entry.end, value: "" });
    } else if (entry?.plain && !entry.empty) {
      changes.push({ start: entry.content, end: entry.close, value: escapeProjectText(value) });
    } else if (!entry || entry.empty) {
      const start = entry?.start ?? insertionPoint(record, name);
      changes.push({ start, end: entry?.end ?? start, value: element(record.prefix, name, escapeProjectText(value)) });
    } else {
      throw new Error("The " + name + " field contains markup and cannot be edited.");
    }
  }
  return changes;
}

export function appendRecord(root, group, name, build) {
  const parent = child(root, group);
  const prefix = parent?.prefix ?? root.prefix;
  const value = element(prefix, name, build(prefix));
  if (parent?.empty) return { start: parent.close, end: parent.end, value: ">" + value + "</" + parent.tag + ">" };
  if (parent) return { start: parent.close, end: parent.close, value };
  const insertAt = group === "Tasks"
    ? (child(root, "Resources") ?? child(root, "Assignments"))?.start ?? root.close
    : root.close;
  return { start: insertAt, end: insertAt, value: element(prefix, group, value) };
}

export function insertLink(task, link) {
  const start = insertionPoint(task, "PredecessorLink");
  return { start, end: start, value: element(task.prefix, "PredecessorLink", recordFields("PredecessorLink", task.prefix, link)) };
}

export function writePatches(xml, patches) {
  const pieces = [];
  let offset = 0;
  for (const patch of patches.sort((left, right) => left.start - right.start || left.end - right.end)) {
    if (patch.start < offset) throw new Error("Project changes overlap.");
    pieces.push(xml.slice(offset, patch.start), patch.value);
    offset = patch.end;
  }
  pieces.push(xml.slice(offset));
  return pieces.join("");
}
