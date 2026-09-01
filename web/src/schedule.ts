import type { Schedule } from "./types";
import type { TaskboardLanguage } from "./i18n";

// Weekday labels indexed by Date.getDay() (0 = Sunday).
export const WEEKDAY_LABELS: Record<TaskboardLanguage, readonly string[]> = {
  zh: ["日", "一", "二", "三", "四", "五", "六"],
  en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
};

// Display order starts the week on Monday.
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

// Periodic schedules ride on the issue's due date; one-shot schedules do not.
export function scheduleIsPeriodic(schedule: Schedule | null): boolean {
  return schedule !== null && schedule.type !== "once";
}

export function describeSchedule(
  schedule: Schedule,
  text: (chinese: string, english: string) => string,
): string {
  if (schedule.type === "once") {
    return text(`单次 ${schedule.at.replace("T", " ")}`, `Once ${schedule.at.replace("T", " ")}`);
  }
  if (schedule.type === "daily") {
    return text(`每天 ${schedule.time}`, `Daily ${schedule.time}`);
  }
  if (schedule.type === "weekly") {
    const days = schedule.weekdays.map((day) => WEEKDAY_LABELS.zh[day]).join("、");
    const daysEn = schedule.weekdays.map((day) => WEEKDAY_LABELS.en[day]).join(", ");
    return text(`每周${days} ${schedule.time}`, `Weekly ${daysEn} ${schedule.time}`);
  }
  if (schedule.type === "monthly") {
    return text(`每月 ${schedule.day} 日 ${schedule.time}`, `Monthly day ${schedule.day} ${schedule.time}`);
  }
  return text(`Cron ${schedule.expression}`, `Cron ${schedule.expression}`);
}

// Client-side preview of the next occurrence for the simple modes; cron is
// evaluated only by the server, so it previews as null.
export function nextSchedulePreview(schedule: Schedule): Date | null {
  const now = Date.now();
  if (schedule.type === "once") {
    const time = new Date(schedule.at).getTime();
    return Number.isFinite(time) && time > now ? new Date(time) : null;
  }
  if (schedule.type === "daily") {
    const [hours, minutes] = schedule.time.split(":").map(Number);
    for (let offset = 0; offset <= 2; offset += 1) {
      const candidate = dayAt(now, offset, hours, minutes);
      if (candidate > now) return new Date(candidate);
    }
    return null;
  }
  if (schedule.type === "weekly") {
    const [hours, minutes] = schedule.time.split(":").map(Number);
    const weekdays = new Set(schedule.weekdays);
    for (let offset = 0; offset <= 8; offset += 1) {
      const candidate = dayAt(now, offset, hours, minutes);
      if (candidate > now && weekdays.has(new Date(candidate).getDay())) return new Date(candidate);
    }
    return null;
  }
  return null;
}

function dayAt(fromMs: number, dayOffset: number, hours: number, minutes: number): number {
  const from = new Date(fromMs);
  return new Date(from.getFullYear(), from.getMonth(), from.getDate() + dayOffset, hours, minutes).getTime();
}

// Short "next run" text for chips: HH:mm today, otherwise M/d HH:mm.
export function shortScheduleTime(nextAt: string, locale: string): string {
  const next = new Date(nextAt);
  const sameDay = next.toDateString() === new Date().toDateString();
  const time = next.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false });
  return sameDay ? time : `${next.getMonth() + 1}/${next.getDate()} ${time}`;
}
