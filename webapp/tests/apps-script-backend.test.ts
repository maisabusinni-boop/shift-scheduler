import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

function workspaceFixture(): any {
  return {
    schemaVersion: 3,
    revision: 0,
    workspace: { name: "Test", timezone: "Asia/Jerusalem", locale: "he-IL" },
    roles: [],
    doctors: [{ id: "doctor-1", name: "Doctor", group: "resident", canAngio: false, active: true }],
    users: [{ id: "planner-1", username: "planner", email: "planner@local", name: "Planner", role: "senior-planner", doctorId: null, active: true, createdAt: "2026-01-01T00:00:00.000Z", passwordHash: "secret-hash" }],
    registrationRequests: [],
    schedules: {
      "2026-06": {
        revision: 0,
        key: "2026-06", year: 2026, month: 6, status: "draft",
        assignments: {}, exclusions: [],
        validation: { checkedAt: null, stale: true, issues: [] },
        publishSnapshots: [], lastSyncedAt: null
      }
    },
    changeRequests: [], auditLog: [],
    calendar: { calendarInput: "", calendarId: "", syncRecords: {}, lastDryRun: [], syncPending: false, requestedRevision: null, lastCompletedRevision: null, lastSyncAt: null, lastSyncError: null },
    driveSync: { fileId: null, fileName: "department-shift-scheduler.json", fileUrl: null, lastLoadedModifiedTime: null, lastSavedModifiedTime: null },
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function createHarness(initial = workspaceFixture()) {
  let database = JSON.stringify(initial);
  let lockAttempts = 0;
  let uuid = 0;
  const properties = new Map<string, string>([["DRIVE_FILE_ID", "db-file"]]);
  const file = {
    getAs: () => ({ getDataAsString: () => database }),
    setContent: (value: string) => { database = value; },
    getId: () => "db-file",
    getUrl: () => "https://drive.test/db-file"
  };
  const lock = {
    tryLock: () => { lockAttempts += 1; return true; },
    waitLock: () => { lockAttempts += 1; },
    releaseLock: () => undefined
  };
  const context = vm.createContext({
    console,
    Date,
    JSON,
    Math,
    Error,
    Logger: { log: () => undefined },
    LockService: { getScriptLock: () => lock },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (key: string) => properties.get(key) ?? null,
      setProperty: (key: string, value: string) => properties.set(key, value),
      deleteProperty: (key: string) => properties.delete(key)
    }) },
    DriveApp: {
      getFileById: () => file,
      getFilesByName: () => ({ hasNext: () => false }),
      createFile: () => file,
      getFoldersByName: () => ({ hasNext: () => false }),
      createFolder: () => ({ createFile: () => file })
    },
    ContentService: {
      MimeType: { JSON: "json" },
      createTextOutput: (value: string) => ({ value, setMimeType() { return this; } })
    },
    Utilities: {
      getUuid: () => `uuid-${++uuid}`,
      formatDate: () => "29/06/2026 12:00:00",
      base64Decode: () => [],
      newBlob: () => ({}),
      computeDigest: () => [],
      base64Encode: () => "hash",
      DigestAlgorithm: { SHA_1: "sha1" }
    },
    ScriptApp: {
      getProjectTriggers: () => [],
      newTrigger: () => ({ timeBased: () => ({ everyMinutes: () => ({ create: () => ({}) }) }) }),
      deleteTrigger: () => undefined
    },
    CalendarApp: { getCalendarById: () => null }
  });
  const source = fs.readFileSync(path.resolve(process.cwd(), "..", "Code.gs"), "utf8");
  vm.runInContext(source, context);

  function post(body: Record<string, unknown>) {
    const output = (context.doPost as Function)({ postData: { contents: JSON.stringify(body) } });
    return JSON.parse(output.value);
  }
  return {
    post,
    getWorkspace: () => JSON.parse(database),
    getLockAttempts: () => lockAttempts,
    runCalendarSync: () => (context.processCalendarSyncQueue as Function)()
  };
}

const credentials = { username: "planner", passwordHash: "secret-hash" };

