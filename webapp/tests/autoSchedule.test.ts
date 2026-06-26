import { describe, expect, it } from "vitest";
import { generateAutoRoster } from "@/autoSchedule";
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
  it("keeps Friday senior-a, Friday morning senior, and Saturday half senior linked", () => {
    const schedule = createEmptySchedule(2026, 6);
    const days = buildMonthDays(2026, 6);
    const dayKeys = new Set(days.map((day) => day.key));
    const assignments = generateAutoRoster(schedule, roles, doctors, days);

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
    schedule.assignments = generateAutoRoster(schedule, roles, doctors, days);

    const issues = validateSchedule(schedule, roles, doctors);
    expect(issues.filter((issue) => issue.severity === "error")).toHaveLength(0);
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
    const assignments = generateAutoRoster(schedule, roles, availableDoctors, days);

    expect(assignments[cellKey("2026-06-06", ROLE_CODES.HALF_SENIOR)]?.doctorId).toBeUndefined();
    schedule.assignments = assignments;
    expect(validateSchedule(schedule, roles, availableDoctors).filter((issue) => issue.severity === "error")).toHaveLength(0);
  });
});
