export type DoctorGroup = "resident" | "senior";

export type EligibilityRule =
  | "resident-only"
  | "senior-only"
  | "angio-only"
  | "resident-then-senior"
  | "senior-then-resident";

export type ScheduleStatus = "draft" | "published";
export type IssueSeverity = "error" | "warning";

export type RoleCode =
  | "resident-on-call"
  | "senior-a"
  | "senior-b"
  | "angio"
  | "half-resident"
  | "half-senior"
  | "friday-morning-resident"
  | "friday-morning-senior";

export type Role = {
  code: RoleCode;
  name: string;
  color: string;
  eligibilityRule: EligibilityRule;
  order: number;
};

export type Doctor = {
  id: string;
  name: string;
  group: DoctorGroup;
  canAngio: boolean;
  active: boolean;
};

export type Assignment = {
  doctorId: string | null;
  pending: boolean;
};

export type Exclusion = {
  id: string;
  doctorId: string;
  date: string;
  roleCode: RoleCode | null;
  reason: string;
};

export type ValidationIssue = {
  id: string;
  severity: IssueSeverity;
  message: string;
  date?: string;
  roleCode?: RoleCode;
  cellKey?: string;
};

export type CalendarSyncRecord = {
  assignmentKey: string;
  eventId: string;
  hash: string;
  lastSyncedAt: string;
};

export type PublishSnapshot = {
  id: string;
  version: number;
  createdAt: string;
  assignments: Record<string, Assignment>;
};

export type MonthSchedule = {
  key: string;
  year: number;
  month: number;
  status: ScheduleStatus;
  assignments: Record<string, Assignment>;
  exclusions: Exclusion[];
  validation: {
    checkedAt: string | null;
    stale: boolean;
    issues: ValidationIssue[];
  };
  publishSnapshots: PublishSnapshot[];
  lastSyncedAt: string | null;
};

export type DriveSyncState = {
  fileId: string | null;
  fileName: string;
  fileUrl: string | null;
  lastLoadedModifiedTime: string | null;
  lastSavedModifiedTime: string | null;
};

export type WorkspaceData = {
  schemaVersion: 1;
  workspace: {
    name: string;
    timezone: string;
    locale: "he-IL";
  };
  roles: Role[];
  doctors: Doctor[];
  schedules: Record<string, MonthSchedule>;
  calendar: {
    calendarInput: string;
    calendarId: string;
    syncRecords: Record<string, CalendarSyncRecord>;
    lastDryRun: CalendarPreviewEvent[];
  };
  driveSync: DriveSyncState;
  updatedAt: string;
};

export type CalendarPreviewEvent = {
  assignmentKey: string;
  eventId: string;
  title: string;
  date: string;
  hash: string;
};
