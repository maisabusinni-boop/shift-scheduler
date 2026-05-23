import { describe, expect, it } from "vitest";
import { cellKey, ROLE_CODES, roles } from "@/domain";
import { createEmptySchedule } from "@/sampleData";
import type { Doctor } from "@/types";
import { validateSchedule } from "@/validation";

const doctors: Doctor[] = [
  { id: "resident", name: "מתמחה", group: "resident", canAngio: false, active: true },
  { id: "senior", name: "בכיר", group: "senior", canAngio: false, active: true },
  { id: "angio", name: "אנגיו", group: "senior", canAngio: true, active: true }
];

describe("validateSchedule", () => {
  it("blocks ineligible doctors", () => {
    const schedule = createEmptySchedule(2026, 5);
    schedule.assignments[cellKey("2026-05-03", ROLE_CODES.SENIOR_A)] = { doctorId: "resident", pending: false };
    const issues = validateSchedule(schedule, roles, doctors);
    expect(issues.some((issue) => issue.severity === "error" && issue.message.includes("לא מתאים"))).toBe(true);
  });

  it("ignores pending assignments", () => {
    const schedule = createEmptySchedule(2026, 5);
    schedule.assignments[cellKey("2026-05-03", ROLE_CODES.SENIOR_A)] = { doctorId: null, pending: true };
    const issues = validateSchedule(schedule, roles, doctors);
    expect(issues).toHaveLength(0);
  });

  it("blocks exclusions", () => {
    const schedule = createEmptySchedule(2026, 5);
    schedule.assignments[cellKey("2026-05-03", ROLE_CODES.SENIOR_A)] = { doctorId: "senior", pending: false };
    schedule.exclusions.push({ id: "ex", doctorId: "senior", date: "2026-05-03", roleCode: ROLE_CODES.SENIOR_A, reason: "" });
    const issues = validateSchedule(schedule, roles, doctors);
    expect(issues.some((issue) => issue.message.includes("חסום"))).toBe(true);
  });

  it("allows the Friday senior duplicate pair", () => {
    const schedule = createEmptySchedule(2026, 5);
    schedule.assignments[cellKey("2026-05-01", ROLE_CODES.SENIOR_A)] = { doctorId: "senior", pending: false };
    schedule.assignments[cellKey("2026-05-01", ROLE_CODES.FRIDAY_MORNING_SENIOR)] = { doctorId: "senior", pending: false };
    schedule.assignments[cellKey("2026-05-02", ROLE_CODES.HALF_SENIOR)] = { doctorId: "senior", pending: false };
    const issues = validateSchedule(schedule, roles, doctors);
    expect(issues.some((issue) => issue.message.includes("פעמיים"))).toBe(false);
  });

  it("blocks duplicate same-day assignments", () => {
    const schedule = createEmptySchedule(2026, 5);
    schedule.assignments[cellKey("2026-05-03", ROLE_CODES.SENIOR_A)] = { doctorId: "senior", pending: false };
    schedule.assignments[cellKey("2026-05-03", ROLE_CODES.SENIOR_B)] = { doctorId: "senior", pending: false };
    const issues = validateSchedule(schedule, roles, doctors);
    expect(issues.some((issue) => issue.severity === "error" && issue.message.includes("פעמיים"))).toBe(true);
  });
});
