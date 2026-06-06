import type { AppRole, AppUser, ChangeRequest, Doctor, MonthSchedule } from "@/types";

export function canUsePlannerTools(role: AppRole | null) {
  return role === "senior-planner" || role === "admin";
}

export function canEditDraftRoster(role: AppRole | null) {
  return role === "senior-planner" || role === "chief-resident" || role === "admin";
}

export function canPublish(role: AppRole | null) {
  return role === "senior-planner" || role === "admin";
}

export function canManageUsers(role: AppRole | null) {
  return role === "senior-planner" || role === "admin";
}

export function canSeeFullAudit(role: AppRole | null) {
  return role === "senior-planner" || role === "admin";
}

export function canReviewRequests(role: AppRole | null) {
  return role === "senior-planner" || role === "chief-resident" || role === "admin";
}

export function canApplyRequest(role: AppRole | null, request: ChangeRequest) {
  if (role === "senior-planner" || role === "admin") return true;
  return role === "chief-resident" && (request.status === "approved" || request.status === "senior-confirmed");
}

export function canEditRoster(role: AppRole | null, schedule: MonthSchedule) {
  return canEditDraftRoster(role) && schedule.status === "draft";
}

export function canSeeSchedule(role: AppRole | null, schedule: MonthSchedule) {
  if (role === "senior-planner" || role === "chief-resident" || role === "admin") return true;
  return schedule.status === "published";
}

export function canEditOwnRecords(role: AppRole | null) {
  return role === "resident" || role === "senior" || role === "chief-resident" || role === "senior-planner" || role === "admin";
}

export function isOwnDoctor(appUser: AppUser | null, doctor: Doctor | null, doctorId: string) {
  if (!appUser) return false;
  if (appUser.role === "senior-planner" || appUser.role === "admin") return true;
  return doctor?.id === doctorId;
}
