import { useState } from "react";
import { useTaskboardI18n } from "../i18n";
import type { Schedule } from "../types";
import {
  nextSchedulePreview,
  scheduleIsPeriodic,
  WEEKDAY_LABELS,
  WEEKDAY_ORDER,
} from "../schedule";

type ScheduleMode = "" | Schedule["type"];

interface ScheduleEditorProps {
  schedule: Schedule | null;
  dueDate: string | null;
  onApply: (changes: { schedule: Schedule | null; dueDate?: string }) => void;
  onClose: () => void;
}

function defaultOnceAt(): string {
  const at = new Date(Date.now() + 60 * 60 * 1000);
  at.setSeconds(0, 0);
  const local = new Date(at.getTime() - at.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function isoDateIn(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

// Popover editor for an issue's automatic execution schedule, shared by the
// task editor and the issue detail panel. Periodic schedules require the
// issue's due date; applying one without a due date sets it a week out.
export function ScheduleEditor({ schedule, dueDate, onApply, onClose }: ScheduleEditorProps) {
  const { language, locale, text } = useTaskboardI18n();
  const [mode, setMode] = useState<ScheduleMode>(schedule?.type ?? "");
  const [onceAt, setOnceAt] = useState(schedule?.type === "once" ? schedule.at : defaultOnceAt());
  const [time, setTime] = useState(
    schedule && (schedule.type === "daily" || schedule.type === "weekly" || schedule.type === "monthly")
      ? schedule.time
      : "09:00",
  );
  const [weekdays, setWeekdays] = useState<Set<number>>(
    () => new Set(schedule?.type === "weekly" ? schedule.weekdays : [1]),
  );
  const [monthDay, setMonthDay] = useState(schedule?.type === "monthly" ? schedule.day : 1);
  const [cronExpression, setCronExpression] = useState(
    schedule?.type === "cron" ? schedule.expression : "30 9 * * *",
  );

  const draft = buildDraft();
  const preview = draft ? nextSchedulePreview(draft) : null;
  const onceInPast = draft?.type === "once" && preview === null;
  const weeklyEmpty = mode === "weekly" && weekdays.size === 0;
  const cronMalformed = mode === "cron" && !/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(cronExpression.trim());
  const invalid = onceInPast || weeklyEmpty || cronMalformed;
  const periodic = scheduleIsPeriodic(draft);

  function buildDraft(): Schedule | null {
    if (mode === "") return null;
    if (mode === "once") return { type: "once", at: onceAt };
    if (mode === "daily") return { type: "daily", time };
    if (mode === "weekly") return { type: "weekly", weekdays: [...weekdays].sort((a, b) => a - b), time };
    if (mode === "monthly") return { type: "monthly", day: monthDay, time };
    return { type: "cron", expression: cronExpression.trim() };
  }

  function apply() {
    const next = buildDraft();
    onApply({
      schedule: next,
      ...(scheduleIsPeriodic(next) && !dueDate ? { dueDate: isoDateIn(7) } : {}),
    });
  }

  const modes: Array<{ value: ScheduleMode; label: string }> = [
    { value: "", label: text("不定时", "None") },
    { value: "once", label: text("单次", "Once") },
    { value: "daily", label: text("每天", "Daily") },
    { value: "weekly", label: text("每周", "Weekly") },
    { value: "monthly", label: text("每月", "Monthly") },
    { value: "cron", label: "Cron" },
  ];

  return (
    <div className="composer-popover schedule-popover" role="dialog" aria-label={text("定时执行", "Schedule")}>
      <div className="schedule-mode-row" role="tablist" aria-label={text("触发方式", "Trigger mode")}>
        {modes.map((option) => (
          <button
            key={option.value || "none"}
            type="button"
            role="tab"
            aria-selected={mode === option.value}
            className={mode === option.value ? "is-selected" : undefined}
            onClick={() => setMode(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>

      {mode === "once" && (
        <label className="schedule-field">
          <span>{text("执行时间", "Run at")}</span>
          <input
            type="datetime-local"
            value={onceAt}
            onChange={(event) => setOnceAt(event.target.value)}
          />
        </label>
      )}
      {(mode === "daily" || mode === "weekly" || mode === "monthly") && (
        <label className="schedule-field">
          <span>{text("执行时间", "Run at")}</span>
          <input type="time" value={time} onChange={(event) => setTime(event.target.value)} />
        </label>
      )}
      {mode === "weekly" && (
        <div className="schedule-field">
          <span>{text("星期", "Weekdays")}</span>
          <div className="schedule-weekdays">
            {WEEKDAY_ORDER.map((day) => (
              <button
                key={day}
                type="button"
                aria-pressed={weekdays.has(day)}
                className={weekdays.has(day) ? "is-selected" : undefined}
                onClick={() => setWeekdays((current) => {
                  const next = new Set(current);
                  if (next.has(day)) next.delete(day);
                  else next.add(day);
                  return next;
                })}
              >
                {WEEKDAY_LABELS[language][day]}
              </button>
            ))}
          </div>
        </div>
      )}
      {mode === "monthly" && (
        <label className="schedule-field">
          <span>{text("日期", "Day of month")}</span>
          <span className="schedule-controls">
            <input
              type="number"
              min="1"
              max="31"
              value={monthDay}
              onChange={(event) => setMonthDay(Number(event.target.value))}
            />
            <small>{text("不足该日的月份跳过", "Months without this day are skipped")}</small>
          </span>
        </label>
      )}
      {mode === "cron" && (
        <label className="schedule-field">
          <span>Cron</span>
          <span className="schedule-controls">
            <input
              type="text"
              value={cronExpression}
              spellCheck={false}
              placeholder="30 9 * * 1-5"
              onChange={(event) => setCronExpression(event.target.value)}
            />
            <small>{text("分 时 日 月 周（本地时区）", "minute hour day month weekday (local time)")}</small>
          </span>
        </label>
      )}

      {draft && (
        <div className="schedule-preview">
          {draft.type === "cron"
            ? text("下次执行以服务端计算为准", "Next run is computed by the server")
            : preview
              ? text(
                `下次执行 ${preview.toLocaleString(locale)}`,
                `Next run ${preview.toLocaleString(locale)}`,
              )
              : text("所选时间已过去", "The chosen time is in the past")}
          {periodic && !dueDate && text(
            "；周期执行需要截止日期，保存时将自动设为一周后",
            "; a due date is required and will be set a week out",
          )}
        </div>
      )}

      <div className="schedule-note">
        {text(
          "定时议题在 等待认领、处理中、等你确认 之间流转：到约定时间自动执行，超出截止时间后暂停等待；不会被自动认领；确认本轮后回到等待认领等待下一次；每轮执行相互独立；移入待立项会取消定时设置。",
          "Scheduled issues cycle through Todo / In Progress / In Review: they fire automatically at the configured time, pause past the due date, are never auto-claimed, return to Todo after each confirmed round, run one independent round per fire, and lose their schedule if moved to Backlog.",
        )}
      </div>

      <div className="schedule-actions">
        {schedule && (
          <button
            className="destructive-menu-row"
            type="button"
            onClick={() => onApply({ schedule: null })}
          >
            {text("清除定时", "Clear schedule")}
          </button>
        )}
        <button
          className="recurrence-save"
          type="button"
          disabled={invalid || mode === ""}
          onClick={apply}
        >
          {text(schedule ? "更新定时" : "设置定时", schedule ? "Update schedule" : "Set schedule")}
        </button>
        <button type="button" className="schedule-cancel" onClick={onClose}>
          {text("取消", "Cancel")}
        </button>
      </div>
    </div>
  );
}
