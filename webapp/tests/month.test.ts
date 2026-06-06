import { describe, expect, it } from "vitest";
import { buildMonthDays, isFridayRoleAllowedDate } from "@/month";

describe("Jewish holiday month days", () => {
  it("marks major Israel holidays in September 2026", () => {
    const days = buildMonthDays(2026, 9);
    const byKey = new Map(days.map((day) => [day.key, day]));

    expect(byKey.get("2026-09-12")?.isJewishHoliday).toBe(true);
    expect(byKey.get("2026-09-13")?.isJewishHoliday).toBe(true);
    expect(byKey.get("2026-09-21")?.isJewishHoliday).toBe(true);
    expect(byKey.get("2026-09-12")?.holidayName).toContain("רֹאשׁ");
    expect(byKey.get("2026-09-21")?.holidayName).toContain("כִּפּוּר");
  });

  it("allows Friday-only roles on major holidays and actual Fridays", () => {
    expect(isFridayRoleAllowedDate("2026-09-21")).toBe(true);
    expect(isFridayRoleAllowedDate("2026-09-18")).toBe(true);
    expect(isFridayRoleAllowedDate("2026-09-14")).toBe(false);
  });

  it("does not treat Chanukah as a Friday-role holiday", () => {
    const days = buildMonthDays(2026, 12);
    const chanukahWeekday = days.find((day) => day.key === "2026-12-08");

    expect(chanukahWeekday?.isFriday).toBe(false);
    expect(chanukahWeekday?.isJewishHoliday).toBe(false);
    expect(chanukahWeekday?.allowsFridayRoles).toBe(false);
  });
});
