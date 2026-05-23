import { roles } from "@/domain";
import type { WorkspaceData } from "@/types";

type LegacyWorkspace = Omit<WorkspaceData, "schemaVersion" | "users" | "changeRequests" | "auditLog"> & {
  schemaVersion?: number;
  users?: WorkspaceData["users"];
  changeRequests?: WorkspaceData["changeRequests"];
  auditLog?: WorkspaceData["auditLog"];
};

export function migrateWorkspace(input: unknown): WorkspaceData {
  const legacy = input as LegacyWorkspace;
  if (!legacy || typeof legacy !== "object") {
    throw new Error("Invalid workspace data.");
  }

  if (legacy.schemaVersion === 2) {
    return normalizeWorkspace({
      ...(legacy as WorkspaceData),
      users: legacy.users ?? [],
      changeRequests: legacy.changeRequests ?? [],
      auditLog: legacy.auditLog ?? []
    });
  }

  if (legacy.schemaVersion && legacy.schemaVersion !== 1) {
    throw new Error("Unsupported workspace schema.");
  }

  return normalizeWorkspace({
    ...(legacy as Omit<WorkspaceData, "schemaVersion">),
    schemaVersion: 2,
    users: [],
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
  const retiredRoles = new Set(["senior-b", "friday-morning-senior"]);
  const roleCodes = new Set(roles.map((role) => role.code));
  const schedules = Object.fromEntries(
    Object.entries(data.schedules).map(([key, schedule]) => [
      key,
      {
        ...schedule,
        assignments: Object.fromEntries(Object.entries(schedule.assignments).filter(([assignmentKey]) => !retiredRoles.has(assignmentKey.split("|")[1]))),
        exclusions: schedule.exclusions.filter((exclusion) => exclusion.roleCode && roleCodes.has(exclusion.roleCode))
      }
    ])
  );

  return {
    ...data,
    roles,
    schedules,
    changeRequests: data.changeRequests.filter((request) => roleCodes.has(request.roleCode)),
    calendar: {
      ...data.calendar,
      syncRecords: Object.fromEntries(Object.entries(data.calendar.syncRecords).filter(([assignmentKey]) => !retiredRoles.has(assignmentKey.split("|")[1])))
    }
  };
}
