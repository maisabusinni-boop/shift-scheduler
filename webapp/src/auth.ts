import { createId } from "@/domain";
import type { AppRole, AppUser, Doctor, WorkspaceData } from "@/types";

export type SessionUser = {
  username: string;
  name: string;
};

export type SessionState =
  | { status: "signed-out"; currentUser: null; appUser: null; role: null; doctor: null }
  | { status: "bootstrap"; currentUser: SessionUser; appUser: null; role: "senior-planner"; doctor: null }
  | { status: "recognized"; currentUser: SessionUser; appUser: AppUser; role: AppRole; doctor: Doctor | null }
  | { status: "blocked"; currentUser: SessionUser; appUser: null; role: null; doctor: null };

export function normalizeUsername(username: string) {
  return username.trim().toLowerCase();
}

export function resolveSession(data: WorkspaceData, currentUser: SessionUser | null): SessionState {
  if (!currentUser) return { status: "signed-out", currentUser: null, appUser: null, role: null, doctor: null };
  const username = normalizeUsername(currentUser.username);
  
  const hasPlanner = data.users.some((user) => user.active && user.role === "senior-planner");
  if (!hasPlanner) return { status: "bootstrap", currentUser: { ...currentUser, username }, appUser: null, role: "senior-planner", doctor: null };

  const appUser = data.users.find((user) => {
    const uName = (user.username ?? (user.email ? user.email.split('@')[0] : user.id)).toLowerCase();
    return uName === username && user.active;
  });
  
  if (!appUser) return { status: "blocked", currentUser: { ...currentUser, username }, appUser: null, role: null, doctor: null };
  const doctor = appUser.doctorId ? data.doctors.find((candidate) => candidate.id === appUser.doctorId) ?? null : null;
  return { status: "recognized", currentUser: { ...currentUser, username }, appUser, role: appUser.role, doctor };
}

export function createBootstrapPlanner(currentUser: SessionUser, passwordHash: string): AppUser {
  return {
    id: createId("user"),
    username: normalizeUsername(currentUser.username),
    email: normalizeUsername(currentUser.username) + "@local",
    name: currentUser.name || currentUser.username,
    role: "senior-planner",
    doctorId: null,
    active: true,
    createdAt: new Date().toISOString(),
    passwordHash
  };
}
