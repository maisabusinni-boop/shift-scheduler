import { createId } from "@/domain";
import type { AppRole, AppUser, ChangeRequest, MonthSchedule, RoleCode } from "@/types";

export function createChangeRequest(input: {
  schedule: MonthSchedule;
  requesterUser: AppUser;
  date: string;
  roleCode: RoleCode;
  proposedDoctorId: string | null;
  reason: string;
}): ChangeRequest {
  const now = new Date().toISOString();
  const key = `${input.date}|${input.roleCode}`;
  const current = input.schedule.assignments[key];
  return {
    id: createId("request"),
    scheduleKey: input.schedule.key,
    requesterDoctorId: input.requesterUser.doctorId ?? "",
    requesterUserId: input.requesterUser.id,
    requesterRole: input.requesterUser.role,
    date: input.date,
    roleCode: input.roleCode,
    currentDoctorId: current?.doctorId ?? null,
    proposedDoctorId: input.proposedDoctorId,
    reason: input.reason.trim(),
    status: input.requesterUser.role === "senior" ? "senior-confirmed" : "submitted",
    resolutionNote: "",
    createdAt: now,
    updatedAt: now,
    decidedAt: null,
    decidedByUserId: null,
    appliedAt: null,
    appliedByUserId: null
  };
}

export function nextRequestStatusForDecision(status: ChangeRequest["status"], decision: "approve" | "reject", actorRole: AppRole) {
  if (decision === "reject") return "rejected" as const;
  if (actorRole === "senior-planner" || actorRole === "chief-resident") return "approved" as const;
  return status;
}
