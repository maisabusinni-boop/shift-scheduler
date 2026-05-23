import { createId, roles } from "@/domain";
import { buildMonthDays, monthKey } from "@/month";
import type { Doctor, MonthSchedule, WorkspaceData } from "@/types";

const doctors: Doctor[] = [
  { id: "doc-cohen", name: "ד\"ר כהן", group: "resident", canAngio: false, active: true },
  { id: "doc-levi", name: "ד\"ר לוי", group: "resident", canAngio: false, active: true },
  { id: "doc-mizrahi", name: "ד\"ר מזרחי", group: "resident", canAngio: false, active: true },
  { id: "doc-avni", name: "ד\"ר אבני", group: "senior", canAngio: true, active: true },
  { id: "doc-rozen", name: "ד\"ר רוזן", group: "senior", canAngio: false, active: true },
  { id: "doc-barak", name: "ד\"ר ברק", group: "senior", canAngio: true, active: true }
];

export function createEmptySchedule(year: number, month: number): MonthSchedule {
  return {
    key: monthKey(year, month),
    year,
    month,
    status: "draft",
    assignments: {},
    exclusions: [],
    validation: {
      checkedAt: null,
      stale: true,
      issues: []
    },
    publishSnapshots: [],
    lastSyncedAt: null
  };
}

export function ensureSchedule(data: WorkspaceData, year: number, month: number): WorkspaceData {
  const key = monthKey(year, month);
  if (data.schedules[key]) {
    return data;
  }
  return {
    ...data,
    schedules: {
      ...data.schedules,
      [key]: createEmptySchedule(year, month)
    },
    updatedAt: new Date().toISOString()
  };
}

export function createSampleWorkspace(): WorkspaceData {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const schedule = createEmptySchedule(year, month);
  const firstFriday = buildMonthDays(year, month).find((day) => day.isFriday);
  if (firstFriday) {
    schedule.assignments[`${firstFriday.key}|resident-on-call`] = { doctorId: "doc-cohen", pending: false };
    schedule.assignments[`${firstFriday.key}|senior-a`] = { doctorId: "doc-avni", pending: false };
    schedule.assignments[`${firstFriday.key}|angio`] = { doctorId: "doc-barak", pending: false };
    schedule.assignments[`${buildMonthDays(year, month).find((day) => day.day === firstFriday.day + 1)?.key ?? firstFriday.key}|half-senior`] = {
      doctorId: "doc-avni",
      pending: false
    };
  }

  return {
    schemaVersion: 2,
    workspace: {
      name: "שיבוץ מחלקתי",
      timezone: "Asia/Jerusalem",
      locale: "he-IL"
    },
    roles,
    doctors,
    users: [],
    schedules: {
      [schedule.key]: schedule
    },
    changeRequests: [],
    auditLog: [],
    calendar: {
      calendarInput: "",
      calendarId: "",
      syncRecords: {},
      lastDryRun: []
    },
    driveSync: {
      fileId: null,
      fileName: "department-shift-scheduler.json",
      fileUrl: null,
      lastLoadedModifiedTime: null,
      lastSavedModifiedTime: null,
      lastLoadedVersion: null,
      lastSavedVersion: null
    },
    updatedAt: new Date().toISOString()
  };
}

export function cloneWorkspace(data: WorkspaceData): WorkspaceData {
  return JSON.parse(JSON.stringify(data)) as WorkspaceData;
}

export function addPublishSnapshot(schedule: MonthSchedule) {
  const version = (schedule.publishSnapshots[0]?.version ?? 0) + 1;
  schedule.publishSnapshots.unshift({
    id: createId("snapshot"),
    version,
    createdAt: new Date().toISOString(),
    assignments: JSON.parse(JSON.stringify(schedule.assignments)) as MonthSchedule["assignments"]
  });
}
