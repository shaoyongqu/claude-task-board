// Schedule config for automatic issue execution, shared by the local server.
// All times are interpreted in the host's local timezone — the board is a
// local tool, and cron-style semantics on a local machine are local time.

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):([0-5]\d)$/;
const SCHEDULE_TYPES = new Set(["once", "daily", "weekly", "monthly", "cron"]);
// How far ahead nextScheduleOccurrence searches before giving up (a cron like
// "0 0 30 2 *" never matches; the API rejects configs with no occurrence).
const MAX_SEARCH_DAYS = 366 * 4 + 2;

export function parseScheduleConfig(value) {
  if (value === null) return { ok: true, schedule: null };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "'schedule' must be an object or null" };
  }
  const keys = new Set(Object.keys(value));
  if (!keys.has("type")) return { ok: false, error: "'schedule.type' is required" };
  const allowed = {
    once: new Set(["type", "at"]),
    daily: new Set(["type", "time"]),
    weekly: new Set(["type", "weekdays", "time"]),
    monthly: new Set(["type", "day", "time"]),
    cron: new Set(["type", "expression"]),
  }[value.type];
  if (!allowed) {
    return { ok: false, error: "'schedule.type' must be once, daily, weekly, monthly, or cron" };
  }
  for (const key of keys) {
    if (!allowed.has(key)) return { ok: false, error: `'schedule.${key}' is not allowed for type '${value.type}'` };
  }
  if (value.type === "once") {
    if (typeof value.at !== "string" || !DATETIME_PATTERN.test(value.at)) {
      return { ok: false, error: "'schedule.at' must be a local datetime like 2026-09-01T09:30" };
    }
    if (parseLocalDatetime(value.at) === null) {
      return { ok: false, error: "'schedule.at' is not a real calendar datetime" };
    }
    return { ok: true, schedule: { type: "once", at: value.at } };
  }
  if (value.type === "daily") {
    if (typeof value.time !== "string" || !TIME_PATTERN.test(value.time)) {
      return { ok: false, error: "'schedule.time' must be HH:mm (00:00–23:59)" };
    }
    return { ok: true, schedule: { type: "daily", time: value.time } };
  }
  if (value.type === "weekly") {
    if (typeof value.time !== "string" || !TIME_PATTERN.test(value.time)) {
      return { ok: false, error: "'schedule.time' must be HH:mm (00:00–23:59)" };
    }
    if (
      !Array.isArray(value.weekdays)
      || value.weekdays.length === 0
      || value.weekdays.length > 7
      || new Set(value.weekdays).size !== value.weekdays.length
      || !value.weekdays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    ) {
      return { ok: false, error: "'schedule.weekdays' must be unique integers 0–6 (0 = Sunday)" };
    }
    return { ok: true, schedule: { type: "weekly", weekdays: [...value.weekdays].sort((a, b) => a - b), time: value.time } };
  }
  if (value.type === "monthly") {
    if (typeof value.time !== "string" || !TIME_PATTERN.test(value.time)) {
      return { ok: false, error: "'schedule.time' must be HH:mm (00:00–23:59)" };
    }
    if (!Number.isInteger(value.day) || value.day < 1 || value.day > 31) {
      return { ok: false, error: "'schedule.day' must be an integer from 1 to 31" };
    }
    return { ok: true, schedule: { type: "monthly", day: value.day, time: value.time } };
  }
  const cron = parseCronExpression(typeof value.expression === "string" ? value.expression : "");
  if (!cron.ok) return { ok: false, error: cron.error };
  return { ok: true, schedule: { type: "cron", expression: value.expression.trim() } };
}

// Epoch milliseconds of the next occurrence strictly after fromMs, or null
// when the schedule never fires again (a "once" in the past) or matches
// nothing within the search window.
export function nextScheduleOccurrence(schedule, fromMs) {
  if (!schedule) return null;
  if (schedule.type === "once") {
    const at = parseLocalDatetime(schedule.at);
    return at !== null && at > fromMs ? at : null;
  }
  if (schedule.type === "daily") {
    const [hours, minutes] = schedule.time.split(":").map(Number);
    for (let offset = 0; offset <= 2; offset += 1) {
      const candidate = atLocalTime(fromMs, offset, hours, minutes);
      if (candidate > fromMs) return candidate;
    }
    return null;
  }
  if (schedule.type === "weekly") {
    const [hours, minutes] = schedule.time.split(":").map(Number);
    const weekdays = new Set(schedule.weekdays);
    for (let offset = 0; offset <= 8; offset += 1) {
      const candidate = atLocalTime(fromMs, offset, hours, minutes);
      if (candidate > fromMs && weekdays.has(new Date(candidate).getDay())) return candidate;
    }
    return null;
  }
  if (schedule.type === "monthly") {
    const [hours, minutes] = schedule.time.split(":").map(Number);
    const from = new Date(fromMs);
    for (let monthOffset = 0; monthOffset <= 48; monthOffset += 1) {
      const year = from.getFullYear();
      const month = from.getMonth() + monthOffset;
      const probe = new Date(year, month, 1);
      if (probe.getDate() !== 1) continue;
      if (monthDays(year, month) < schedule.day) continue;
      const candidate = new Date(year, month, schedule.day, hours, minutes).getTime();
      if (candidate > fromMs) return candidate;
    }
    return null;
  }
  return nextCronOccurrence(schedule.expression, fromMs);
}

