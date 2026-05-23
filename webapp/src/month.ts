export const HEBREW_DAY_NAMES = ["א", "ב", "ג", "ד", "ה", "ו", "ש"] as const;

export type MonthDay = {
  key: string;
  day: number;
  weekday: number;
  weekdayLabel: string;
  isFriday: boolean;
  isSaturday: boolean;
};

export function makeUtcDate(year: number, month: number, day: number) {
  return new Date(Date.UTC(year, month - 1, day));
}

export function dateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

export function monthKey(year: number, month: number) {
  return `${year}-${String(month).padStart(2, "0")}`;
}

export function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function buildMonthDays(year: number, month: number): MonthDay[] {
  return Array.from({ length: daysInMonth(year, month) }, (_, index) => {
    const day = index + 1;
    const date = makeUtcDate(year, month, day);
    const weekday = date.getUTCDay();
    return {
      key: dateKey(date),
      day,
      weekday,
      weekdayLabel: HEBREW_DAY_NAMES[weekday],
      isFriday: weekday === 5,
      isSaturday: weekday === 6
    };
  });
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
