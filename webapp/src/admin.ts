import type { AuditInput } from "@/audit";
import type { WorkspaceData } from "@/types";

export function removeDoctorAndLinkedAccess(data: WorkspaceData, doctorId: string): AuditInput | void {
  const before = {
    doctor: data.doctors.find((candidate) => candidate.id === doctorId) ?? null,
    linkedUsers: data.users.filter((user) => user.doctorId === doctorId),
    schedules: Object.fromEntries(Object.entries(data.schedules).map(([scheduleKey, item]) => [scheduleKey, {
      assignments: Object.entries(item.assignments).filter(([, assignment]) => assignment.doctorId === doctorId).map(([key]) => key),
      exclusions: item.exclusions.filter((exclusion) => exclusion.doctorId === doctorId).map((exclusion) => exclusion.id)
    }]))
  };

  if (!before.doctor) return;

  data.doctors = data.doctors.filter((candidate) => candidate.id !== doctorId);
  data.users = data.users.filter((user) => user.doctorId !== doctorId);

  Object.values(data.schedules).forEach((item) => {
    Object.entries(item.assignments).forEach(([assignmentKey, assignment]) => {
      if (assignment.doctorId === doctorId) item.assignments[assignmentKey] = { doctorId: null, pending: false };
    });
    item.exclusions = item.exclusions.filter((exclusion) => exclusion.doctorId !== doctorId);
    item.validation.stale = true;
  });

  data.changeRequests = data.changeRequests.filter((request) => (
    request.requesterDoctorId !== doctorId &&
    request.currentDoctorId !== doctorId &&
    request.proposedDoctorId !== doctorId &&
    request.sourceDoctorId !== doctorId
  ));

  return { action: "doctor-remove", entityType: "doctor", entityId: doctorId, before, after: null };
}
