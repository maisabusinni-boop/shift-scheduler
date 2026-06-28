import { roles } from "@/domain";
import type { WorkspaceData } from "@/types";

type LegacyWorkspace = Omit<WorkspaceData, "schemaVersion" | "revision" | "users" | "registrationRequests" | "changeRequests" | "auditLog"> & {
  schemaVersion?: number;
  revision?: number;
  users?: WorkspaceData["users"];
  registrationRequests?: WorkspaceData["registrationRequests"];
  changeRequests?: WorkspaceData["changeRequests"];
  auditLog?: WorkspaceData["auditLog"];
};

export function migrateWorkspace(input: unknown): WorkspaceData {
  const legacy = input as LegacyWorkspace;
  if (!legacy || typeof legacy !== "object") {
    throw new Error("Invalid workspace data.");
  }

  if (legacy.schemaVersion === 2 || legacy.schemaVersion === 3) {
    return normalizeWorkspace({
      ...(legacy as WorkspaceData),
      schemaVersion: 3,
      revision: legacy.revision ?? 0,
      users: legacy.users ?? [],
      registrationRequests: legacy.registrationRequests ?? [],
      changeRequests: legacy.changeRequests ?? [],
      auditLog: legacy.auditLog ?? []
    });
  }

  if (legacy.schemaVersion && legacy.schemaVersion !== 1) {
    throw new Error("Unsupported workspace schema.");
  }

  return normalizeWorkspace({
    ...(legacy as Omit<WorkspaceData, "schemaVersion">),
    schemaVersion: 3,
    revision: 0,
    users: [],
    registrationRequests: [],
    changeRequests: [],
    auditLog: [],
    driveSync: {
      ...legacy.driveSync,
      lastLoadedVersion: legacy.driveSync?.lastLoadedVersion ?? null,
      lastSavedVersion: legacy.driveSync?.lastSavedVersion ?? null
    }
  });
}

function normalizeWorkspace(data: WorkspaceData): WorkspaceData {
  const roleCodes = new Set(roles.map((role) => role.code));
  const schedules = Object.fromEntries(
    Object.entries(data.schedules).map(([key, schedule]) => [
      key,
      {
        ...schedule,
        revision: schedule.revision ?? 0,
        assignments: Object.fromEntries(Object.entries(schedule.assignments).filter(([assignmentKey]) => roleCodes.has(assignmentKey.split("|")[1] as never))),
        exclusions: schedule.exclusions.filter((exclusion) => exclusion.roleCode && roleCodes.has(exclusion.roleCode))
      }
    ])
  );
  const users = data.users
    .filter((user) => user.id !== "user-admin" && (user.username ?? "").trim().toLowerCase() !== "admin")
    .map((user) => ({
      ...user,
      username: (user.username ?? user.email.split("@")[0] ?? user.id).trim().toLowerCase()
    }));

  return {
    ...data,
    schemaVersion: 3,
    revision: data.revision ?? 0,
    roles,
    users,
    registrationRequests: (data.registrationRequests ?? []).map((request) => ({
      ...request,
      doctorName: String(request.doctorName ?? "").trim(),
      gmail: String(request.gmail ?? "").trim().toLowerCase(),
      username: String(request.username ?? "").trim().toLowerCase()
    })),
    schedules,
    changeRequests: data.changeRequests.filter((request) => roleCodes.has(request.roleCode)),
    calendar: {
      ...data.calendar,
      syncPending: data.calendar.syncPending ?? false,
      requestedRevision: data.calendar.requestedRevision ?? null,
      lastCompletedRevision: data.calendar.lastCompletedRevision ?? null,
      lastSyncAt: data.calendar.lastSyncAt ?? null,
      lastSyncError: data.calendar.lastSyncError ?? null,
      syncRecords: Object.fromEntries(
        Object.entries(data.calendar.syncRecords)
          .filter(([assignmentKey]) => roleCodes.has(assignmentKey.split("|")[1] as never))
          .map(([assignmentKey, record]) => [
            assignmentKey,
            {
              ...record,
              attendeeEmails: Array.isArray(record.attendeeEmails)
                ? record.attendeeEmails.map((email) => String(email).trim().toLowerCase()).filter(Boolean).sort()
                : []
            }
          ])
      )
    }
  };
}
