import { useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { CalendarDays, ChevronLeft, ChevronRight, Clock, X } from "lucide-react";
import { useLocale, useT } from "../../lib/i18n";
import { useNotesStore } from "../../stores/notesStore";
import { notesFontSizeStyle, notesFontStyle, notesThemeStyle } from "../../lib/notes/notesTheme";

interface NoteDateTimeFieldProps {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
  testId: string;
}

interface CalendarCell {
  key: string;
  date: string;
  day: number;
  inMonth: boolean;
  today: boolean;
}

const DEFAULT_TIME = "09:00";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function localDateString(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function localTimeString(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function clampTimePart(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(max, Math.max(0, Math.round(value)));
}

function timePartsFromString(value: string): { hour: number; minute: number } {
  const [hour = 0, minute = 0] = value.split(":").map((part) => Number(part));
  return {
    hour: clampTimePart(hour, 23),
    minute: clampTimePart(minute, 59),
  };
}

function timeStringFromParts(hour: number, minute: number): string {
  return `${pad(clampTimePart(hour, 23))}:${pad(clampTimePart(minute, 59))}`;
}

function partsFromSeconds(value: number | null): { date: string; time: string } {
  if (value == null) return { date: "", time: DEFAULT_TIME };
  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) return { date: "", time: DEFAULT_TIME };
  return { date: localDateString(date), time: localTimeString(date) };
}

function secondsFromParts(dateValue: string, timeValue: string): number | null {
  if (!dateValue) return null;
  const [year, month, day] = dateValue.split("-").map((part) => Number(part));
  const [hour = 0, minute = 0] = timeValue.split(":").map((part) => Number(part));
  const date = new Date(year, month - 1, day, hour, minute, 0, 0);
  const ms = date.getTime();
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

function monthFromValue(value: number | null): Date {
  const source = value == null ? new Date() : new Date(value * 1000);
  return new Date(source.getFullYear(), source.getMonth(), 1);
}

function addMonths(month: Date, delta: number): Date {
  return new Date(month.getFullYear(), month.getMonth() + delta, 1);
}

function buildCalendar(month: Date): CalendarCell[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const start = new Date(month.getFullYear(), month.getMonth(), 1 - first.getDay());
  const today = localDateString(new Date());
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
    const value = localDateString(date);
    return {
      key: value,
      date: value,
      day: date.getDate(),
      inMonth: date.getMonth() === month.getMonth(),
      today: value === today,
    };
  });
}

function displayValue(value: number | null): string {
  if (value == null) return "";
  const parts = partsFromSeconds(value);
  return parts.date ? `${parts.date} ${parts.time}` : "";
}

/**
 * App-owned date-time picker for notes. It avoids platform-native datetime
 * pickers whose Linux WebKit/GTK behavior can omit time selection or keep the
 * popover stuck open after a day is chosen.
 * Supports both manual text input and click/slider selection, rendering
 * the popover inside a Portal to avoid parent boundary scroll clipping.
 */
export function NoteDateTimeField({ label, value, onChange, testId }: NoteDateTimeFieldProps) {
  const t = useT();
  const { locale } = useLocale();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => monthFromValue(value));
  const [draftDate, setDraftDate] = useState(() => partsFromSeconds(value).date);
  const [draftTime, setDraftTime] = useState(() => partsFromSeconds(value).time);

  const theme = useNotesStore((s) => s.theme);
  const font = useNotesStore((s) => s.font);
  const fontSize = useNotesStore((s) => s.fontSize);

  const themeStyle = notesThemeStyle(theme);
  const fontStyle = notesFontStyle(font);
  const fontSizeStyle = notesFontSizeStyle(fontSize);

  const [inputText, setInputText] = useState(() => displayValue(value));
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    setInputText(displayValue(value));
  }, [value]);

  useEffect(() => {
    if (!open) return;
    const parts = partsFromSeconds(value);
    setDraftDate(parts.date);
    setDraftTime(parts.time);
    setMonth(monthFromValue(value));
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      const popover = document.querySelector(`[data-testid="${testId}-popover"]`);
      if (popover && target instanceof Node && popover.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, testId]);

  useEffect(() => {
    if (!open || !rootRef.current) {
      setPos(null);
      return;
    }

    const updatePosition = () => {
      if (!rootRef.current) return;
      const rect = rootRef.current.getBoundingClientRect();
      const popoverWidth = 248;
      const popoverHeight = 320;
      const margin = 8;

      let left = rect.left;
      if (left + popoverWidth > window.innerWidth - margin) {
        left = window.innerWidth - popoverWidth - margin;
      }
      left = Math.max(margin, left);

      let top = rect.bottom + 4;
      if (top + popoverHeight > window.innerHeight - margin) {
        top = rect.top - popoverHeight - 4;
      }
      top = Math.max(margin, top);

      setPos({ left, top });
    };

    updatePosition();

    window.addEventListener("resize", updatePosition, true);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition, true);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  const cells = useMemo(() => buildCalendar(month), [month]);
  const monthLabel = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: "short", year: "numeric" }).format(month),
    [locale, month],
  );
  const weekdays = useMemo(
    () => {
      const formatter = new Intl.DateTimeFormat(locale, { weekday: "short" });
      return Array.from({ length: 7 }, (_, index) => formatter.format(new Date(2026, 0, 4 + index)));
    },
    [locale],
  );

  const commit = (dateValue: string, timeValue: string, close = false) => {
    if (dateValue) {
      onChange(secondsFromParts(dateValue, timeValue));
    }
    if (close) setOpen(false);
  };

  const commitToday = () => {
    const now = new Date();
    const nextDate = localDateString(now);
    const nextTime = localTimeString(now);
    setDraftDate(nextDate);
    setDraftTime(nextTime);
    commit(nextDate, nextTime, true);
  };

  const commitDone = () => {
    if (draftDate) {
      commit(draftDate, draftTime, true);
    } else {
      setOpen(false);
    }
  };

  const timeParts = timePartsFromString(draftTime);
  const updateDraftTime = (hour: number, minute: number) => {
    setDraftTime(timeStringFromParts(hour, minute));
  };

  const DATETIME_REGEX = /^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{1,2})$/;

  const parseDateTimeString = (str: string): number | null => {
    const match = str.trim().match(DATETIME_REGEX);
    if (!match) return null;
    const [, y, m, d, h, min] = match.map(Number);
    if (m < 1 || m > 12) return null;
    if (d < 1 || d > 31) return null;
    if (h < 0 || h > 23) return null;
    if (min < 0 || min > 59) return null;

    const date = new Date(y, m - 1, d, h, min, 0, 0);
    const ms = date.getTime();
    return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
  };

  const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const text = e.target.value;
    setInputText(text);
    const parsed = parseDateTimeString(text);
    if (parsed !== null) {
      onChange(parsed);
      const parts = partsFromSeconds(parsed);
      if (parts.date) {
        setDraftDate(parts.date);
        setDraftTime(parts.time);
        setMonth(monthFromValue(parsed));
      }
    }
  };

  const handleInputBlur = () => {
    const parsed = parseDateTimeString(inputText);
    if (parsed !== null) {
      onChange(parsed);
    } else {
      setInputText(displayValue(value));
    }
  };

  const handleInputKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      const parsed = parseDateTimeString(inputText);
      if (parsed !== null) {
        onChange(parsed);
        setOpen(false);
      }
    }
  };

  return (
    <div className="relative inline-flex items-center gap-1" ref={rootRef}>
      <span className="text-[var(--taomni-text-muted)]">{label}</span>
      <div className="relative inline-flex items-center min-w-[136px] max-w-[168px]">
        <CalendarDays className="w-3 h-3 absolute left-1.5 top-1/2 -translate-y-1/2 text-[var(--taomni-text-muted)] pointer-events-none" />
        <input
          type="text"
          className="taomni-input h-6 w-full pl-6 pr-1.5 text-[11px] text-left"
          value={inputText}
          onChange={handleInputChange}
          onBlur={handleInputBlur}
          onKeyDown={handleInputKeyDown}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          placeholder={t("notes.dateTimePlaceholder")}
          data-testid={testId}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={label}
        />
      </div>
      {value != null && (
        <button
          type="button"
          className="taomni-btn h-6 w-6 p-0 inline-flex items-center justify-center"
          onClick={() => {
            onChange(null);
            setOpen(false);
          }}
          title={t("notes.clearDate")}
          aria-label={`${label} ${t("notes.clearDate")}`}
          data-testid={`${testId}-clear`}
        >
          <X className="w-3 h-3" />
        </button>
      )}

      {open && pos && createPortal(
        <div
          className="rounded border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] p-2 shadow-lg"
          role="dialog"
          aria-label={label}
          data-testid={`${testId}-popover`}
          style={{
            position: "fixed",
            left: pos.left,
            top: pos.top,
            zIndex: 9999,
            width: "248px",
            color: "var(--taomni-text)",
            background: "var(--taomni-panel-bg)",
            ...themeStyle,
            ...fontStyle,
            ...fontSizeStyle,
          }}
        >
          <div className="mb-1.5 flex items-center gap-1">
            <button
              type="button"
              className="taomni-btn h-6 w-6 p-0"
              onClick={() => setMonth((current) => addMonths(current, -1))}
              aria-label={t("notes.dateTimePreviousMonth")}
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <div className="flex-1 text-center text-[11px] font-semibold">{monthLabel}</div>
            <button
              type="button"
              className="taomni-btn h-6 w-6 p-0"
              onClick={() => setMonth((current) => addMonths(current, 1))}
              aria-label={t("notes.dateTimeNextMonth")}
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="grid grid-cols-7 gap-0.5 text-center text-[10px] text-[var(--taomni-text-muted)]">
            {weekdays.map((day) => (
              <div key={day} className="h-5 leading-5">
                {day}
              </div>
            ))}
            {cells.map((cell) => {
              const selected = cell.date === draftDate;
              return (
                <button
                  key={cell.key}
                  type="button"
                  className={`h-6 rounded text-[11px] transition-colors ${
                    selected
                      ? "bg-[var(--taomni-selected)] text-[var(--taomni-accent)] ring-1 ring-[var(--taomni-selected-border)]"
                      : cell.inMonth
                        ? "hover:bg-[var(--taomni-hover)]"
                        : "text-[var(--taomni-text-muted)] opacity-50 hover:bg-[var(--taomni-hover)]"
                  } ${cell.today && !selected ? "font-semibold text-[var(--taomni-accent)]" : ""}`}
                  onClick={() => {
                    setDraftDate(cell.date);
                    commit(cell.date, draftTime, true);
                  }}
                >
                  {cell.day}
                </button>
              );
            })}
          </div>

          <div className="mt-2 flex items-start gap-1.5">
            <Clock className="mt-4 w-3.5 h-3.5 text-[var(--taomni-text-muted)]" />
            <div className="flex-1 min-w-0">
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="text-[10px] text-[var(--taomni-text-muted)]">{t("notes.dateTimeTime")}</span>
                <span className="taomni-mono text-[11px] tabular-nums">{draftTime}</span>
              </div>
              <label className="flex h-5 items-center gap-1.5">
                <span className="w-6 shrink-0 text-[10px] text-[var(--taomni-text-muted)]">{t("notes.dateTimeHour")}</span>
                <input
                  type="range"
                  min="0"
                  max="23"
                  step="1"
                  className="h-4 flex-1 min-w-0"
                  style={{ accentColor: "var(--taomni-accent)" }}
                  value={timeParts.hour}
                  onChange={(event) => updateDraftTime(Number(event.target.value), timeParts.minute)}
                  aria-label={t("notes.dateTimeHour")}
                  data-testid={`${testId}-hour`}
                />
              </label>
              <label className="flex h-5 items-center gap-1.5">
                <span className="w-6 shrink-0 text-[10px] text-[var(--taomni-text-muted)]">{t("notes.dateTimeMinute")}</span>
                <input
                  type="range"
                  min="0"
                  max="59"
                  step="1"
                  className="h-4 flex-1 min-w-0"
                  style={{ accentColor: "var(--taomni-accent)" }}
                  value={timeParts.minute}
                  onChange={(event) => updateDraftTime(timeParts.hour, Number(event.target.value))}
                  aria-label={t("notes.dateTimeMinute")}
                  data-testid={`${testId}-minute`}
                />
              </label>
            </div>
          </div>

          <div className="mt-2 flex items-center justify-between gap-1">
            <button type="button" className="taomni-btn h-6 px-2 text-[11px]" onClick={commitToday}>
              {t("notes.dateTimeToday")}
            </button>
            <button
              type="button"
              className="taomni-btn h-6 px-2 text-[11px]"
              onClick={commitDone}
              data-testid={`${testId}-done`}
            >
              {t("notes.dateTimeDone")}
            </button>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
