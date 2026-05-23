import { createSampleWorkspace } from "@/sampleData";
import type { WorkspaceData } from "@/types";

const STORAGE_KEY = "department-shift-scheduler.workspace";
const CLIENT_ID_KEY = "department-shift-scheduler.google-client-id";

export function loadLocalWorkspace(): WorkspaceData {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    const sample = createSampleWorkspace();
    saveLocalWorkspace(sample);
    return sample;
  }
  try {
    const parsed = JSON.parse(raw) as WorkspaceData;
    if (parsed.schemaVersion !== 1) throw new Error("Unsupported schema");
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
  return localStorage.getItem(CLIENT_ID_KEY) ?? "";
}

export function saveGoogleClientId(clientId: string) {
  localStorage.setItem(CLIENT_ID_KEY, clientId.trim());
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
