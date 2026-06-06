import type { AppUser, WorkspaceData } from "@/types";

export const ADMIN_USERNAME = "admin";
export const ADMIN_PASSWORD_HASH = "d9ba7b80630bd458c838b4845c325015939a38fc40e1567e1c543eda05c9a096";

export const ADMIN_USER: AppUser = {
  id: "user-admin",
  username: ADMIN_USERNAME,
  email: "admin@local",
  name: "admin",
  role: "admin",
  doctorId: null,
  active: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  passwordHash: ADMIN_PASSWORD_HASH
};

export function ensureAdminAccount(data: WorkspaceData): WorkspaceData {
  const users = Array.isArray(data.users) ? data.users : [];
  const adminIndex = users.findIndex((user) => {
    const username = (user.username ?? (user.email ? user.email.split("@")[0] : user.id)).trim().toLowerCase();
    return username === ADMIN_USERNAME || user.id === ADMIN_USER.id;
  });

  const adminUser: AppUser = {
    ...ADMIN_USER,
    ...(adminIndex >= 0 ? users[adminIndex] : {}),
    id: ADMIN_USER.id,
    username: ADMIN_USERNAME,
    email: ADMIN_USER.email,
    name: ADMIN_USER.name,
    role: "admin",
    doctorId: null,
    active: true,
    passwordHash: ADMIN_PASSWORD_HASH
  };

  const nextUsers = adminIndex >= 0
    ? users.map((user, index) => index === adminIndex ? adminUser : user)
    : [adminUser, ...users];

  return { ...data, users: nextUsers };
}
