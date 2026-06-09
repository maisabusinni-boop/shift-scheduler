import { describe, expect, it } from "vitest";
import { cellKey, ROLE_CODES, roles } from "@/domain";
import { buildMonthDays } from "@/month";
import { createEmptySchedule } from "@/sampleData";
import {
  buildAssignmentCountsByDay,
  buildDutyDistribution,
  buildOwnAssignmentDayKeys,
  buildScheduleView,
  currentWeekIndexForSchedule,
  splitMonthWeeks
} from "@/scheduleView";
import type { Doctor } from "@/types";

const dutyDoctors: Doctor[] = [
  { id: "resident-a", name: "Resident A", group: "resident", canAngio: false, active: true },
  { id: "resident-b", name: "Resident B", group: "resident", canAngio: false, active: true },
  { id: "senior-a", name: "Senior A", group: "senior", canAngio: false, active: true },
  { id: "senior-b", name: "Senior B", group: "senior", canAngio: false, active: true },
  { id: "inactive-resident", name: "Inactive Resident", group: "resident", canAngio: false, active: false }
];

describe("schedule view helpers", () => {
  it("splits month days into calendar weeks", () => {
    const weeks = splitMonthWeeks(buildMonthDays(2026, 5));

    expect(weeks).toHaveLength(6);
    expect(weeks[0].map((day) => day.key)).toEqual(["2026-05-01", "2026-05-02"]);
    expect(weeks[1][0].key).toBe("2026-05-03");
  });

  it("selects the week containing today when the active schedule matches", () => {
    const schedule = createEmptySchedule(2026, 5);
    const days = buildMonthDays(2026, 5);

    expect(currentWeekIndexForSchedule(schedule, days, new Date("2026-05-11T08:00:00.000Z"))).toBe(2);
    expect(currentWeekIndexForSchedule(schedule, days, new Date("2026-06-11T08:00:00.000Z"))).toBe(0);
  });

  it("filters mine lens to days assigned to the linked doctor", () => {
    const schedule = createEmptySchedule(2026, 5);
    const days = buildMonthDays(2026, 5);
    schedule.assignments[cellKey("2026-05-03", ROLE_CODES.RESIDENT_ON_CALL)] = { doctorId: "doctor-a", pending: false };
    schedule.assignments[cellKey("2026-05-04", ROLE_CODES.SENIOR_A)] = { doctorId: "doctor-b", pending: false };

    const view = buildScheduleView(schedule, roles, days, "mine", 0, "doctor-a");

    expect(view.visibleDays.map((day) => day.key)).toEqual(["2026-05-03"]);
    expect(view.ownAssignmentDayKeys.has("2026-05-03")).toBe(true);
    expect(view.mineCount).toBe(1);
  });

  it("counts assigned and pending cells per day", () => {
    const schedule = createEmptySchedule(2026, 5);
    const days = buildMonthDays(2026, 5);
    schedule.assignments[cellKey("2026-05-03", ROLE_CODES.RESIDENT_ON_CALL)] = { doctorId: "doctor-a", pending: false };
    schedule.assignments[cellKey("2026-05-03", ROLE_CODES.SENIOR_A)] = { doctorId: null, pending: true };
    schedule.assignments[cellKey("2026-05-03", ROLE_CODES.ANGIO)] = { doctorId: null, pending: false };

    const counts = buildAssignmentCountsByDay(schedule, roles, days);

    expect(counts.get("2026-05-03")).toBe(2);
    expect(counts.get("2026-05-04")).toBe(0);
  });

  it("returns no mine assignments when the user is not linked to a doctor", () => {
    const schedule = createEmptySchedule(2026, 5);
    const days = buildMonthDays(2026, 5);
    schedule.assignments[cellKey("2026-05-03", ROLE_CODES.RESIDENT_ON_CALL)] = { doctorId: "doctor-a", pending: false };

    expect(buildOwnAssignmentDayKeys(schedule, roles, days, null).size).toBe(0);

    const view = buildScheduleView(schedule, roles, days, "mine", 0, null);
    expect(view.visibleDays).toHaveLength(0);
    expect(view.mineCount).toBe(0);
  });

  it("keeps holiday metadata in schedule view days", () => {
    const schedule = createEmptySchedule(2026, 9);
    const days = buildMonthDays(2026, 9);

    const view = buildScheduleView(schedule, roles, days, "month", 0, null);
    const yomKippur = view.visibleDays.find((day) => day.key === "2026-09-21");

    expect(yomKippur?.isJewishHoliday).toBe(true);
    expect(yomKippur?.allowsFridayRoles).toBe(true);
    expect(yomKippur?.holidayName).toContain("כִּפּוּר");
  });
});

