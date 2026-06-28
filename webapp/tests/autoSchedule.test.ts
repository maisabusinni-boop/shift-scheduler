import { describe, expect, it } from "vitest";
import { autoScheduleRoleCodes, generateAutoRoster } from "@/autoSchedule";
import { cellKey, ROLE_CODES, roles } from "@/domain";
import { buildMonthDays, nextDayKey } from "@/month";
import { createEmptySchedule } from "@/sampleData";
import type { Doctor } from "@/types";
import { validateSchedule } from "@/validation";

const doctors: Doctor[] = [
  { id: "resident-1", name: "Resident A", group: "resident", canAngio: false, active: true },
  { id: "resident-2", name: "Resident B", group: "resident", canAngio: false, active: true },
  { id: "resident-3", name: "Resident C", group: "resident", canAngio: false, active: true },
  { id: "resident-4", name: "Resident D", group: "resident", canAngio: false, active: true },
  { id: "senior-1", name: "Senior A", group: "senior", canAngio: true, active: true },
  { id: "senior-2", name: "Senior B", group: "senior", canAngio: true, active: true },
  { id: "senior-3", name: "Senior C", group: "senior", canAngio: true, active: true },
  { id: "senior-4", name: "Senior D", group: "senior", canAngio: true, active: true },
  { id: "senior-5", name: "Senior E", group: "senior", canAngio: true, active: true }
];

