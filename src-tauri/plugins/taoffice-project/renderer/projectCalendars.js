import { calendarDay, clockTime, DAY, scheduleDate } from "./scheduleTime.js";

const PROJECT_NS = "http://schemas.microsoft.com/project";
const STANDARD_HOURS = [[clockTime("08:00:00"), clockTime("12:00:00")], [clockTime("13:00:00"), clockTime("17:00:00")]];
const weekday = (day) => new Date(day).getUTCDay();
const standardDay = (day) => day > 0 && day < 6 ? STANDARD_HOURS : [];

export const projectChildren = (parent, name) => [...(parent?.children ?? [])]
  .filter((child) => child.namespaceURI === PROJECT_NS && child.localName === name);
export const projectChild = (parent, name) => projectChildren(parent, name)[0];
export const projectText = (parent, name) => projectChild(parent, name)?.textContent.trim();
const integer = (parent, name, fallback = 0) => Number(projectText(parent, name) ?? fallback);

function workingTimes(node) {
  if (["false", "0"].includes(projectText(node, "DayWorking"))) return [];
  const times = projectChildren(projectChild(node, "WorkingTimes"), "WorkingTime").map((time) => {
    const from = clockTime(projectText(time, "FromTime"));
    const value = clockTime(projectText(time, "ToTime"));
    const to = value === 0 ? DAY : value;
    if (from === null || to === null || from >= to) throw new Error("A calendar has an invalid working interval.");
    return [from, to];
  });
  if (!times.length && ["true", "1"].includes(projectText(node, "DayWorking"))) return STANDARD_HOURS;
  return mergeIntervals(times);
}

function mergeIntervals(intervals) {
  const merged = [];
  for (const [start, end] of intervals.sort(([left], [right]) => left - right)) {
    const last = merged.at(-1);
    if (last && last[1] >= start) last[1] = Math.max(end, last[1]);
    else merged.push([start, end]);
  }
  return merged;
}

function week(node) {
  const entries = projectChildren(projectChild(node, "WeekDays"), "WeekDay");
  const result = new Map();
  for (const entry of entries) {
    const day = integer(entry, "DayType") - 1;
    if (day >= 0 && day <= 6 && (projectText(entry, "DayWorking") !== undefined || projectChild(entry, "WorkingTimes"))) {
      result.set(day, workingTimes(entry));
    }
  }
  return result;
}

function period(node) {
  const time = projectChild(node, "TimePeriod");
  const start = scheduleDate(projectText(time, "FromDate"));
  const finish = scheduleDate(projectText(time, "ToDate"));
  if (start === null || finish === null || start > finish) throw new Error("A calendar has an invalid date range.");
  return { start: calendarDay(start), finish: calendarDay(finish) };
}

function matchesRelativeDay(date, item, position) {
  const nextMonth = new Date(date.getTime());
  nextMonth.setUTCMonth(date.getUTCMonth() + 1, 0);
  const number = date.getUTCDate();
  const day = date.getUTCDay();
  const weekdayMatch = (candidate) => item === 0 || (item === 1 && candidate > 0 && candidate < 6)
    || (item === 2 && (candidate === 0 || candidate === 6)) || candidate === item - 3;
  if (!weekdayMatch(day)) return false;
  const last = nextMonth.getUTCDate();
  let matches = 0;
  if (position === 4) {
    for (let next = number + 1; next <= last; next++) if (weekdayMatch((day + next - number) % 7)) return false;
    return true;
  }
  for (let previous = 1; previous < number; previous++) {
    if (weekdayMatch((day + previous - number + 35) % 7)) matches++;
  }
  return matches === position;
}

