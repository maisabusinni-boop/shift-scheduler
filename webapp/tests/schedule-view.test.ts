import { describe, expect, it } from "vitest";
import { cellKey, ROLE_CODES, roles } from "@/domain";
import { buildMonthDays } from "@/month";
import { createEmptySchedule } from "@/sampleData";
import {
  buildAssignmentCountsByDay,
  buildOwnAssignmentDayKeys,
  buildScheduleView,
  currentWeekIndexForSchedule,
  splitMonthWeeks
} from "@/scheduleView";

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