describe("generateAutoRoster", () => {
  it("exposes automatic scheduling to both planner roles", () => {
    expect(autoScheduleRoleCodes("chief-resident")).toEqual([
      ROLE_CODES.RESIDENT_ON_CALL,
      ROLE_CODES.HALF_RESIDENT,
      ROLE_CODES.FRIDAY_MORNING_RESIDENT
    ]);
    expect(autoScheduleRoleCodes("senior-planner")).toEqual([
      ROLE_CODES.SENIOR_A,
      ROLE_CODES.SENIOR_B,
      ROLE_CODES.ANGIO,
      ROLE_CODES.FRIDAY_MORNING_SENIOR,
      ROLE_CODES.HALF_SENIOR
    ]);
  });

  it("keeps Friday senior-a, Friday morning senior, and Saturday half senior linked", () => {
    const schedule = createEmptySchedule(2026, 6);
    const days = buildMonthDays(2026, 6);
    const dayKeys = new Set(days.map((day) => day.key));
    const assignments = generateAutoRoster(schedule, roles, doctors, days, { role: "senior-planner" });

    days.filter((day) => day.isFriday && dayKeys.has(nextDayKey(day.key))).forEach((friday) => {
      const saturday = nextDayKey(friday.key);
      const seniorA = assignments[cellKey(friday.key, ROLE_CODES.SENIOR_A)]?.doctorId;
      expect(assignments[cellKey(friday.key, ROLE_CODES.FRIDAY_MORNING_SENIOR)]?.doctorId).toBe(seniorA);
      expect(assignments[cellKey(saturday, ROLE_CODES.HALF_SENIOR)]?.doctorId).toBe(seniorA);
    });
  });

  it("does not generate validation errors for a staffed month", () => {
    const schedule = createEmptySchedule(2026, 6);
    const days = buildMonthDays(2026, 6);
    schedule.assignments = generateAutoRoster(schedule, roles, doctors, days, { role: "senior-planner" });

    const issues = validateSchedule(schedule, roles, doctors);
    expect(issues.filter((issue) => issue.severity === "error")).toHaveLength(0);
  });

  it("uses only seniors for automatic half-senior assignments", () => {
    const schedule = createEmptySchedule(2026, 6);
    const days = buildMonthDays(2026, 6);
    const assignments = generateAutoRoster(schedule, roles, doctors, days, { role: "senior-planner" });

    Object.entries(assignments).forEach(([key, assignment]) => {
      const [, roleCode] = key.split("|");
      if (roleCode !== ROLE_CODES.HALF_SENIOR || !assignment.doctorId) return;
      expect(doctors.find((doctor) => doctor.id === assignment.doctorId)?.group).toBe("senior");
    });
  });

  it("leaves half-senior empty when only residents are available", () => {
    const schedule = createEmptySchedule(2026, 6);
    const days = buildMonthDays(2026, 6);
    const assignments = generateAutoRoster(schedule, roles, doctors.filter((doctor) => doctor.group === "resident"), days, { role: "senior-planner" });

    expect(Object.keys(assignments).some((key) => key.endsWith(`|${ROLE_CODES.HALF_SENIOR}`))).toBe(false);
  });

  it("leaves Saturday half senior empty instead of breaking the Friday link", () => {
    const schedule = createEmptySchedule(2026, 6);
    schedule.exclusions.push({
      id: "exclude-saturday",
      doctorId: "senior-1",
      date: "2026-06-06",
      roleCode: ROLE_CODES.HALF_SENIOR,
      reason: ""
    });
    const availableDoctors = [doctors[4], doctors[0], doctors[1]];
    const days = buildMonthDays(2026, 6);
    const assignments = generateAutoRoster(schedule, roles, availableDoctors, days, { role: "senior-planner" });

    expect(assignments[cellKey("2026-06-06", ROLE_CODES.HALF_SENIOR)]?.doctorId).toBeUndefined();
    schedule.assignments = assignments;
    expect(validateSchedule(schedule, roles, availableDoctors).filter((issue) => issue.severity === "error")).toHaveLength(0);
  });

  it("chief resident auto-fill affects only resident columns and preserves manual cells", () => {
    const schedule = createEmptySchedule(2026, 6);
    const days = buildMonthDays(2026, 6);
    schedule.assignments[cellKey("2026-06-01", ROLE_CODES.RESIDENT_ON_CALL)] = { doctorId: "resident-1", pending: false };
    schedule.assignments[cellKey("2026-06-01", ROLE_CODES.SENIOR_A)] = { doctorId: "senior-1", pending: false };

    const assignments = generateAutoRoster(schedule, roles, doctors, days, { role: "chief-resident" });

    expect(assignments[cellKey("2026-06-01", ROLE_CODES.RESIDENT_ON_CALL)]).toEqual({ doctorId: "resident-1", pending: false });
    expect(assignments[cellKey("2026-06-01", ROLE_CODES.SENIOR_A)]).toEqual({ doctorId: "senior-1", pending: false });
    expect(assignments[cellKey("2026-06-01", ROLE_CODES.HALF_RESIDENT)]?.doctorId).not.toBe("resident-1");
    expect(assignments[cellKey("2026-06-02", ROLE_CODES.SENIOR_A)]).toBeUndefined();
    expect(assignments[cellKey("2026-06-02", ROLE_CODES.SENIOR_B)]).toBeUndefined();
    expect(assignments[cellKey("2026-06-02", ROLE_CODES.ANGIO)]).toBeUndefined();
    expect(assignments[cellKey("2026-06-05", ROLE_CODES.FRIDAY_MORNING_SENIOR)]).toBeUndefined();
  });

  it("senior planner auto-fill affects only senior columns and preserves manual cells", () => {
    const schedule = createEmptySchedule(2026, 6);
    const days = buildMonthDays(2026, 6);
    schedule.assignments[cellKey("2026-06-01", ROLE_CODES.RESIDENT_ON_CALL)] = { doctorId: "resident-1", pending: false };
    schedule.assignments[cellKey("2026-06-01", ROLE_CODES.SENIOR_A)] = { doctorId: "senior-1", pending: false };

    const assignments = generateAutoRoster(schedule, roles, doctors, days, { role: "senior-planner" });

    expect(assignments[cellKey("2026-06-01", ROLE_CODES.RESIDENT_ON_CALL)]).toEqual({ doctorId: "resident-1", pending: false });
    expect(assignments[cellKey("2026-06-01", ROLE_CODES.SENIOR_A)]).toEqual({ doctorId: "senior-1", pending: false });
    expect(assignments[cellKey("2026-06-02", ROLE_CODES.RESIDENT_ON_CALL)]).toBeUndefined();
    expect(assignments[cellKey("2026-06-02", ROLE_CODES.HALF_RESIDENT)]).toBeUndefined();
    expect(assignments[cellKey("2026-06-05", ROLE_CODES.FRIDAY_MORNING_RESIDENT)]).toBeUndefined();
  });

  it("fills linked senior Friday cells around a manually assigned Friday senior-a", () => {
    const schedule = createEmptySchedule(2026, 6);
    const days = buildMonthDays(2026, 6);
    schedule.assignments[cellKey("2026-06-05", ROLE_CODES.SENIOR_A)] = { doctorId: "senior-2", pending: false };

    const assignments = generateAutoRoster(schedule, roles, doctors, days, { role: "senior-planner" });

    expect(assignments[cellKey("2026-06-05", ROLE_CODES.SENIOR_A)]).toEqual({ doctorId: "senior-2", pending: false });
    expect(assignments[cellKey("2026-06-05", ROLE_CODES.FRIDAY_MORNING_SENIOR)]?.doctorId).toBe("senior-2");
    expect(assignments[cellKey("2026-06-06", ROLE_CODES.HALF_SENIOR)]?.doctorId).toBe("senior-2");
  });

  it("leaves pending and unsupported-scope cells untouched", () => {
    const schedule = createEmptySchedule(2026, 6);
    const days = buildMonthDays(2026, 6);
    schedule.assignments[cellKey("2026-06-01", ROLE_CODES.HALF_RESIDENT)] = { doctorId: null, pending: true };

    const assignments = generateAutoRoster(schedule, roles, doctors, days, { role: "admin" });

    expect(assignments).toEqual(schedule.assignments);
    expect(autoScheduleRoleCodes("admin")).toHaveLength(0);
  });
});
