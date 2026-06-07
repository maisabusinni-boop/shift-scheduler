import { describe, expect, it } from "vitest";
import { exclusionRolesForDoctor, ROLE_CODES } from "@/domain";
import type { Doctor } from "@/types";

const seniorDoctor: Doctor = { id: "senior", name: "Senior", group: "senior", canAngio: false, active: true };
const residentDoctor: Doctor = { id: "resident", name: "Resident", group: "resident", canAngio: false, active: true };

describe("exclusionRolesForDoctor", () => {
  it("returns only senior blocker roles for senior doctors", () => {
    expect(exclusionRolesForDoctor(seniorDoctor).map((role) => role.code)).toEqual([
      ROLE_CODES.SENIOR_A,
      ROLE_CODES.HALF_RESIDENT,
      ROLE_CODES.HALF_SENIOR
    ]);
  });

  it("returns only resident blocker roles for resident doctors", () => {
    expect(exclusionRolesForDoctor(residentDoctor).map((role) => role.code)).toEqual([
      ROLE_CODES.RESIDENT_ON_CALL,
      ROLE_CODES.HALF_RESIDENT,
      ROLE_CODES.HALF_SENIOR,
      ROLE_CODES.FRIDAY_MORNING_RESIDENT
    ]);
  });

  it("keeps the generic senior on-call label on the senior blocker", () => {
    const seniorOnCall = exclusionRolesForDoctor(seniorDoctor)[0];
    expect(seniorOnCall.code).toBe(ROLE_CODES.SENIOR_A);
    expect(seniorOnCall.name).toBe("כונן");
  });
});
