export type DoctorGroup = "resident" | "senior";
export type AppRole = "resident" | "senior" | "chief-resident" | "senior-planner";

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

export type AppUser = {
  id: string;
  email: string;
  name: string;
  role: AppRole;
  doctorId: string | null;
  active: boolean;
  createdAt: string;
  passwordHash?: string;
};

export type CurrentUser = {
  email: string;
  name: string;
  picture?: string;
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
  createdBy?: string;
  createdAt?: string;
};

export type ChangeRequestStatus = "submitted" | "senior-confirmed" | "approved" | "rejected" | "applied";

export type ChangeRequest = {
  id: string;
  scheduleKey: string;
  requesterDoctorId: string;
  requesterUserId: string | null;
  requesterRole: AppRole;
  date: string;
  roleCode: RoleCode;
  currentDoctorId: string | null;
  proposedDoctorId: string | null;
  reason: string;
  status: ChangeRequestStatus;
  resolutionNote: string;
  createdAt: string;
  updatedAt: string;
  decidedAt: string | null;
  decidedByUserId: string | null;
  appliedAt: string | null;
  appliedByUserId: string | null;
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

export type AuditEntityType =
  | "assignment"
  | "exclusion"
  | "doctor"
  | "user"
  | "schedule"
  | "request"
  | "drive"
  | "calendar"
  | "settings";

export type AuditEntry = {
  id: string;
  timestamp: string;
  displayTime: string;
  actorEmail: string;
  actorName: string;
  actorUserId: string | null;
  actorRole: AppRole | "unrecognized";
  action: string;
  entityType: AuditEntityType;
  entityId: string;
  scheduleKey?: string;
  date?: string;
  roleCode?: RoleCode;
  before: unknown;
  after: unknown;
  deviceId: string;
  driveVersion?: string | null;
  driveModifiedTime?: string | null;
  snapshotFileId?: string;
  snapshotUrl?: string;
  changeCode?: string;
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
  lastLoadedVersion?: string | null;
  lastSavedVersion?: string | null;
  webAppUrl?: string | null;
  username?: string | null;
};

export type WorkspaceData = {
  schemaVersion: 2;
  workspace: {
    name: string;
    timezone: string;
    locale: "he-IL";
  };
  roles: Role[];
  doctors: Doctor[];
  users: AppUser[];
  schedules: Record<string, MonthSchedule>;
  changeRequests: ChangeRequest[];
  auditLog: AuditEntry[];
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
