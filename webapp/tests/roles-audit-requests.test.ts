import { describe, expect, it } from "vitest";
import { createAuditEntry } from "@/audit";
import { createBootstrapPlanner, resolveSession, type SessionUser } from "@/auth";
import { ROLE_CODES } from "@/domain";
import { migrateWorkspace } from "@/migration";
import { canEditRoster, canManageUsers, canPublish, canSeeSchedule } from "@/permissions";
import { createChangeRequest, nextRequestStatusForDecision } from "@/requests";
import { createSampleWorkspace } from "@/sampleData";
import type { AppUser } from "@/types";

const testUser: SessionUser = { username: "planner", name: "Planner" };

describe("Username role resolution", () => {
  it("lets the first signed-in user bootstrap as senior planner", () => {
    const data = createSampleWorkspace();
    const session = resolveSession(data, testUser);
    expect(session.status).toBe("bootstrap");
    expect(session.role).toBe("senior-planner");
  });

  it("recognizes active users and blocks unknown usernames after bootstrap", () => {
    const data = createSampleWorkspace();
    const planner = createBootstrapPlanner(testUser, "hashed_password");
    data.users.push(planner);
    expect(resolveSession(data, testUser).status).toBe("recognized");
    expect(resolveSession(data, { username: "unknown", name: "Unknown" }).status).toBe("blocked");
  });

  it("allows recovery bootstrap if users exist but no active planner exists", () => {
    const data = createSampleWorkspace();
    data.users.push({
      id: "stale-user",
      email: "resident@local",
      name: "Resident",
      role: "resident",
      doctorId: null,
      active: true,
      createdAt: new Date().toISOString()
    });
    const session = resolveSession(data, testUser);
    expect(session.status).toBe("bootstrap");
    expect(session.role).toBe("senior-planner");
  });

  it("blocks unknown users when an active planner already exists", () => {
    const data = createSampleWorkspace();
    data.users.push(createBootstrapPlanner({ username: "other", name: "Other Planner" }, "hashed_password"));
    const session = resolveSession(data, testUser);
    expect(session.status).toBe("blocked");
  });
});

describe("permissions", () => {
  it("keeps publish and user management planner-only", () => {
    expect(canPublish("senior-planner")).toBe(true);
    expect(canPublish("chief-resident")).toBe(false);
    expect(canManageUsers("senior-planner")).toBe(true);
    expect(canManageUsers("chief-resident")).toBe(false);
  });

  it("allows chief and planner to edit draft roster only", () => {
    const data = createSampleWorkspace();
    const schedule = Object.values(data.schedules)[0];
    expect(canEditRoster("chief-resident", schedule)).toBe(true);
    schedule.status = "published";
    expect(canEditRoster("chief-resident", schedule)).toBe(false);
    expect(canSeeSchedule("resident", schedule)).toBe(true);
    schedule.status = "draft";
    expect(canSeeSchedule("resident", schedule)).toBe(false);
  });
});

describe("requests and audit", () => {
  it("creates resident submitted requests and senior confirmed requests", () => {
    const data = createSampleWorkspace();
    const schedule = Object.values(data.schedules)[0];
    const resident: AppUser = {
      id: "u1",
      email: "resident@local",
      name: "Resident",
      role: "resident",
      doctorId: data.doctors[0].id,
      active: true,
      createdAt: new Date().toISOString()
    };
    const senior: AppUser = { ...resident, id: "u2", email: "senior@local", role: "senior", doctorId: data.doctors[3].id };

    expect(createChangeRequest({ schedule, requesterUser: resident, date: "2026-05-01", roleCode: ROLE_CODES.RESIDENT_ON_CALL, proposedDoctorId: null, reason: "exam" }).status).toBe("submitted");
    expect(createChangeRequest({ schedule, requesterUser: senior, date: "2026-05-01", roleCode: ROLE_CODES.SENIOR_A, proposedDoctorId: null, reason: "clinic" }).status).toBe("senior-confirmed");
    expect(nextRequestStatusForDecision("submitted", "approve", "chief-resident")).toBe("approved");
    expect(nextRequestStatusForDecision("submitted", "reject", "chief-resident")).toBe("rejected");
  });

  it("records audit metadata for troubleshooting", () => {
    const data = createSampleWorkspace();
    const entry = createAuditEntry(
      {
        googleUser: { email: "planner@local", name: "Planner" },
        appUserId: "user-1",
        appRole: "senior-planner",
        deviceId: "device-1",
        driveSync: data.driveSync
      },
      {
        action: "assignment-update",
        entityType: "assignment",
        entityId: "2026-05-01|resident-on-call",
        scheduleKey: "2026-05",
        date: "2026-05-01",
        roleCode: ROLE_CODES.RESIDENT_ON_CALL,
        before: null,
        after: { doctorId: "doc-1", pending: false }
      }
    );
    expect(entry.actorEmail).toBe("planner@local");
    expect(entry.deviceId).toBe("device-1");
    expect(entry.before).toBeNull();
    expect(entry.after).toEqual({ doctorId: "doc-1", pending: false });
  });
});

describe("migration", () => {
  it("upgrades schema v1 workspaces to schema v2", () => {
    const data = createSampleWorkspace();
    const legacy = { ...data, schemaVersion: 1 };
    delete (legacy as Partial<typeof data>).users;
    delete (legacy as Partial<typeof data>).changeRequests;
    delete (legacy as Partial<typeof data>).auditLog;

    const migrated = migrateWorkspace(legacy);
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.users).toEqual([]);
    expect(migrated.changeRequests).toEqual([]);
    expect(migrated.auditLog).toEqual([]);
  });
});
