import type { AuditInput } from "@/audit";
import { cloneWorkspace } from "@/sampleData";
import type { MutationCommand, WorkspaceData } from "@/types";

function mutationId() {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `mutation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function mutationFromAudit(input: AuditInput, draft: WorkspaceData): MutationCommand {
  const schedule = input.scheduleKey ? draft.schedules[input.scheduleKey] : undefined;
  const request = input.entityType === "request"
    ? draft.changeRequests.find((item) => item.id === input.entityId)
    : undefined;
  const doctor = input.entityType === "doctor"
    ? draft.doctors.find((item) => item.id === input.entityId)
    : undefined;
  return {
    id: mutationId(),
    type: input.action,
    createdAt: new Date().toISOString(),
    expected: input.before,
    payload: {
      entityType: input.entityType,
      entityId: input.entityId,
      scheduleKey: input.scheduleKey,
      date: input.date,
      roleCode: input.roleCode,
      after: input.after,
      schedule,
      request,
      doctor,
      changeCode: input.changeCode,
      changeKind: input.changeKind,
      changeDetails: input.changeDetails,
      doctors: input.action === "test-data-load" ? draft.doctors : undefined,
      users: input.action === "test-data-load" ? draft.users : undefined,
      calendar: input.entityType === "calendar" ? draft.calendar : undefined
    }
  };
}

export function applyMutationLocally(base: WorkspaceData, command: MutationCommand): WorkspaceData {
  const next = cloneWorkspace(base);
  const payload = command.payload as Record<string, any>;
  const scheduleKey = payload.scheduleKey as string | undefined;
  const schedule = scheduleKey ? next.schedules[scheduleKey] : undefined;
  const after = payload.after;

  switch (command.type) {
    case "schedule-create":
      if (payload.schedule && !next.schedules[payload.schedule.key]) next.schedules[payload.schedule.key] = payload.schedule;
      break;
    case "assignment-update":
      if (schedule && after && typeof after === "object") Object.assign(schedule.assignments, after);
      break;
    case "schedule-generate-auto":
      if (schedule) schedule.assignments = after ?? {};
      break;
    case "schedule-validate":
    case "publish-blocked":
      if (schedule) schedule.validation = after;
      break;
    case "schedule-publish":
    case "schedule-unpublish":
      if (schedule && payload.schedule) Object.assign(schedule, payload.schedule);
      break;
    case "exclusion-create":
      if (schedule) {
        const additions = Array.isArray(after) ? after : [];
        const ids = new Set(schedule.exclusions.map((item) => item.id));
        schedule.exclusions.push(...additions.filter((item: any) => !ids.has(item.id)));
      }
      break;
    case "exclusion-delete":
      if (schedule) schedule.exclusions = schedule.exclusions.filter((item) => item.id !== payload.entityId);
      break;
    case "doctor-create":
      if (after && !next.doctors.some((item) => item.id === after.id)) next.doctors.push(after);
      break;
    case "doctor-update":
    case "doctor-toggle-active":
      if (after) next.doctors = next.doctors.map((item) => item.id === payload.entityId ? after : item);
      break;
    case "doctor-remove":
      next.doctors = next.doctors.filter((item) => item.id !== payload.entityId);
      next.users = next.users.filter((item) => item.doctorId !== payload.entityId);
      break;
    case "registration-approve-new":
    case "registration-approve-merge":
    case "registration-reject":
      if (after?.doctors) next.doctors = after.doctors;
      if (after?.users) next.users = after.users;
      if (after?.registrationRequests) next.registrationRequests = after.registrationRequests;
      break;
    case "request-create":
    case "request-create-published-swap":
      if (after) {
        const created = after.request ?? after;
        if (!next.changeRequests.some((item) => item.id === created.id)) next.changeRequests.unshift(created);
      }
      break;
    case "request-approve":
    case "request-reject":
    case "published-swap-rejected":
      if (after) next.changeRequests = next.changeRequests.map((item) => item.id === payload.entityId ? after : item);
      break;
    case "request-apply-to-schedule":
    case "published-swap-approved":
      if (payload.request) next.changeRequests = next.changeRequests.map((item) => item.id === payload.request.id ? payload.request : item);
      if (payload.schedule && schedule) Object.assign(schedule, payload.schedule);
      break;
    case "published-swap-direct":
      if (payload.schedule && schedule) Object.assign(schedule, payload.schedule);
      break;
    case "calendar-dry-run":
    case "calendar-mock-sync":
      if (payload.calendar) next.calendar = payload.calendar;
      break;
    case "calendar-settings-save":
      if (payload.calendar) next.calendar = { ...next.calendar, ...payload.calendar };
      break;
    case "test-data-load":
      if (Array.isArray(payload.doctors)) next.doctors = payload.doctors;
      if (Array.isArray(payload.users)) next.users = payload.users;
      break;
  }
  next.updatedAt = command.createdAt;
  return next;
}

export function createDirectMutation(type: string, payload: Record<string, unknown>, expected?: unknown): MutationCommand {
  return { id: mutationId(), type, createdAt: new Date().toISOString(), payload, expected };
}