describe("duty distribution helpers", () => {
  it("builds rows for all active doctors with zeroes", () => {
    const schedule = createEmptySchedule(2026, 5);
    const distribution = buildDutyDistribution(schedule, dutyDoctors, buildMonthDays(2026, 5));

    expect(distribution.residents.map((row) => row.doctor.id)).toEqual(["resident-a", "resident-b"]);
    expect(distribution.seniors.map((row) => row.doctor.id)).toEqual(["senior-a", "senior-b"]);
    expect(distribution.residents[0].weekdayOnCall).toBe(0);
    expect(distribution.seniors[0].weekdaySeniorA).toBe(0);
    expect(distribution.seniors[0].weekdaySeniorB).toBe(0);
  });

  it("counts resident assignments by weekday bucket and friday morning role", () => {
    const schedule = createEmptySchedule(2026, 5);
    const days = buildMonthDays(2026, 5);
    schedule.assignments[cellKey("2026-05-03", ROLE_CODES.RESIDENT_ON_CALL)] = { doctorId: "resident-a", pending: false };
    schedule.assignments[cellKey("2026-05-07", ROLE_CODES.RESIDENT_ON_CALL)] = { doctorId: "resident-a", pending: false };
    schedule.assignments[cellKey("2026-05-08", ROLE_CODES.RESIDENT_ON_CALL)] = { doctorId: "resident-a", pending: false };
    schedule.assignments[cellKey("2026-05-09", ROLE_CODES.RESIDENT_ON_CALL)] = { doctorId: "resident-a", pending: false };
    schedule.assignments[cellKey("2026-05-08", ROLE_CODES.FRIDAY_MORNING_RESIDENT)] = { doctorId: "resident-a", pending: false };
    schedule.assignments[cellKey("2026-05-03", ROLE_CODES.HALF_RESIDENT)] = { doctorId: "resident-b", pending: false };
    schedule.assignments[cellKey("2026-05-09", ROLE_CODES.HALF_SENIOR)] = { doctorId: "resident-b", pending: false };
    schedule.assignments[cellKey("2026-05-10", ROLE_CODES.RESIDENT_ON_CALL)] = { doctorId: null, pending: true };

    const distribution = buildDutyDistribution(schedule, dutyDoctors, days);
    const residentA = distribution.residents.find((row) => row.doctor.id === "resident-a");
    const residentB = distribution.residents.find((row) => row.doctor.id === "resident-b");

    expect(residentA).toMatchObject({
      weekdayOnCall: 1,
      thursdayOnCall: 1,
      fridayOnCall: 1,
      fridayMorning: 1,
      saturdayOnCall: 1
    });
    expect(residentB).toMatchObject({
      weekdayHalfDuty: 1,
      saturdayHalfDuty: 1
    });
  });

  it("counts senior split A/B assignments and senior half friday", () => {
    const schedule = createEmptySchedule(2026, 5);
    const days = buildMonthDays(2026, 5);
    schedule.assignments[cellKey("2026-05-03", ROLE_CODES.SENIOR_A)] = { doctorId: "senior-a", pending: false };
    schedule.assignments[cellKey("2026-05-04", ROLE_CODES.SENIOR_B)] = { doctorId: "senior-a", pending: false };
    schedule.assignments[cellKey("2026-05-07", ROLE_CODES.SENIOR_A)] = { doctorId: "senior-a", pending: false };
    schedule.assignments[cellKey("2026-05-08", ROLE_CODES.SENIOR_A)] = { doctorId: "senior-a", pending: false };
    schedule.assignments[cellKey("2026-05-08", ROLE_CODES.SENIOR_B)] = { doctorId: "senior-a", pending: false };
    schedule.assignments[cellKey("2026-05-09", ROLE_CODES.SENIOR_A)] = { doctorId: "senior-a", pending: false };
    schedule.assignments[cellKey("2026-05-09", ROLE_CODES.SENIOR_B)] = { doctorId: "senior-a", pending: false };
    schedule.assignments[cellKey("2026-05-03", ROLE_CODES.HALF_SENIOR)] = { doctorId: "senior-b", pending: false };
    schedule.assignments[cellKey("2026-05-08", ROLE_CODES.HALF_SENIOR)] = { doctorId: "senior-b", pending: false };
    schedule.assignments[cellKey("2026-05-09", ROLE_CODES.HALF_RESIDENT)] = { doctorId: "senior-b", pending: false };

    const distribution = buildDutyDistribution(schedule, dutyDoctors, days);
    const seniorA = distribution.seniors.find((row) => row.doctor.id === "senior-a");
    const seniorB = distribution.seniors.find((row) => row.doctor.id === "senior-b");

    expect(seniorA).toMatchObject({
      weekdaySeniorA: 1,
      weekdaySeniorB: 1,
      thursdaySeniorA: 1,
      fridaySeniorA: 1,
      fridaySeniorB: 1,
      saturdaySeniorA: 1,
      saturdaySeniorB: 1
    });
    expect(seniorB).toMatchObject({
      weekdayHalfDuty: 1,
      fridayHalfDuty: 1,
      saturdayHalfDuty: 1
    });
  });

  it("buckets major holidays into saturday duty counts", () => {
    const schedule = createEmptySchedule(2026, 9);
    const days = buildMonthDays(2026, 9);
    schedule.assignments[cellKey("2026-09-21", ROLE_CODES.RESIDENT_ON_CALL)] = { doctorId: "resident-a", pending: false };
    schedule.assignments[cellKey("2026-09-21", ROLE_CODES.SENIOR_A)] = { doctorId: "senior-a", pending: false };
    schedule.assignments[cellKey("2026-09-21", ROLE_CODES.SENIOR_B)] = { doctorId: "senior-a", pending: false };

    const distribution = buildDutyDistribution(schedule, dutyDoctors, days);
    const resident = distribution.residents.find((row) => row.doctor.id === "resident-a");
    const senior = distribution.seniors.find((row) => row.doctor.id === "senior-a");

    expect(resident?.saturdayOnCall).toBe(1);
    expect(resident?.weekdayOnCall).toBe(0);
    expect(senior?.saturdaySeniorA).toBe(1);
    expect(senior?.saturdaySeniorB).toBe(1);
    expect(senior?.weekdaySeniorA).toBe(0);
  });
});
