import { describe, expect, it } from "vitest";
import { buildCalendarPreview } from "@/calendar";
import { migrateWorkspace } from "@/migration";
import { createSampleWorkspace } from "@/sampleData";

describe("calendar preview routing", () => {
  it("collects only active real emails for the assigned doctor", async () => {
    const data = createSampleWorkspace();
    data.users.push(
      {
        id: "u1",
        username: "cohen",
        email: "cohen@gmail.com",
        name: "Dr Cohen",
        role: "resident",
        doctorId: "doc-cohen",
        active: true,
        createdAt: new Date().toISOString()
      },
      {
        id: "u2",
        username: "cohen2",
        email: "cohen2@gmail.com",
        name: "Dr Cohen 2",
        role: "resident",
        doctorId: "doc-cohen",
        active: true,
        createdAt: new Date().toISOString()
      },
      {
        id: "u3",
        username: "cohen-local",
        email: "cohen@local",
        name: "Local Only",
        role: "resident",
        doctorId: "doc-cohen",
        active: true,
        createdAt: new Date().toISOString()
      },
      {
        id: "u4",
        username: "cohen-inactive",
        email: "inactive@gmail.com",
        name: "Inactive",
        role: "resident",
        doctorId: "doc-cohen",
        active: false,
        createdAt: new Date().toISOString()
      }
    );

    const schedule = Object.values(data.schedules)[0];
    const preview = await buildCalendarPreview(schedule, data.roles, data);
    const residentEvent = preview.find((event) => event.assignmentKey.endsWith("|resident-on-call"));

    expect(residentEvent?.attendeeEmails).toEqual(["cohen2@gmail.com", "cohen@gmail.com"]);
  });

  it("shows an empty attendee list when no deliverable Gmail exists", async () => {
    const data = createSampleWorkspace();
    data.users.push({
      id: "u1",
      username: "avni",
      email: "avni@local",
      name: "Dr Avni",
      role: "senior",
      doctorId: "doc-avni",
      active: true,
      createdAt: new Date().toISOString()
    });

    const schedule = Object.values(data.schedules)[0];
    const preview = await buildCalendarPreview(schedule, data.roles, data);
    const seniorEvent = preview.find((event) => event.assignmentKey.endsWith("|senior-a"));

    expect(seniorEvent?.attendeeEmails).toEqual([]);
  });

  it("changes the preview hash when attendee emails change", async () => {
    const data = createSampleWorkspace();
    data.users.push({
      id: "u1",
      username: "cohen",
      email: "cohen@gmail.com",
      name: "Dr Cohen",
      role: "resident",
      doctorId: "doc-cohen",
      active: true,
      createdAt: new Date().toISOString()
    });

    const schedule = Object.values(data.schedules)[0];
    const firstPreview = await buildCalendarPreview(schedule, data.roles, data);
    const cohenUser = data.users.find((user) => user.id === "u1");
    if (cohenUser) cohenUser.email = "cohen.updated@gmail.com";
    const secondPreview = await buildCalendarPreview(schedule, data.roles, data);

    const firstHash = firstPreview.find((event) => event.assignmentKey.endsWith("|resident-on-call"))?.hash;
    const secondHash = secondPreview.find((event) => event.assignmentKey.endsWith("|resident-on-call"))?.hash;

    expect(firstHash).not.toBe(secondHash);
  });
});

describe("calendar migration defaults", () => {
  it("backfills usernames and attendee email arrays", () => {
    const data = createSampleWorkspace();
    const schedule = Object.values(data.schedules)[0];
    const assignmentKey = Object.keys(schedule.assignments)[0];
    data.users.push({
      id: "u1",
      email: "planner@local",
      name: "Planner",
      role: "senior-planner",
      doctorId: null,
      active: true,
      createdAt: new Date().toISOString()
    });
    data.calendar.syncRecords[assignmentKey] = {
      assignmentKey,
      eventId: "event-1",
      hash: "hash-1",
      lastSyncedAt: new Date().toISOString()
    } as never;

    const migrated = migrateWorkspace(data);

    expect(migrated.users.find((user) => user.email === "planner@local")?.username).toBe("planner");
    expect(migrated.users.find((user) => user.username === "admin")?.role).toBe("admin");
    expect(migrated.calendar.syncRecords[assignmentKey].attendeeEmails).toEqual([]);
  });
});
