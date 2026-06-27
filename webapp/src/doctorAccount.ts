import type { AppRole, DoctorGroup } from "@/types";

export function resolveDoctorAccountRole(
  draftRole: AppRole | undefined,
  existingRole: AppRole | undefined,
  doctorGroup: DoctorGroup
): AppRole {
  return draftRole ?? existingRole ?? (doctorGroup === "senior" ? "senior" : "resident");
}