describe("Apps Script concurrency backend", () => {
  it("keeps login and load lock-free and strips password hashes", () => {
    const harness = createHarness();
    const login = harness.post({ action: "login", ...credentials });
    const load = harness.post({ action: "load", ...credentials });
    expect(login.user.passwordHash).toBeUndefined();
    expect(load.data.users[0].passwordHash).toBeUndefined();
    expect(harness.getLockAttempts()).toBe(0);
  });

  it("applies twenty independent exclusions in one write without loss", () => {
    const harness = createHarness();
    const mutations = Array.from({ length: 20 }, (_, index) => ({
      id: `exclusion-${index}`,
      type: "exclusion-create",
      createdAt: new Date().toISOString(),
      payload: {
        entityType: "exclusion", entityId: `ex-${index}`, scheduleKey: "2026-06",
        after: [{ id: `ex-${index}`, doctorId: "doctor-1", date: `2026-06-${String(index + 1).padStart(2, "0")}`, roleCode: "resident-on-call", reason: "test" }]
      },
      expected: null
    }));
    const response = harness.post({ action: "mutate", apiVersion: 2, ...credentials, deviceId: "test", mutations });
    expect(response.results.every((result: any) => result.status === "applied")).toBe(true);
    expect(harness.getWorkspace().schedules["2026-06"].exclusions).toHaveLength(20);
    expect(harness.getWorkspace().auditLog).toHaveLength(20);
  });

  it("reports a same-cell conflict while preserving another valid command", () => {
    const initial = workspaceFixture();
    (initial.schedules["2026-06"].assignments as Record<string, unknown>)["2026-06-01|resident-on-call"] = { doctorId: null, pending: false };
    const harness = createHarness(initial);
    const response = harness.post({
      action: "mutate", apiVersion: 2, ...credentials, deviceId: "test",
      mutations: [
        {
          id: "cell-conflict", type: "assignment-update", createdAt: new Date().toISOString(),
          expected: { "2026-06-01|resident-on-call": { doctorId: "someone-else", pending: false } },
          payload: { entityType: "assignment", entityId: "2026-06-01|resident-on-call", scheduleKey: "2026-06", after: { "2026-06-01|resident-on-call": { doctorId: "doctor-1", pending: false } } }
        },
        {
          id: "valid-exclusion", type: "exclusion-create", createdAt: new Date().toISOString(), expected: null,
          payload: { entityType: "exclusion", entityId: "ex-ok", scheduleKey: "2026-06", after: [{ id: "ex-ok", doctorId: "doctor-1", date: "2026-06-02", roleCode: "resident-on-call", reason: "ok" }] }
        }
      ]
    });
    expect(response.results.map((result: any) => result.status)).toEqual(["conflict", "applied"]);
    expect(harness.getWorkspace().schedules["2026-06"].exclusions).toHaveLength(1);
  });

  it("deduplicates retries by mutation id", () => {
    const harness = createHarness();
    const mutation = { id: "once", type: "exclusion-create", createdAt: new Date().toISOString(), expected: null, payload: { entityType: "exclusion", entityId: "ex-once", scheduleKey: "2026-06", after: [{ id: "ex-once", doctorId: "doctor-1", date: "2026-06-03", roleCode: "resident-on-call", reason: "once" }] } };
    expect(harness.post({ action: "mutate", apiVersion: 2, ...credentials, deviceId: "test", mutations: [mutation] }).results[0].status).toBe("applied");
    expect(harness.post({ action: "mutate", apiVersion: 2, ...credentials, deviceId: "test", mutations: [mutation] }).results[0].status).toBe("duplicate");
    expect(harness.getWorkspace().auditLog).toHaveLength(1);
  });

  it("rejects a regular user changing another doctor's exclusion", () => {
    const initial = workspaceFixture();
    initial.doctors.push({ id: "doctor-2", name: "Other", group: "resident", canAngio: false, active: true });
    initial.users.push({ id: "resident-1", username: "resident", email: "resident@local", name: "Resident", role: "resident", doctorId: "doctor-1", active: true, createdAt: "2026-01-01T00:00:00.000Z", passwordHash: "resident-hash" });
    const harness = createHarness(initial);
    const response = harness.post({
      action: "mutate", apiVersion: 2, username: "resident", passwordHash: "resident-hash", deviceId: "test",
      mutations: [{ id: "forbidden", type: "exclusion-create", createdAt: new Date().toISOString(), payload: { entityType: "exclusion", entityId: "other", scheduleKey: "2026-06", after: [{ id: "other", doctorId: "doctor-2", date: "2026-06-04", roleCode: "resident-on-call", reason: "bad" }] } }]
    });
    expect(response.results[0]).toMatchObject({ status: "rejected", errorCode: "FORBIDDEN" });
    expect(harness.getWorkspace().schedules["2026-06"].exclusions).toHaveLength(0);
  });

  it("processes pending Calendar work without leaving a lease", () => {
    const initial = workspaceFixture();
    initial.calendar.syncPending = true;
    initial.calendar.requestedRevision = 0;
    const harness = createHarness(initial);
    harness.runCalendarSync();
    expect(harness.getWorkspace().calendar.syncPending).toBe(false);
    expect(harness.getWorkspace()._server.calendarLease).toBeNull();
  });

  it("rejects legacy full-workspace saves", () => {
    const harness = createHarness();
    expect(harness.post({ action: "save", ...credentials, data: workspaceFixture() }).errorCode).toBe("UPGRADE_REQUIRED");
  });
});


