import type { AppRole, AppUser, ChangeRequest, Doctor, MonthSchedule } from "@/types";

export function canUsePlannerTools(role: AppRole | null) {
  return role === "senior-planner";
}

export function canEditDraftRoster(role: AppRole | null) {
  return role === "senior-planner" || role === "chief-resident";
}

export function canPublish(role: AppRole | null) {
  return role === "senior-planner";
}

export function canManageUsers(role: AppRole | null) {
  return role === "senior-planner";
}

export function canSeeFullAudit(role: AppRole | null) {
  return role === "senior-planner";
}

export function canReviewRequests(role: AppRole | null) {
  return role === "senior-planner" || role === "chief-resident";
}

export function canApplyRequest(role: AppRole | null, request: ChangeRequest) {
  if (role === "senior-planner") return true;
  return role === "chief-resident" && (request.status === "approved" || request.status === "senior-confirmed");
}

export function canEditRoster(role: AppRole | null, schedule: MonthSchedule) {
  return canEditDraftRoster(role) && schedule.status === "draft";
}

export function canSeeSchedule(role: AppRole | null, schedule: MonthSchedule) {
  if (role === "senior-planner" || role === "chief-resident") return true;
  return schedule.status === "published";
}

export function canEditOwnRecords(role: AppRole | null) {
  return role === "resident" || role === "senior" || role === "chief-resident" || role === "senior-planner";
}

export function isOwnDoctor(appUser: AppUser | null, doctor: Doctor | null, doctorId: string) {
  if (!appUser) return false;
  if (appUser.role === "senior-planner") return true;
  return doctor?.id === doctorId;
}
