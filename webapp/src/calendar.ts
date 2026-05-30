import { cellKey } from "@/domain";
import type { CalendarPreviewEvent, MonthSchedule, Role, WorkspaceData } from "@/types";

async function sha1(input: string) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function normalizeCalendarId(input: string) {
  const trimmed = input.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    return url.searchParams.get("src") ?? url.searchParams.get("cid") ?? trimmed;
  } catch {
    return trimmed;
  }
}

export function normalizeCalendarRecipientEmail(input: string) {
  const email = input.trim().toLowerCase();
  if (!email || email.endsWith("@local")) return "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

export async function buildCalendarPreview(schedule: MonthSchedule, roles: Role[], data: WorkspaceData): Promise<CalendarPreviewEvent[]> {
  const doctorById = new Map(data.doctors.map((doctor) => [doctor.id, doctor]));
  const usersByDoctorId = new Map<string, string[]>();

  for (const user of data.users) {
    if (!user.active || !user.doctorId) continue;
    const email = normalizeCalendarRecipientEmail(user.email);
    if (!email) continue;
    const current = usersByDoctorId.get(user.doctorId) ?? [];
    if (!current.includes(email)) current.push(email);
    usersByDoctorId.set(user.doctorId, current);
  }

  const events: CalendarPreviewEvent[] = [];

  for (const key of Object.keys(schedule.assignments).sort()) {
    const [date, roleCode] = key.split("|");
    const role = roles.find((candidate) => candidate.code === roleCode);
    const assignment = schedule.assignments[key];
    const doctor = assignment.doctorId ? doctorById.get(assignment.doctorId) : null;
    if (!role || !doctor || assignment.pending) continue;
    const title = `${role.name} | ${doctor.name}`;
    const attendeeEmails = [...(usersByDoctorId.get(doctor.id) ?? [])].sort();
    const hash = await sha1(`${date}|${title}|${attendeeEmails.join(",")}`);
    events.push({
      assignmentKey: cellKey(date, role.code),
      eventId: `shift-${schedule.key}-${date}-${role.code}`.replace(/[^a-zA-Z0-9_-]/g, "-"),
      title,
      date,
      hash,
      attendeeEmails
    });
  }

  return events;
}
