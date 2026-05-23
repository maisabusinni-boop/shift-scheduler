import { createId } from "@/domain";
import type { AppRole, AppUser, CurrentUser, Doctor, WorkspaceData } from "@/types";

export type SessionState =
  | { status: "signed-out"; googleUser: null; appUser: null; role: null; doctor: null }
  | { status: "bootstrap"; googleUser: CurrentUser; appUser: null; role: "senior-planner"; doctor: null }
  | { status: "recognized"; googleUser: CurrentUser; appUser: AppUser; role: AppRole; doctor: Doctor | null }
  | { status: "blocked"; googleUser: CurrentUser; appUser: null; role: null; doctor: null };

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function resolveSession(data: WorkspaceData, googleUser: CurrentUser | null): SessionState {
  if (!googleUser) return { status: "signed-out", googleUser: null, appUser: null, role: null, doctor: null };
  const email = normalizeEmail(googleUser.email);
  if (data.users.length === 0) return { status: "bootstrap", googleUser: { ...googleUser, email }, appUser: null, role: "senior-planner", doctor: null };

  const appUser = data.users.find((user) => normalizeEmail(user.email) === email && user.active);
  if (!appUser) return { status: "blocked", googleUser: { ...googleUser, email }, appUser: null, role: null, doctor: null };
  const doctor = appUser.doctorId ? data.doctors.find((candidate) => candidate.id === appUser.doctorId) ?? null : null;
  return { status: "recognized", googleUser: { ...googleUser, email }, appUser, role: appUser.role, doctor };
}

export function createBootstrapPlanner(googleUser: CurrentUser): AppUser {
  return {
    id: createId("user"),
    email: normalizeEmail(googleUser.email),
    name: googleUser.name || googleUser.email,
    role: "senior-planner",
    doctorId: null,
    active: true,
    createdAt: new Date().toISOString()
  };
}
