export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const DAY = 1_440 * MINUTE;

export const calendarDay = (date) => Math.floor(date / DAY) * DAY;

export function scheduleDate(value) {
  const match = /^(\d{4}-\d\d-\d\d)(?:T(\d\d:\d\d:\d\d)(\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)?)?$/u.exec(value ?? "");
  if (!match) return null;
  const [, day, time = "00:00:00", fraction = ""] = match;
  // MSPDI schedules use local wall-clock time. Keep it independent of the viewer's time zone.
  const valueInUtc = Date.parse(`${day}T${time}${fraction}Z`);
  return Number.isFinite(valueInUtc) && new Date(valueInUtc).toISOString().slice(0, 19) === `${day}T${time}` ? valueInUtc : null;
}

export function clockTime(value) {
  const match = /^(\d\d):(\d\d):(\d\d)(?:\.\d{1,3})?$/u.exec(value ?? "");
  if (!match) return null;
  const [, hour, minute, second] = match.map(Number);
  if (hour === 24 && minute === 0 && second === 0) return DAY;
  return hour < 24 && minute < 60 && second < 60 ? (hour * 3_600 + minute * 60 + second) * SECOND : null;
}

export function scheduleDuration(value) {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d{1,3})?)S)?)?$/u.exec(value ?? "");
  if (!match || !match.slice(1).some((part) => part !== undefined)) return null;
  const [, days = 0, hours = 0, minutes = 0, seconds = 0] = match;
  const duration = Number(days) * DAY + Number(hours) * 60 * MINUTE + Number(minutes) * MINUTE + Number(seconds) * SECOND;
  return Number.isSafeInteger(duration) && duration <= DAY * 3660 ? duration : null;
}

export function durationText(value) {
  const hours = Math.floor(value / (60 * MINUTE));
  const minutes = Math.floor((value % (60 * MINUTE)) / MINUTE);
  return `PT${hours}H${minutes}M${(value % MINUTE) / SECOND}S`;
}

export const scheduleDateText = (value) => new Date(value).toISOString().replace(/(?:\.000)?Z$/u, "");

// Work calendars expose sorted non-overlapping intervals as offsets from midnight.
export function shiftWork(calendar, initial, duration, direction = Math.sign(duration) || 1) {
  if (!calendar) return initial + duration;
  let remaining = Math.abs(duration);
  let day = calendarDay(initial);
  for (let scanned = 0; scanned <= 3660; scanned++, day += direction * DAY) {
    const intervals = calendar(day);
    const ordered = direction > 0 ? intervals : [...intervals].reverse();
    for (const [startOffset, endOffset] of ordered) {
      const start = day + startOffset;
      const end = day + endOffset;
      const point = direction > 0 ? Math.max(initial, start) : Math.min(initial, end);
      const available = direction > 0 ? end - point : point - start;
      if (available <= 0) continue;
      if (remaining <= available) return point + direction * remaining;
      remaining -= available;
    }
  }
  throw new Error("The task calendar has insufficient working time within ten years.");
}

export function workBetween(calendar, start, end) {
  if (!calendar) return end - start;
  if (end <= start) return end === start ? 0 : -workBetween(calendar, end, start);
  if (end - start > 3660 * DAY) throw new Error("The schedule exceeds ten years of working time.");
  let duration = 0;
  for (let day = calendarDay(start); day < end; day += DAY) {
    for (const [first, last] of calendar(day)) {
      duration += Math.max(0, Math.min(end, day + last) - Math.max(start, day + first));
    }
  }
  return duration;
}
