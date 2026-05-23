import { createSampleWorkspace } from "@/sampleData";
import { migrateWorkspace } from "@/migration";
import type { WorkspaceData } from "@/types";

const STORAGE_KEY = "department-shift-scheduler.workspace";
const CLIENT_ID_KEY = "department-shift-scheduler.google-client-id";
const DEVICE_ID_KEY = "department-shift-scheduler.device-id";
export const DEFAULT_GOOGLE_CLIENT_ID = "264155836518-nqcoltph397ta3ua8hpemsegk3v5o5ck.apps.googleusercontent.com";

export function loadLocalWorkspace(): WorkspaceData {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    const sample = createSampleWorkspace();
    saveLocalWorkspace(sample);
    return sample;
  }
  try {
    const parsed = migrateWorkspace(JSON.parse(raw));
    if (JSON.stringify(parsed) !== raw) saveLocalWorkspace(parsed);
    return parsed;
  } catch {
    const sample = createSampleWorkspace();
    saveLocalWorkspace(sample);
    return sample;
  }
}

export function saveLocalWorkspace(data: WorkspaceData) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

export function loadGoogleClientId() {
  return localStorage.getItem(CLIENT_ID_KEY) ?? DEFAULT_GOOGLE_CLIENT_ID;
}

export function saveGoogleClientId(clientId: string) {
  localStorage.setItem(CLIENT_ID_KEY, clientId.trim());
}

export function loadDeviceId() {
  const existing = localStorage.getItem(DEVICE_ID_KEY);
  if (existing) return existing;
  const deviceId = `device-${crypto.randomUUID()}`;
  localStorage.setItem(DEVICE_ID_KEY, deviceId);
  return deviceId;
}

export function downloadJson(data: WorkspaceData) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = data.driveSync.fileName || "department-shift-scheduler.json";
  a.click();
  URL.revokeObjectURL(url);
}

export function downloadCsv(data: WorkspaceData, scheduleKey: string) {
  const schedule = data.schedules[scheduleKey];
  if (!schedule) return;
  const doctorById = new Map(data.doctors.map((doctor) => [doctor.id, doctor]));
  const roleByCode = new Map(data.roles.map((role) => [role.code, role]));
  const rows = Object.entries(schedule.assignments)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, assignment]) => {
      const [date, roleCode] = key.split("|");
      const role = roleByCode.get(roleCode as never);
      const doctor = assignment.doctorId ? doctorById.get(assignment.doctorId) : null;
      return [date, role?.name ?? roleCode, doctor?.name ?? (assignment.pending ? "Pending" : "")].join(",");
    });
  const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `schedule-${scheduleKey}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
