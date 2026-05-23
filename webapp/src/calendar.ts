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

export async function buildCalendarPreview(schedule: MonthSchedule, roles: Role[], data: WorkspaceData): Promise<CalendarPreviewEvent[]> {
  const doctorById = new Map(data.doctors.map((doctor) => [doctor.id, doctor]));
  const events: CalendarPreviewEvent[] = [];

  for (const key of Object.keys(schedule.assignments).sort()) {
    const [date, roleCode] = key.split("|");
    const role = roles.find((candidate) => candidate.code === roleCode);
    const assignment = schedule.assignments[key];
    const doctor = assignment.doctorId ? doctorById.get(assignment.doctorId) : null;
    if (!role || !doctor || assignment.pending) continue;
    const title = `${role.name} | ${doctor.name}`;
    const hash = await sha1(`${date}|${title}`);
    events.push({
      assignmentKey: cellKey(date, role.code),
      eventId: `shift-${schedule.key}-${date}-${role.code}`.replace(/[^a-zA-Z0-9_-]/g, "-"),
      title,
      date,
      hash
    });
  }

  return events;
}
