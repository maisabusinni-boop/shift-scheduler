import { describe, expect, it } from "vitest";
import { removeDoctorAndLinkedAccess } from "@/admin";
import { ADMIN_PASSWORD_HASH, ensureAdminAccount } from "@/adminAccount";
import { createAuditEntry, isAuditEntryVisibleForSchedule } from "@/audit";
import { createBootstrapPlanner, resolveSession, type SessionUser } from "@/auth";
import { ROLE_CODES } from "@/domain";
import { migrateWorkspace } from "@/migration";
import { canEditRoster, canManageUsers, canPublish, canSeeSchedule } from "@/permissions";
import { approveRegistrationAsMerge, approveRegistrationAsNew, createRegistrationRequest } from "@/registration";
import { createChangeRequest, nextRequestStatusForDecision } from "@/requests";
import { createSampleWorkspace } from "@/sampleData";
import type { AppUser } from "@/types";

const testUser: SessionUser = { username: "planner", name: "Planner" };

describe("Username role resolution", () => {
  it("lets the first signed-in user bootstrap as senior planner", () => {
    const data = createSampleWorkspace();
    data.users = data.users.filter((user) => user.role !== "admin");
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

  it("seeds and recognizes the fixed admin account", () => {
    const data = ensureAdminAccount({ ...createSampleWorkspace(), users: [] });
    const admin = data.users.find((user) => user.username === "admin");
    expect(admin?.role).toBe("admin");
    expect(admin?.passwordHash).toBe(ADMIN_PASSWORD_HASH);
    const session = resolveSession(data, { username: "admin", name: "admin" });
    expect(session.status).toBe("recognized");
    expect(session.role).toBe("admin");
  });

  it("allows recovery bootstrap if users exist but no active planner exists", () => {
    const data = createSampleWorkspace();
    data.users = data.users.filter((user) => user.role !== "admin");
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
    expect(canPublish("admin")).toBe(true);
    expect(canManageUsers("senior-planner")).toBe(true);
    expect(canManageUsers("chief-resident")).toBe(false);
    expect(canManageUsers("admin")).toBe(true);
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

describe("admin user removal", () => {
  it("fully removes linked user access when a doctor is deleted", () => {
    const data = createSampleWorkspace();
    const doctor = data.doctors[0];
    data.users.push({
      id: "chief-user",
      username: "chief",
      email: "chief@local",
      name: "Chief",
      role: "chief-resident",
      doctorId: doctor.id,
      active: true,
      createdAt: new Date().toISOString()
    });
    const schedule = Object.values(data.schedules)[0];
    schedule.assignments["2026-05-01|resident-on-call"] = { doctorId: doctor.id, pending: false };
    schedule.exclusions.push({ id: "ex-1", doctorId: doctor.id, date: "2026-05-02", roleCode: null, reason: "away" });
    data.changeRequests.push({
      id: "request-1",
      scheduleKey: schedule.key,
      requesterDoctorId: doctor.id,
      requesterUserId: "chief-user",
      requesterRole: "chief-resident",
      date: "2026-05-01",
      roleCode: ROLE_CODES.RESIDENT_ON_CALL,
      currentDoctorId: doctor.id,
      proposedDoctorId: null,
      reason: "remove",
      status: "submitted",
      resolutionNote: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      decidedAt: null,
      decidedByUserId: null,
      appliedAt: null,
      appliedByUserId: null
    });

    const audit = removeDoctorAndLinkedAccess(data, doctor.id);

    expect(audit?.action).toBe("doctor-remove");
    expect(data.doctors.some((item) => item.id === doctor.id)).toBe(false);
    expect(data.users.some((user) => user.id === "chief-user")).toBe(false);
    expect(schedule.assignments["2026-05-01|resident-on-call"]).toEqual({ doctorId: null, pending: false });
    expect(schedule.exclusions).toHaveLength(0);
    expect(data.changeRequests).toHaveLength(0);
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

  it("records admin view-as audit metadata with admin user id and effective role", () => {
    const data = createSampleWorkspace();
    const entry = createAuditEntry(
      {
        googleUser: { email: "admin@local", name: "admin resident" },
        appUserId: "user-admin",
        appRole: "resident",
        deviceId: "device-1",
        driveSync: data.driveSync
      },
      {
        action: "exclusion-create",
        entityType: "exclusion",
        entityId: "ex-1",
        scheduleKey: "2026-05",
        before: null,
        after: { doctorId: "doc-cohen" }
      }
    );
    expect(entry.actorUserId).toBe("user-admin");
    expect(entry.actorName).toBe("admin resident");
    expect(entry.actorRole).toBe("resident");
  });

  it("stores published change metadata for the visual change log", () => {
    const data = createSampleWorkspace();
    const changeDetails = {
      kind: "exchange" as const,
      code: "SWP-TEST-001",
      reason: "manual correction",
      status: "direct" as const,
      source: { date: "2026-05-01", roleCode: ROLE_CODES.RESIDENT_ON_CALL, doctorId: "doc-cohen" },
      target: { date: "2026-05-02", roleCode: ROLE_CODES.HALF_RESIDENT, doctorId: "doc-levi" },
      result: { sourceDoctorId: "doc-levi", targetDoctorId: "doc-cohen" }
    };
    const entry = createAuditEntry(
      {
        googleUser: { email: "planner@local", name: "Planner" },
        appUserId: "user-1",
        appRole: "senior-planner",
        deviceId: "device-1",
        driveSync: data.driveSync
      },
      {
        action: "published-swap-direct",
        entityType: "assignment",
        entityId: "2026-05-02|half-resident",
        scheduleKey: "2026-05",
        date: "2026-05-02",
        roleCode: ROLE_CODES.HALF_RESIDENT,
        before: null,
        after: null,
        changeCode: changeDetails.code,
        changeKind: changeDetails.kind,
        changeDetails
      }
    );

    expect(entry.changeCode).toBe("SWP-TEST-001");
    expect(entry.changeKind).toBe("exchange");
    expect(entry.changeDetails).toEqual(changeDetails);
    expect(entry.snapshotUrl).toBeUndefined();
  });

  it("shows visual audit entries only for the active schedule month", () => {
    const data = createSampleWorkspace();
    const actor = {
      googleUser: { email: "planner@local", name: "Planner" },
      appUserId: "user-1",
      appRole: "senior-planner" as const,
      deviceId: "device-1",
      driveSync: data.driveSync
    };
    const baseInput = {
      action: "published-swap-direct",
      entityType: "assignment" as const,
      entityId: "2026-05-02|half-resident",
      roleCode: ROLE_CODES.HALF_RESIDENT,
      before: null,
      after: null
    };

    const activeMonthEntry = createAuditEntry(actor, {
      ...baseInput,
      scheduleKey: "2026-05",
      date: "2026-05-02"
    });
    const otherMonthEntry = createAuditEntry(actor, {
      ...baseInput,
      scheduleKey: "2026-06",
      date: "2026-06-02"
    });
    const legacyActiveMonthEntry = createAuditEntry(actor, {
      ...baseInput,
      date: "2026-05-03"
    });
    const nonVisualEntry = createAuditEntry(actor, {
      ...baseInput,
      action: "assignment-update",
      scheduleKey: "2026-05",
      date: "2026-05-04"
    });

    expect(isAuditEntryVisibleForSchedule(activeMonthEntry, "2026-05")).toBe(true);
    expect(isAuditEntryVisibleForSchedule(otherMonthEntry, "2026-05")).toBe(false);
    expect(isAuditEntryVisibleForSchedule(legacyActiveMonthEntry, "2026-05")).toBe(true);
    expect(isAuditEntryVisibleForSchedule(nonVisualEntry, "2026-05")).toBe(false);
  });
});

describe("migration", () => {
  it("upgrades schema v1 workspaces to schema v2", () => {
    const data = createSampleWorkspace();
    const legacy = { ...data, schemaVersion: 1 };
    delete (legacy as Partial<typeof data>).users;
    delete (legacy as Partial<typeof data>).registrationRequests;
    delete (legacy as Partial<typeof data>).changeRequests;
    delete (legacy as Partial<typeof data>).auditLog;

    const migrated = migrateWorkspace(legacy);
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.users.some((user) => user.username === "admin" && user.role === "admin")).toBe(true);
    expect(migrated.registrationRequests).toEqual([]);
    expect(migrated.changeRequests).toEqual([]);
    expect(migrated.auditLog).toEqual([]);
  });
});

describe("registration requests", () => {
  it("normalizes username and Gmail and rejects duplicate pending usernames", () => {
    const first = createRegistrationRequest({
      doctorName: "ד״ר בדיקה",
      gmail: "Doctor@Gmail.COM",
      username: " NewDoc ",
      passwordHash: "hash-1"
    }, []);

    expect(first.username).toBe("newdoc");
    expect(first.gmail).toBe("doctor@gmail.com");
    expect(() => createRegistrationRequest({
      doctorName: "ד״ר אחרת",
      gmail: "",
      username: "newdoc",
      passwordHash: "hash-2"
    }, [first])).toThrow("pending request");
  });

  it("merges a reset request into an existing doctor without replacing the doctor id", () => {
    const data = createSampleWorkspace();
    const doctor = data.doctors[0];
    data.users.push({
      id: "user-existing",
      username: "old",
      email: "old@local",
      name: doctor.name,
      role: "resident",
      doctorId: doctor.id,
      active: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      passwordHash: "old-hash"
    });
    data.registrationRequests.push({
      id: "reg-1",
      doctorName: "ד״ר חדש",
      gmail: "new@gmail.com",
      username: "new",
      passwordHash: "new-hash",
      status: "pending",
      createdAt: "2026-01-02T00:00:00.000Z",
      decidedAt: null,
      decidedByUserId: null,
      resolutionNote: ""
    });

    const merged = approveRegistrationAsMerge(data, { requestId: "reg-1", doctorId: doctor.id, decidedByUserId: "planner" }, "2026-01-03T00:00:00.000Z");

    expect(merged.doctors.find((item) => item.id === doctor.id)).toBeTruthy();
    expect(merged.doctors).toHaveLength(data.doctors.length);
    const linkedUser = merged.users.find((user) => user.doctorId === doctor.id);
    expect(linkedUser?.passwordHash).toBe("new-hash");
    expect(linkedUser?.username).toBe("new");
    expect(merged.registrationRequests[0].status).toBe("approved");
  });

  it("allows admin-driven approval of a senior planner account", () => {
    const data = createSampleWorkspace();
    data.registrationRequests.push({
      id: "reg-planner",
      doctorName: "Planner",
      gmail: "",
      username: "planner2",
      passwordHash: "planner-hash",
      status: "pending",
      createdAt: "2026-01-02T00:00:00.000Z",
      decidedAt: null,
      decidedByUserId: null,
      resolutionNote: ""
    });

    const approved = approveRegistrationAsNew(data, {
      requestId: "reg-planner",
      group: "senior",
      role: "senior-planner",
      canAngio: false,
      decidedByUserId: "user-admin"
    }, "2026-01-03T00:00:00.000Z");

    const planner = approved.users.find((user) => user.username === "planner2");
    expect(planner?.role).toBe("senior-planner");
    expect(approved.registrationRequests.find((request) => request.id === "reg-planner")?.decidedByUserId).toBe("user-admin");
  });
});