describe("dummy four-role account workspace", () => {
  const roles = ["senior-planner", "chief-resident", "senior", "resident"];
  function fourUsers() {
    const initial = workspaceFixture();
    initial.users = roles.map((role, i) => ({ ...initial.users[0], id: `test-${i}`, username: `test-${role}`, role, doctorId: i ? `doctor-${i}` : null, passwordHash: `hash-${i}` }));
    initial.doctors = roles.slice(1).map((role, i) => ({ id: `doctor-${i + 1}`, name: role, group: role === "senior" ? "senior" : "resident", active: true, canAngio: false }));
    return initial;
  }
  it.each(roles)("logs in %s and enforces doctor management permissions", (role) => {
    const initial = fourUsers();
    const index = roles.indexOf(role);
    const harness = createHarness(initial);
    const auth = { username: ` TEST-${role.toUpperCase()} `, passwordHash: `hash-${index}` };
    const login = harness.post({ action: "login", ...auth });
    expect(login.user.role).toBe(role);
    expect(login.data.users).toHaveLength(4);
    expect(login.data.users.every((u: any) => !u.passwordHash)).toBe(true);
    expect(harness.post({ action: "login", ...auth, passwordHash: "wrong" }).errorCode).toBe("AUTH_FAILED");
    const result = harness.post({ action: "mutate", ...auth, mutations: [{ id: "create", type: "doctor-create", payload: { entityId: "new", after: { id: "new", name: "Dummy", group: "resident", active: true } } }] });
    expect(result.results[0].status).toBe(role === "senior-planner" ? "applied" : "rejected");
  });
  it("recognizes a legacy username with surrounding spaces and rejects disabled accounts", () => {
    const initial = workspaceFixture();
    initial.users[0].username = " Planner ";
    expect(createHarness(initial).post({ action: "login", ...credentials }).success).toBe(true);
    initial.users[0].active = false;
    expect(createHarness(initial).post({ action: "login", ...credentials }).errorCode).toBe("AUTH_FAILED");
  });
  it("preserves passwords on profile edits, resets them explicitly and rejects duplicate usernames", () => {
    const initial = fourUsers();
    const harness = createHarness(initial);
    const edit = (id: string, user: any) => harness.post({ action: "mutate", username: "test-senior-planner", passwordHash: "hash-0", mutations: [{ id, type: "doctor-user-update", expected: { doctor: initial.doctors[0] }, payload: { entityId: "doctor-1", after: { doctor: initial.doctors[0], user } } }] });
    const user = { ...initial.users[1], passwordHash: "" };
    expect(edit("preserve", user).results[0].status).toBe("applied");
    expect(harness.post({ action: "login", username: user.username, passwordHash: "hash-1" }).success).toBe(true);
    expect(edit("reset", { ...user, passwordHash: "new-hash" }).results[0].status).toBe("applied");
    expect(harness.post({ action: "login", username: user.username, passwordHash: "hash-1" }).errorCode).toBe("AUTH_FAILED");
    expect(harness.post({ action: "login", username: user.username, passwordHash: "new-hash" }).success).toBe(true);
    expect(edit("duplicate", { ...user, username: " TEST-SENIOR " }).results[0].errorCode).toBe("CONFLICT");
    expect(harness.post({ action: "login", username: user.username, passwordHash: "new-hash" }).success).toBe(true);
  });
});


it("rejects the reserved bootstrap username instead of creating an unusable account", () => {
  const initial = workspaceFixture();
  initial.users = [];
  const harness = createHarness(initial);
  expect(harness.post({ action: "bootstrap", username: " Admin ", passwordHash: "hash" }).errorCode).toBe("INVALID_COMMAND");
  expect(harness.getWorkspace().users).toHaveLength(0);
  expect(harness.post({ action: "bootstrap", username: " Planner ", passwordHash: "hash" }).success).toBe(true);
  expect(harness.post({ action: "login", username: "planner", passwordHash: "hash" }).success).toBe(true);
});