function exception(node) {
  const { start, finish } = period(node);
  const hours = workingTimes(node);
  const type = integer(node, "Type");
  const every = integer(node, "Period", 1) || 1;
  if (!Number.isSafeInteger(every) || every < 1 || ![0, 1, 2, 3, 4, 5, 6, 7].includes(type)) {
    throw new Error("A calendar uses an unsupported exception pattern.");
  }
  const from = new Date(start);
  const mask = integer(node, "DaysOfWeek");
  const month = integer(node, "Month");
  const monthDay = integer(node, "MonthDay", from.getUTCDate());
  const monthItem = integer(node, "MonthItem");
  const monthPosition = integer(node, "MonthPosition");
  return { hours, matches(day) {
    if (day < start || day > finish) return false;
    const distance = (day - start) / DAY;
    if (type === 0 || type === 1) return distance % every === 0;
    if (type === 6) return Math.floor((distance + weekday(start)) / 7) % every === 0 && !!(mask & (1 << weekday(day)));
    if (type === 7) return weekday(day) > 0 && weekday(day) < 6 && distance % every === 0;
    const date = new Date(day);
    const months = (date.getUTCFullYear() - from.getUTCFullYear()) * 12 + date.getUTCMonth() - from.getUTCMonth();
    if ((type === 2 || type === 3) && date.getUTCMonth() !== month) return false;
    if ((type === 4 || type === 5) && months % every !== 0) return false;
    return type === 3 || type === 5 ? matchesRelativeDay(date, monthItem, monthPosition) : date.getUTCDate() === monthDay;
  } };
}

function readCalendar(node) {
  const exceptions = projectChildren(projectChild(node, "Exceptions"), "Exception");
  const oldExceptions = projectChildren(projectChild(node, "WeekDays"), "WeekDay")
    .filter((entry) => projectText(entry, "DayType") === "0");
  return {
    base: projectText(node, "BaseCalendarUID"), week: week(node),
    exceptions: (exceptions.length ? exceptions : oldExceptions).map(exception),
    workWeeks: projectChildren(projectChild(node, "WorkWeeks"), "WorkWeek").map((entry) => ({ ...period(entry), week: week(entry) })),
  };
}

function intersectIntervals(first, second) {
  const overlaps = [];
  for (const [start, end] of first) {
    for (const [otherStart, otherEnd] of second) {
      const from = Math.max(start, otherStart);
      const to = Math.min(end, otherEnd);
      if (from < to) overlaps.push([from, to]);
    }
  }
  return overlaps;
}

export function projectCalendars(root) {
  const exports = projectChildren(projectChild(root, "Calendars"), "Calendar");
  const nodes = new Map(exports.map((node) => [projectText(node, "UID"), node]));
  const defaultId = projectText(root, "CalendarUID");
  const standard = (day) => standardDay(weekday(day));
  const resolved = new Map();

  function resolve(id, seen = new Set()) {
    if (!id || id === "-1") return standard;
    if (resolved.has(id)) return resolved.get(id);
    if (seen.has(id)) throw new Error("Calendar inheritance contains a cycle.");
    if (seen.size >= 128) throw new Error("The project has too many levels of calendar inheritance.");
    const source = nodes.get(id);
    if (!source) throw new Error(`Calendar ${id} is missing from the project.`);
    seen.add(id);
    const calendar = readCalendar(source);
    const base = resolve(calendar.base, seen);
    const cache = new Map();
    const getHours = (day) => {
      if (cache.has(day)) return cache.get(day);
      const dayOfWeek = weekday(day);
      const special = calendar.exceptions.findLast((item) => item.matches(day));
      const workWeek = calendar.workWeeks.findLast((entry) => day >= entry.start && day <= entry.finish && entry.week.has(dayOfWeek));
      const hours = special?.hours ?? workWeek?.week.get(dayOfWeek) ?? calendar.week.get(dayOfWeek) ?? base(day);
      cache.set(day, hours);
      return hours;
    };
    resolved.set(id, getHours);
    return getHours;
  }

  return (taskId, assignedIds) => {
    const projectHours = resolve(taskId && taskId !== "-1" ? taskId : defaultId);
    const resources = [...new Set(assignedIds)].map((id) => resolve(id));
    if (!resources.length) return projectHours;
    return (day) => intersectIntervals(projectHours(day), mergeIntervals(resources.flatMap((get) => get(day))));
  };
}
