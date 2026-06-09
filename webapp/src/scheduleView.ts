import { cellKey, ROLE_CODES } from "@/domain";
import type { MonthDay } from "@/month";
import type { Doctor, MonthSchedule, Role, RoleCode } from "@/types";

export type ScheduleLens = "month" | "week" | "mine";
export type MonthDays = MonthDay[];
export type DutyDayBucket = "weekday" | "thursday" | "friday" | "saturday";

export type ResidentDutyDistributionRow = {
  doctor: Doctor;
  weekdayOnCall: number;
  thursdayOnCall: number;
  fridayOnCall: number;
  fridayMorning: number;
  saturdayOnCall: number;
  weekdayHalfDuty: number;
  saturdayHalfDuty: number;
};

export type SeniorDutyDistributionRow = {
  doctor: Doctor;
  weekdayHalfDuty: number;
  fridayHalfDuty: number;
  saturdayHalfDuty: number;
  weekdaySeniorA: number;
  weekdaySeniorB: number;
  thursdaySeniorA: number;
  fridaySeniorA: number;
  fridaySeniorB: number;
  saturdaySeniorA: number;
  saturdaySeniorB: number;
};

export type DutyDistribution = {
  residents: ResidentDutyDistributionRow[];
  seniors: SeniorDutyDistributionRow[];
};

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

export function dutyDayBucket(day: MonthDay): DutyDayBucket {
  if (day.isJewishHoliday || day.weekday === 6) return "saturday";
  if (day.weekday === 5) return "friday";
  if (day.weekday === 4) return "thursday";
  return "weekday";
}

function createResidentDutyDistributionRow(doctor: Doctor): ResidentDutyDistributionRow {
  return {
    doctor,
    weekdayOnCall: 0,
    thursdayOnCall: 0,
    fridayOnCall: 0,
    fridayMorning: 0,
    saturdayOnCall: 0,
    weekdayHalfDuty: 0,
    saturdayHalfDuty: 0
  };
}

function createSeniorDutyDistributionRow(doctor: Doctor): SeniorDutyDistributionRow {
  return {
    doctor,
    weekdayHalfDuty: 0,
    fridayHalfDuty: 0,
    saturdayHalfDuty: 0,
    weekdaySeniorA: 0,
    weekdaySeniorB: 0,
    thursdaySeniorA: 0,
    fridaySeniorA: 0,
    fridaySeniorB: 0,
    saturdaySeniorA: 0,
    saturdaySeniorB: 0
  };
}

export function buildDutyDistribution(schedule: MonthSchedule, doctors: Doctor[], days: MonthDays): DutyDistribution {
  const activeDoctors = doctors.filter((doctor) => doctor.active).sort((a, b) => a.name.localeCompare(b.name, "he"));
  const residentRows = new Map(activeDoctors.filter((doctor) => doctor.group === "resident").map((doctor) => [doctor.id, createResidentDutyDistributionRow(doctor)]));
  const seniorRows = new Map(activeDoctors.filter((doctor) => doctor.group === "senior").map((doctor) => [doctor.id, createSeniorDutyDistributionRow(doctor)]));

  for (const day of days) {
    const bucket = dutyDayBucket(day);
    const assignedDoctorFor = (roleCode: RoleCode) => {
      const doctorId = schedule.assignments[cellKey(day.key, roleCode)]?.doctorId;
      return doctorId ? activeDoctors.find((doctor) => doctor.id === doctorId) ?? null : null;
    };

    const residentOnCallDoctor = assignedDoctorFor(ROLE_CODES.RESIDENT_ON_CALL);
    const residentOnCallRow = residentOnCallDoctor ? residentRows.get(residentOnCallDoctor.id) : null;
    if (residentOnCallRow) {
      if (bucket === "weekday") residentOnCallRow.weekdayOnCall += 1;
      if (bucket === "thursday") residentOnCallRow.thursdayOnCall += 1;
      if (bucket === "friday") residentOnCallRow.fridayOnCall += 1;
      if (bucket === "saturday") residentOnCallRow.saturdayOnCall += 1;
    }

    const fridayMorningResidentDoctor = assignedDoctorFor(ROLE_CODES.FRIDAY_MORNING_RESIDENT);
    const fridayMorningResidentRow = fridayMorningResidentDoctor ? residentRows.get(fridayMorningResidentDoctor.id) : null;
    if (fridayMorningResidentRow) fridayMorningResidentRow.fridayMorning += 1;

    const halfDutyDoctors = [
      assignedDoctorFor(ROLE_CODES.HALF_RESIDENT),
      assignedDoctorFor(ROLE_CODES.HALF_SENIOR)
    ];
    halfDutyDoctors.forEach((doctor) => {
      if (!doctor) return;
      if (doctor.group === "resident") {
        const row = residentRows.get(doctor.id);
        if (!row) return;
        if (bucket === "weekday") row.weekdayHalfDuty += 1;
        if (bucket === "saturday") row.saturdayHalfDuty += 1;
        return;
      }

      const row = seniorRows.get(doctor.id);
      if (!row) return;
      if (bucket === "weekday") row.weekdayHalfDuty += 1;
      if (bucket === "saturday") row.saturdayHalfDuty += 1;
    });

    const fridayHalfSeniorDoctor = assignedDoctorFor(ROLE_CODES.HALF_SENIOR);
    const fridayHalfSeniorRow = fridayHalfSeniorDoctor?.group === "senior" ? seniorRows.get(fridayHalfSeniorDoctor.id) : null;
    if (fridayHalfSeniorRow && bucket === "friday") fridayHalfSeniorRow.fridayHalfDuty += 1;

    const seniorADoctor = assignedDoctorFor(ROLE_CODES.SENIOR_A);
    const seniorARow = seniorADoctor ? seniorRows.get(seniorADoctor.id) : null;
    if (seniorARow) {
      if (bucket === "weekday") seniorARow.weekdaySeniorA += 1;
      if (bucket === "thursday") seniorARow.thursdaySeniorA += 1;
      if (bucket === "friday") seniorARow.fridaySeniorA += 1;
      if (bucket === "saturday") seniorARow.saturdaySeniorA += 1;
    }

    const seniorBDoctor = assignedDoctorFor(ROLE_CODES.SENIOR_B);
    const seniorBRow = seniorBDoctor ? seniorRows.get(seniorBDoctor.id) : null;
    if (seniorBRow) {
      if (bucket === "weekday") seniorBRow.weekdaySeniorB += 1;
      if (bucket === "friday") seniorBRow.fridaySeniorB += 1;
      if (bucket === "saturday") seniorBRow.saturdaySeniorB += 1;
    }
  }

  return {
    residents: Array.from(residentRows.values()),
    seniors: Array.from(seniorRows.values())
  };
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
