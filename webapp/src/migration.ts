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
    return {
      ...(legacy as WorkspaceData),
      users: legacy.users ?? [],
      changeRequests: legacy.changeRequests ?? [],
      auditLog: legacy.auditLog ?? []
    };
  }

  if (legacy.schemaVersion && legacy.schemaVersion !== 1) {
    throw new Error("Unsupported workspace schema.");
  }

  return {
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
  };
}