// ---- cron (5-field: minute hour day-of-month month day-of-week) ----

const CRON_FIELD_RANGES = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

function parseCronField(text, [minimum, maximum], sundayAllowed) {
  const values = new Set();
  for (const part of text.split(",")) {
    const stepMatch = /^(.+?)(?:\/(\d+))?$/.exec(part);
    if (!stepMatch) return { ok: false, error: `invalid cron field '${text}'` };
    const rangeText = stepMatch[1];
    const step = stepMatch[2] !== undefined ? Number(stepMatch[2]) : 1;
    if (!Number.isInteger(step) || step < 1) return { ok: false, error: `invalid step in cron field '${text}'` };
    let start;
    let end;
    if (rangeText === "*") {
      start = minimum;
      end = maximum;
    } else {
      const bounds = rangeText.split("-");
      if (bounds.some((bound) => !/^\d+$/.test(bound))) {
        return { ok: false, error: `invalid cron field '${text}'` };
      }
      if (bounds.length === 1) {
        start = Number(bounds[0]);
        end = stepMatch[2] !== undefined ? maximum : start;
      } else if (bounds.length === 2) {
        start = Number(bounds[0]);
        end = Number(bounds[1]);
      } else {
        return { ok: false, error: `invalid cron field '${text}'` };
      }
    }
    if (start < minimum || end > maximum || start > end) {
      return { ok: false, error: `cron field '${text}' out of range ${minimum}–${maximum}` };
    }
    for (let value = start; value <= end; value += step) {
      values.add(sundayAllowed && value === 7 ? 0 : value);
    }
  }
  if (values.size === 0) return { ok: false, error: `invalid cron field '${text}'` };
  return { ok: true, values };
}

export function parseCronExpression(expression) {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    return { ok: false, error: "'schedule.expression' must be a 5-field cron expression (分 时 日 月 周)" };
  }
  const parsed = fields.map((field, index) => (
    parseCronField(field, CRON_FIELD_RANGES[index], index === 4)
  ));
  const failure = parsed.find((field) => !field.ok);
  if (failure) return { ok: false, error: failure.error };
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = parsed.map((field) => field.values);
  return {
    ok: true,
    cron: {
      minutes,
      hours,
      daysOfMonth,
      months,
      daysOfWeek,
      // Standard Vixie semantics: when both day fields are restricted (not
      // "*"), a day matches if either field does.
      dayMatchRestricted: fields[2] !== "*" && fields[4] !== "*",
      daysOfMonthRestricted: fields[2] !== "*",
      daysOfWeekRestricted: fields[4] !== "*",
    },
  };
}

function cronDayMatches(cron, year, month, day) {
  if (!cron.months.has(month + 1)) return false;
  const domMatches = cron.daysOfMonth.has(day);
  const dowMatches = cron.daysOfWeek.has(new Date(year, month, day).getDay());
  if (cron.dayMatchRestricted) return domMatches || dowMatches;
  return domMatches && dowMatches;
}

function nextCronOccurrence(expression, fromMs) {
  const parsed = parseCronExpression(expression);
  if (!parsed.ok) return null;
  const { cron } = parsed;
  const from = new Date(fromMs);
  const sortedMinutes = [...cron.minutes].sort((a, b) => a - b);
  const sortedHours = [...cron.hours].sort((a, b) => a - b);
  for (let dayOffset = 0; dayOffset <= MAX_SEARCH_DAYS; dayOffset += 1) {
    const probe = new Date(from.getFullYear(), from.getMonth(), from.getDate() + dayOffset);
    if (!cronDayMatches(cron, probe.getFullYear(), probe.getMonth(), probe.getDate())) continue;
    for (const hours of sortedHours) {
      for (const minutes of sortedMinutes) {
        const candidate = new Date(
          probe.getFullYear(),
          probe.getMonth(),
          probe.getDate(),
          hours,
          minutes,
        ).getTime();
        if (candidate > fromMs) return candidate;
      }
    }
  }
  return null;
}

// Epoch milliseconds of the last instant of a YYYY-MM-DD due date in local
// time. A periodic schedule's next occurrence must land at or before this
// deadline to fire; later occurrences wait for the due date to be extended.
export function dueDateDeadline(dueDate) {
  const [year, month, day] = dueDate.split("-").map(Number);
  return new Date(year, month - 1, day, 23, 59, 59, 999).getTime();
}

// ---- local-time helpers ----

function atLocalTime(fromMs, dayOffset, hours, minutes) {
  const from = new Date(fromMs);
  return new Date(from.getFullYear(), from.getMonth(), from.getDate() + dayOffset, hours, minutes).getTime();
}

function monthDays(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

function parseLocalDatetime(value) {
  const match = DATETIME_PATTERN.exec(value);
  if (!match) return null;
  const [datePart, timePart] = value.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hours, minutes] = timePart.split(":").map(Number);
  const probe = new Date(year, month - 1, day, hours, minutes);
  return probe.getFullYear() === year && probe.getMonth() === month - 1 && probe.getDate() === day
    ? probe.getTime()
    : null;
}
