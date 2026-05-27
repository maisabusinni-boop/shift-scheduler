import { cellKey } from "@/domain";
import type { MonthSchedule, Role, RoleCode } from "@/types";

export type ScheduleLens = "month" | "week" | "mine";
export type MonthDays = Array<{
  key: string;
  day: number;
  weekday: number;
  weekdayLabel: string;
  isFriday: boolean;
  isSaturday: boolean;
}>;

export function scheduleTodayKey(schedule: MonthSchedule, now = new Date()) {
  if (now.getFullYear() !== schedule.year || now.getMonth() + 1 !== schedule.month) return null;
  return now.toISOString().slice(0, 10);
}

export function splitMonthWeeks(days: MonthDays) {
  return days.reduce<MonthDays[]>((weeks, day) => {
    if (!weeks.length || day.weekday === 0) weeks.push([]);
    weeks[weeks.length - 1].push(day);
    return weeks;
  }, []);
}

export function currentWeekIndexForSchedule(schedule: MonthSchedule, days: MonthDays, now = new Date()) {
  const todayKey = scheduleTodayKey(schedule, now);
  const weeks = splitMonthWeeks(days);
  const currentIndex = todayKey ? weeks.findIndex((week) => week.some((day) => day.key === todayKey)) : -1;
  return Math.max(0, currentIndex);
}

export function buildAssignmentCountsByDay(schedule: MonthSchedule, roles: Role[], days: MonthDays) {
  return new Map(days.map((day) => {
    const count = roles.reduce((total, role) => {
      const assignment = schedule.assignments[cellKey(day.key, role.code)];
      return total + (assignment?.doctorId || assignment?.pending ? 1 : 0);
    }, 0);
    return [day.key, count] as const;
  }));
}

export function buildOwnAssignmentDayKeys(schedule: MonthSchedule, roles: Role[], days: MonthDays, doctorId: string | null) {
  const ownDayKeys = new Set<string>();
  if (!doctorId) return ownDayKeys;

  const roleCodes = new Set<RoleCode>(roles.map((role) => role.code));
  const dayKeys = new Set(days.map((day) => day.key));
  Object.entries(schedule.assignments).forEach(([key, assignment]) => {
    if (assignment.doctorId !== doctorId) return;
    const [date, roleCode] = key.split("|") as [string, RoleCode | undefined];
    if (roleCode && roleCodes.has(roleCode) && dayKeys.has(date)) ownDayKeys.add(date);
  });
  return ownDayKeys;
}

export function doctorAssignmentTotal(schedule: MonthSchedule, roles: Role[], doctorId: string | null) {
  if (!doctorId) return 0;
  const roleCodes = new Set<RoleCode>(roles.map((role) => role.code));
  return Object.entries(schedule.assignments).filter(([key, assignment]) => {
    if (assignment.doctorId !== doctorId) return false;
    const roleCode = key.split("|")[1] as RoleCode | undefined;
    return !!roleCode && roleCodes.has(roleCode);
  }).length;
}

export function filterDaysByLens(days: MonthDays, weeks: MonthDays[], lens: ScheduleLens, weekIndex: number, ownAssignmentDayKeys: Set<string>) {
  if (lens === "mine") return days.filter((day) => ownAssignmentDayKeys.has(day.key));
  if (lens === "week") return weeks[weekIndex] ?? days.slice(0, 7);
  return days;
}

export function buildScheduleView(
  schedule: MonthSchedule,
  roles: Role[],
  days: MonthDays,
  lens: ScheduleLens,
  weekIndex: number,
  doctorId: string | null
) {
  const weeks = splitMonthWeeks(days);
  const assignmentCountsByDay = buildAssignmentCountsByDay(schedule, roles, days);
  const ownAssignmentDayKeys = buildOwnAssignmentDayKeys(schedule, roles, days, doctorId);
  const visibleDays = filterDaysByLens(days, weeks, lens, weekIndex, ownAssignmentDayKeys);
  const visibleDayKeys = new Set(visibleDays.map((day) => day.key));

  return {
    weeks,
    visibleDays,
    visibleDayKeys,
    assignmentCountsByDay,
    ownAssignmentDayKeys,
    mineCount: doctorAssignmentTotal(schedule, roles, doctorId)
  };
}
