import { createId } from "@/domain";
import type { AppRole, AuditEntityType, AuditEntry, CurrentUser, DriveSyncState, RoleCode } from "@/types";

export type ActorContext = {
  googleUser: CurrentUser | null;
  appUserId: string | null;
  appRole: AppRole | "unrecognized";
  deviceId: string;
  driveSync: DriveSyncState;
};

export type AuditInput = {
  action: string;
  entityType: AuditEntityType;
  entityId: string;
  scheduleKey?: string;
  date?: string;
  roleCode?: RoleCode;
  before: unknown;
  after: unknown;
  snapshotFileId?: string;
  snapshotUrl?: string;
};

export function createAuditEntry(actor: ActorContext, input: AuditInput): AuditEntry {
  const timestamp = new Date().toISOString();
  return {
    id: createId("audit"),
    timestamp,
    displayTime: new Date(timestamp).toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" }),
    actorEmail: actor.googleUser?.email ?? "local-demo",
    actorName: actor.googleUser?.name ?? "Local demo",
    actorUserId: actor.appUserId,
    actorRole: actor.appRole,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    scheduleKey: input.scheduleKey,
    date: input.date,
    roleCode: input.roleCode,
    before: input.before,
    after: input.after,
    deviceId: actor.deviceId,
    driveVersion: actor.driveSync.lastLoadedVersion ?? null,
    driveModifiedTime: actor.driveSync.lastLoadedModifiedTime ?? null,
    snapshotFileId: input.snapshotFileId,
    snapshotUrl: input.snapshotUrl
  };
}
