import { HebrewCalendar, flags } from "@hebcal/core";

export const HEBREW_DAY_NAMES = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"] as const;

export type MonthDay = {
  key: string;
  day: number;
  weekday: number;
  weekdayLabel: string;
  isFriday: boolean;
  isSaturday: boolean;
  holidayName: string | null;
  isJewishHoliday: boolean;
  allowsFridayRoles: boolean;
};

const EXCLUDED_HOLIDAY_FLAGS = flags.EREV |
  flags.CHOL_HAMOED |
  flags.MINOR_HOLIDAY |
  flags.MINOR_FAST |
  flags.MODERN_HOLIDAY |
  flags.ROSH_CHODESH |
  flags.SPECIAL_SHABBAT |
  flags.CHANUKAH_CANDLES;

const EXCLUDED_HOLIDAY_DESCRIPTIONS = new Set([
  "Chanukah",
  "Tu BiShvat",
  "Lag BaOmer",
  "Purim",
  "Shushan Purim",
  "Pesach Sheni",
  "Tish'a B'Av"
]);

export function makeUtcDate(year: number, month: number, day: number) {
  return new Date(Date.UTC(year, month - 1, day));
}

export function dateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function localDateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function monthKey(year: number, month: number) {
  return `${year}-${String(month).padStart(2, "0")}`;
}

export function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function buildMonthDays(year: number, month: number): MonthDay[] {
  const holidays = buildMajorIsraelHolidayMap(year, month);
  return Array.from({ length: daysInMonth(year, month) }, (_, index) => {
    const day = index + 1;
    const date = makeUtcDate(year, month, day);
    const weekday = date.getUTCDay();
    const key = dateKey(date);
    const holidayName = holidays.get(key) ?? null;
    const isJewishHoliday = Boolean(holidayName);
    return {
      key,
      day,
      weekday,
      weekdayLabel: HEBREW_DAY_NAMES[weekday],
      isFriday: weekday === 5,
      isSaturday: weekday === 6,
      holidayName,
      isJewishHoliday,
      allowsFridayRoles: weekday === 5 || isJewishHoliday
    };
  });
}

export function buildMajorIsraelHolidayMap(year: number, month: number) {
  const holidays = new Map<string, string>();
  const events = HebrewCalendar.calendar({
    year,
    month,
    isHebrewYear: false,
    il: true,
    locale: "he",
    noMinorFast: true,
    noModern: true,
    noRoshChodesh: true,
    noSpecialShabbat: true
  });

  for (const event of events) {
    if (!isMajorIsraelHolidayEvent(event.getFlags(), event.getDesc())) continue;
    const key = localDateKey(event.greg());
    const name = event.render("he");
    const existing = holidays.get(key);
    holidays.set(key, existing ? `${existing}, ${name}` : name);
  }

  return holidays;
}

export function isFridayRoleAllowedDate(key: string) {
  const date = new Date(`${key}T00:00:00.000Z`);
  if (date.getUTCDay() === 5) return true;
  return buildMajorIsraelHolidayMap(date.getUTCFullYear(), date.getUTCMonth() + 1).has(key);
}

function isMajorIsraelHolidayEvent(mask: number, description: string) {
  if (mask & EXCLUDED_HOLIDAY_FLAGS) return false;
  if (description === "Yom Kippur") return true;
  if (EXCLUDED_HOLIDAY_DESCRIPTIONS.has(description)) return false;
  return Boolean(mask & flags.CHAG);
}

export function nextDayKey(key: string) {
  const date = new Date(`${key}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return dateKey(date);
}

export function previousDayKey(key: string) {
  const date = new Date(`${key}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return dateKey(date);
}
