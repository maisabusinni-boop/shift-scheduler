import { describe, expect, it } from "vitest";
import { resolveDoctorAccountRole } from "@/doctorAccount";

describe("doctor account role", () => {
  it("preserves the linked user's role when another doctor field is saved", () => {
    expect(resolveDoctorAccountRole(undefined, "chief-resident", "resident")).toBe("chief-resident");
  });

  it("uses an explicitly selected role", () => {
    expect(resolveDoctorAccountRole("senior-planner", "senior", "senior")).toBe("senior-planner");
  });

  it("falls back to the doctor group for a new account", () => {
    expect(resolveDoctorAccountRole(undefined, undefined, "resident")).toBe("resident");
    expect(resolveDoctorAccountRole(undefined, undefined, "senior")).toBe("senior");
  });
});
