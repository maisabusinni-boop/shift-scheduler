import { useEffect, useMemo, useState, type ElementType } from "react";
import {
  CalendarCheck,
  Cloud,
  Download,
  FileJson,
  FileWarning,
  FolderOpen,
  History,
  LayoutDashboard,
  ListChecks,
  Plus,
  RefreshCw,
  Save,
  Settings,
  Table2,
  Upload,
  UserCheck,
  Users
} from "lucide-react";
import { createAuditEntry, type ActorContext, type AuditInput } from "@/audit";
import { createBootstrapPlanner, resolveSession } from "@/auth";
import { buildCalendarPreview, normalizeCalendarId } from "@/calendar";
import { cellKey, createId, doctorSortForRole, isDoctorEligibleForRole, isFridayOnlyRole, ROLE_CODES } from "@/domain";
import {
  connectGoogle,
  createDriveWorkspaceFile,
  extractDriveFileId,
  getCurrentGoogleUser,
  getDriveFileMetadata,
  hasDriveToken,
  loadWorkspaceFromDrive,
  saveWorkspaceToDrive
} from "@/googleDrive";
import { migrateWorkspace } from "@/migration";
import { buildMonthDays, monthKey, nextDayKey } from "@/month";
import {
  canApplyRequest,
  canEditDraftRoster,
  canEditOwnRecords,
  canEditRoster,
  canManageUsers,
  canPublish,
  canReviewRequests,
  canSeeFullAudit,
  canSeeSchedule,
  canUsePlannerTools,
  isOwnDoctor
} from "@/permissions";
import { getInstallPrompt, isStandaloneMode, subscribeInstallPrompt } from "@/pwaInstall";
import { createChangeRequest, nextRequestStatusForDecision } from "@/requests";
import { addPublishSnapshot, cloneWorkspace, ensureSchedule } from "@/sampleData";
import {
  downloadCsv,
  downloadJson,
  loadDeviceId,
  loadGoogleClientId,
  loadLocalWorkspace,
  saveGoogleClientId,
  saveLocalWorkspace
} from "@/storage";
import type {
  AppRole,
  AppUser,
  Assignment,
  AuditEntry,
  ChangeRequest,
  CurrentUser,
  Doctor,
  MonthSchedule,
  Role,
  RoleCode,
  WorkspaceData
} from "@/types";
import { validateSchedule } from "@/validation";
import "./styles.css";

type TabId = "dashboard" | "roster" | "exclusions" | "requests" | "doctors" | "review" | "audit" | "drive" | "calendar" | "settings";

const tabs: Array<{ id: TabId; label: string; icon: ElementType; plannerOnly?: boolean; scheduleEditor?: boolean; requestReviewer?: boolean; audit?: boolean }> = [
  { id: "dashboard", label: "לוח בקרה", icon: LayoutDashboard },
  { id: "roster", label: "שיבוץ", icon: Table2, scheduleEditor: true },
  { id: "exclusions", label: "אילוצים", icon: FileWarning },
  { id: "requests", label: "שינוי תורנות", icon: UserCheck },
  { id: "doctors", label: "רופאים ומשתמשים", icon: Users, plannerOnly: true },
  { id: "review", label: "בדיקה ופרסום", icon: ListChecks, scheduleEditor: true },
  { id: "audit", label: "יומן פעולות", icon: History, audit: true },
  { id: "drive", label: "Drive Sync", icon: Cloud, plannerOnly: true },
  { id: "calendar", label: "יומן Google", icon: CalendarCheck, plannerOnly: true },
  { id: "settings", label: "הגדרות / יבוא", icon: Settings, plannerOnly: true }
];

const roleLabels: Record<AppRole, string> = {
  resident: "מתמחה",
  senior: "בכיר",
  "chief-resident": "צ׳יף מתמחים",
  "senior-planner": "מתכנן בכיר"
};

const current = new Date();

export function App() {
  const [data, setData] = useState<WorkspaceData>(() => loadLocalWorkspace());
  const [year, setYear] = useState(current.getFullYear());
  const [month, setMonth] = useState(current.getMonth() + 1);
  const [tab, setTab] = useState<TabId>("dashboard");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [focusCell, setFocusCell] = useState<string | null>(null);
  const [clientId, setClientId] = useState(() => loadGoogleClientId());
  const [driveFileInput, setDriveFileInput] = useState("");
  const [calendarInput, setCalendarInput] = useState(data.calendar.calendarInput);
  const [installAvailable, setInstallAvailable] = useState(() => Boolean(getInstallPrompt()));
  const [googleUser, setGoogleUser] = useState<CurrentUser | null>(null);
  const [deviceId] = useState(() => loadDeviceId());
  const [doctorForm, setDoctorForm] = useState({ name: "", group: "resident" as Doctor["group"], canAngio: false });
  const [userForm, setUserForm] = useState({ email: "", name: "", role: "resident" as AppRole, doctorId: "" });
  const [exclusionForm, setExclusionForm] = useState({ doctorId: "", roleCode: "", reason: "" });
  const [requestForm, setRequestForm] = useState({ date: "", roleCode: ROLE_CODES.RESIDENT_ON_CALL as RoleCode, proposedDoctorId: "", reason: "" });
  const [selectedDates, setSelectedDates] = useState<string[]>([]);
  const [importText, setImportText] = useState("");

  const key = monthKey(year, month);
  const workspace = useMemo(() => ensureSchedule(data, year, month), [data, year, month]);
  const schedule = workspace.schedules[key];
  const days = useMemo(() => buildMonthDays(year, month), [year, month]);
  const session = useMemo(() => resolveSession(workspace, googleUser), [workspace, googleUser]);
  const role = session.role;
  const appUser = session.status === "recognized" ? session.appUser : null;
  const sessionDoctor = session.status === "recognized" ? session.doctor : null;
  const visibleTabs = useMemo(() => tabs.filter((item) => canSeeTab(item, role)), [role]);
  const doctorById = useMemo(() => new Map(workspace.doctors.map((doctor) => [doctor.id, doctor])), [workspace.doctors]);

  useEffect(() => {
    if (workspace !== data) {
      setAndPersist(workspace);
    }
  }, [workspace, data]);

  useEffect(() => {
    return subscribeInstallPrompt(() => setInstallAvailable(Boolean(getInstallPrompt())));
  }, []);

  useEffect(() => {
    if (!visibleTabs.some((item) => item.id === tab)) {
      setTab(visibleTabs[0]?.id ?? "dashboard");
    }
  }, [tab, visibleTabs]);

  function setAndPersist(next: WorkspaceData) {
    saveLocalWorkspace(next);
    setData(next);
  }

  function actorFor(next?: WorkspaceData): ActorContext {
    const target = next ?? workspace;
    return {
      googleUser,
      appUserId: appUser?.id ?? null,
      appRole: role ?? "unrecognized",
      deviceId,
      driveSync: target.driveSync
    };
  }

  function commitChange(input: {
    mutator: (draft: WorkspaceData, schedule: MonthSchedule) => AuditInput | AuditInput[] | void;
    note?: string;
    system?: boolean;
  }) {
    const draft = ensureSchedule(cloneWorkspace(data), year, month);
    const audits = input.mutator(draft, draft.schedules[key]);
    draft.updatedAt = new Date().toISOString();
    if (!input.system) {
      const entries = Array.isArray(audits) ? audits : audits ? [audits] : [];
      draft.auditLog.unshift(...entries.map((entry) => createAuditEntry(actorFor(draft), entry)));
    }
    setAndPersist(draft);
    if (input.note) setMessage(input.note);
  }

  async function run(action: () => Promise<void>, note?: string) {
    setBusy(true);
    setMessage("");
    try {
      await action();
      if (note) setMessage(note);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "הפעולה נכשלה.");
    } finally {
      setBusy(false);
    }
  }

  function requireUser() {
    if (!appUser) throw new Error("צריך להתחבר כמשתמש מוכר.");
    return appUser;
  }

  async function connectAndIdentify() {
    await connectGoogle(clientId);
    saveGoogleClientId(clientId);
    const profile = await getCurrentGoogleUser();
    setGoogleUser(profile);
    setMessage(`מחובר כ-${profile.email}`);
  }

  function bootstrapPlanner() {
    if (session.status !== "bootstrap") return;
    commitChange({
      mutator: (draft) => {
        const user = createBootstrapPlanner(session.googleUser);
        draft.users.push(user);
        return {
          action: "bootstrap-senior-planner",
          entityType: "user",
          entityId: user.id,
          before: null,
          after: user
        };
      },
      note: "משתמש ראשון הוגדר כמתכנן בכיר."
    });
  }

  function updateAssignment(date: string, roleCode: RoleCode, value: string) {
    if (!canEditRoster(role, schedule)) {
      setMessage("רק צ׳יף או מתכנן בכיר יכולים לערוך טיוטת שיבוץ.");
      return;
    }
    commitChange({
      mutator: (_draft, currentSchedule) => {
        const assignment: Assignment = value === "__pending" || !value ? { doctorId: null, pending: value === "__pending" } : { doctorId: value, pending: false };
        const keys = [cellKey(date, roleCode)];
        const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
        if ((roleCode === ROLE_CODES.SENIOR_A || roleCode === ROLE_CODES.FRIDAY_MORNING_SENIOR) && weekday === 5) {
          keys.push(cellKey(date, ROLE_CODES.SENIOR_A), cellKey(date, ROLE_CODES.FRIDAY_MORNING_SENIOR), cellKey(nextDayKey(date), ROLE_CODES.HALF_SENIOR));
        }
        const uniqueKeys = Array.from(new Set(keys));
        const before = Object.fromEntries(uniqueKeys.map((item) => [item, currentSchedule.assignments[item] ?? null]));
        uniqueKeys.forEach((item) => {
          currentSchedule.assignments[item] = assignment;
        });
        currentSchedule.validation.stale = true;
        return {
          action: "assignment-update",
          entityType: "assignment",
          entityId: cellKey(date, roleCode),
          scheduleKey: currentSchedule.key,
          date,
          roleCode,
          before,
          after: Object.fromEntries(uniqueKeys.map((item) => [item, currentSchedule.assignments[item]]))
        };
      },
      note: "נשמר מקומית."
    });
  }

  function validateCurrent() {
    if (!canEditDraftRoster(role)) return setMessage("אין הרשאה להריץ בדיקה.");
    commitChange({
      mutator: (draft, currentSchedule) => {
        const before = currentSchedule.validation;
        currentSchedule.validation = {
          checkedAt: new Date().toISOString(),
          stale: false,
          issues: validateSchedule(currentSchedule, draft.roles, draft.doctors)
        };
        return {
          action: "schedule-validate",
          entityType: "schedule",
          entityId: currentSchedule.key,
          scheduleKey: currentSchedule.key,
          before,
          after: currentSchedule.validation
        };
      },
      note: "הבדיקה הושלמה."
    });
  }

  function publishCurrent() {
    if (!canPublish(role)) return setMessage("רק מתכנן בכיר יכול לפרסם.");
    const issues = validateSchedule(schedule, workspace.roles, workspace.doctors);
    if (issues.some((issue) => issue.severity === "error")) {
      commitChange({
        mutator: (_draft, currentSchedule) => {
          const before = currentSchedule.validation;
          currentSchedule.validation = { checkedAt: new Date().toISOString(), stale: false, issues };
          return { action: "publish-blocked", entityType: "schedule", entityId: currentSchedule.key, scheduleKey: currentSchedule.key, before, after: currentSchedule.validation };
        },
        note: "אי אפשר לפרסם לפני תיקון שגיאות."
      });
      return;
    }
    commitChange({
      mutator: (_draft, currentSchedule) => {
        const before = { status: currentSchedule.status, snapshots: currentSchedule.publishSnapshots.length };
        currentSchedule.validation = { checkedAt: new Date().toISOString(), stale: false, issues };
        currentSchedule.status = "published";
        addPublishSnapshot(currentSchedule);
        return {
          action: "schedule-publish",
          entityType: "schedule",
          entityId: currentSchedule.key,
          scheduleKey: currentSchedule.key,
          before,
          after: { status: currentSchedule.status, snapshots: currentSchedule.publishSnapshots.length }
        };
      },
      note: "החודש פורסם."
    });
  }

  function unpublishCurrent() {
    if (!canPublish(role)) return setMessage("רק מתכנן בכיר יכול להחזיר לטיוטה.");
    commitChange({
      mutator: (_draft, currentSchedule) => {
        const before = currentSchedule.status;
        currentSchedule.status = "draft";
        return { action: "schedule-unpublish", entityType: "schedule", entityId: currentSchedule.key, scheduleKey: currentSchedule.key, before, after: currentSchedule.status };
      },
      note: "החודש הוחזר לטיוטה."
    });
  }

  function addExclusions() {
    if (!appUser || !canEditOwnRecords(role)) return setMessage("צריך להתחבר כדי להוסיף אילוצים.");
    const doctorId = canUsePlannerTools(role) ? exclusionForm.doctorId : appUser.doctorId ?? "";
    if (!doctorId || !selectedDates.length) return setMessage("צריך לבחור תאריך אחד לפחות.");
    if (!canUsePlannerTools(role) && !isOwnDoctor(appUser, sessionDoctor, doctorId)) return setMessage("אפשר לערוך רק אילוצים שלך.");
    commitChange({
      mutator: (_draft, currentSchedule) => {
        const created = selectedDates.map((date) => ({
          id: createId("exclusion"),
          doctorId,
          date,
          roleCode: (exclusionForm.roleCode || null) as RoleCode | null,
          reason: exclusionForm.reason,
          createdBy: appUser.id,
          createdAt: new Date().toISOString()
        }));
        currentSchedule.exclusions.push(...created);
        currentSchedule.validation.stale = true;
        return {
          action: "exclusion-create",
          entityType: "exclusion",
          entityId: created.map((item) => item.id).join(","),
          scheduleKey: currentSchedule.key,
          before: null,
          after: created
        };
      },
      note: "האילוצים נוספו."
    });
    setSelectedDates([]);
    setExclusionForm({ doctorId: canUsePlannerTools(role) ? "" : doctorId, roleCode: "", reason: "" });
  }

  function deleteExclusion(id: string) {
    commitChange({
      mutator: (_draft, currentSchedule) => {
        const target = currentSchedule.exclusions.find((item) => item.id === id);
        if (!target) return;
        if (!canUsePlannerTools(role) && !isOwnDoctor(appUser, sessionDoctor, target.doctorId)) {
          throw new Error("אפשר למחוק רק אילוצים שלך.");
        }
        currentSchedule.exclusions = currentSchedule.exclusions.filter((exclusion) => exclusion.id !== id);
        currentSchedule.validation.stale = true;
        return { action: "exclusion-delete", entityType: "exclusion", entityId: id, scheduleKey: currentSchedule.key, before: target, after: null };
      },
      note: "האילוץ נמחק."
    });
  }

  function addDoctor() {
    if (!canManageUsers(role)) return setMessage("רק מתכנן בכיר יכול לנהל רופאים.");
    if (!doctorForm.name.trim()) return setMessage("צריך שם רופא.");
    commitChange({
      mutator: (draft) => {
        const doctor: Doctor = { id: createId("doctor"), name: doctorForm.name.trim(), group: doctorForm.group, canAngio: doctorForm.canAngio, active: true };
        draft.doctors.push(doctor);
        return { action: "doctor-create", entityType: "doctor", entityId: doctor.id, before: null, after: doctor };
      },
      note: "הרופא נוסף."
    });
    setDoctorForm({ name: "", group: "resident", canAngio: false });
  }

  function toggleDoctor(doctorId: string) {
    if (!canManageUsers(role)) return setMessage("רק מתכנן בכיר יכול לנהל רופאים.");
    commitChange({
      mutator: (draft, currentSchedule) => {
        const doctor = draft.doctors.find((candidate) => candidate.id === doctorId);
        if (!doctor) return;
        const before = { ...doctor };
        doctor.active = !doctor.active;
        currentSchedule.validation.stale = true;
        return { action: "doctor-toggle-active", entityType: "doctor", entityId: doctorId, before, after: doctor };
      },
      note: "עודכן."
    });
  }

  function addUser() {
    if (!canManageUsers(role)) return setMessage("רק מתכנן בכיר יכול לנהל משתמשים.");
    if (!userForm.email.trim() || !userForm.name.trim()) return setMessage("צריך שם ומייל.");
    commitChange({
      mutator: (draft) => {
        const user: AppUser = {
          id: createId("user"),
          email: userForm.email.trim().toLowerCase(),
          name: userForm.name.trim(),
          role: userForm.role,
          doctorId: userForm.doctorId || null,
          active: true,
          createdAt: new Date().toISOString()
        };
        draft.users.push(user);
        return { action: "user-create", entityType: "user", entityId: user.id, before: null, after: user };
      },
      note: "המשתמש נוסף."
    });
    setUserForm({ email: "", name: "", role: "resident", doctorId: "" });
  }

  function toggleUser(userId: string) {
    if (!canManageUsers(role)) return setMessage("רק מתכנן בכיר יכול לנהל משתמשים.");
    commitChange({
      mutator: (draft) => {
        const user = draft.users.find((candidate) => candidate.id === userId);
        if (!user) return;
        const before = { ...user };
        user.active = !user.active;
        return { action: "user-toggle-active", entityType: "user", entityId: userId, before, after: user };
      },
      note: "משתמש עודכן."
    });
  }

  function submitRequest() {
    const user = requireUser();
    if (!user.doctorId) return setMessage("המשתמש לא מקושר לרופא.");
    if (!requestForm.date || !requestForm.roleCode) return setMessage("צריך תאריך ותפקיד.");
    commitChange({
      mutator: (_draft, currentSchedule) => {
        const request = createChangeRequest({
          schedule: currentSchedule,
          requesterUser: user,
          date: requestForm.date,
          roleCode: requestForm.roleCode,
          proposedDoctorId: requestForm.proposedDoctorId || null,
          reason: requestForm.reason
        });
        _draft.changeRequests.unshift(request);
        return { action: "request-create", entityType: "request", entityId: request.id, scheduleKey: currentSchedule.key, date: request.date, roleCode: request.roleCode, before: null, after: request };
      },
      note: "בקשת שינוי נרשמה."
    });
    setRequestForm({ date: "", roleCode: ROLE_CODES.RESIDENT_ON_CALL, proposedDoctorId: "", reason: "" });
  }

  function decideRequest(requestId: string, decision: "approve" | "reject") {
    if (!canReviewRequests(role)) return setMessage("אין הרשאה לטפל בבקשות.");
    commitChange({
      mutator: (draft) => {
        const request = draft.changeRequests.find((item) => item.id === requestId);
        if (!request) return;
        const before = { ...request };
        request.status = nextRequestStatusForDecision(request.status, decision, role!);
        request.decidedAt = new Date().toISOString();
        request.decidedByUserId = appUser?.id ?? null;
        request.updatedAt = request.decidedAt;
        return { action: `request-${decision}`, entityType: "request", entityId: request.id, scheduleKey: request.scheduleKey, date: request.date, roleCode: request.roleCode, before, after: request };
      },
      note: decision === "approve" ? "הבקשה אושרה." : "הבקשה נדחתה."
    });
  }

  function applyRequest(requestId: string) {
    const request = workspace.changeRequests.find((item) => item.id === requestId);
    if (!request || !canApplyRequest(role, request)) return setMessage("אין הרשאה להחיל בקשה.");
    commitChange({
      mutator: (draft) => {
        const targetRequest = draft.changeRequests.find((item) => item.id === requestId);
        const targetSchedule = targetRequest ? draft.schedules[targetRequest.scheduleKey] : null;
        if (!targetRequest || !targetSchedule) return;
        const assignmentKey = cellKey(targetRequest.date, targetRequest.roleCode);
        const before = {
          request: { ...targetRequest },
          assignment: targetSchedule.assignments[assignmentKey] ?? null
        };
        targetSchedule.assignments[assignmentKey] = { doctorId: targetRequest.proposedDoctorId ?? targetRequest.requesterDoctorId, pending: false };
        targetSchedule.validation.stale = true;
        targetRequest.status = "applied";
        targetRequest.appliedAt = new Date().toISOString();
        targetRequest.appliedByUserId = appUser?.id ?? null;
        targetRequest.updatedAt = targetRequest.appliedAt;
        return {
          action: "request-apply-to-schedule",
          entityType: "request",
          entityId: targetRequest.id,
          scheduleKey: targetRequest.scheduleKey,
          date: targetRequest.date,
          roleCode: targetRequest.roleCode,
          before,
          after: { request: targetRequest, assignment: targetSchedule.assignments[assignmentKey] }
        };
      },
      note: "הבקשה הוחלה על השיבוץ."
    });
  }

  async function dryRunCalendar() {
    const preview = await buildCalendarPreview(schedule, workspace.roles, workspace);
    commitChange({
      mutator: (draft) => {
        const before = draft.calendar;
        draft.calendar = { ...draft.calendar, calendarInput, calendarId: normalizeCalendarId(calendarInput), lastDryRun: preview };
        return { action: "calendar-dry-run", entityType: "calendar", entityId: "calendar", scheduleKey: key, before, after: draft.calendar };
      },
      note: "תצוגת יומן נוצרה."
    });
  }

  async function mockCalendarSync() {
    if (schedule.status !== "published") return setMessage("טיוטה לא מסתנכרנת ליומן.");
    const preview = await buildCalendarPreview(schedule, workspace.roles, workspace);
    commitChange({
      mutator: (draft, currentSchedule) => {
        const before = { calendar: draft.calendar, lastSyncedAt: currentSchedule.lastSyncedAt };
        draft.calendar.calendarInput = calendarInput;
        draft.calendar.calendarId = normalizeCalendarId(calendarInput);
        draft.calendar.lastDryRun = preview;
        preview.forEach((event) => {
          draft.calendar.syncRecords[event.assignmentKey] = { assignmentKey: event.assignmentKey, eventId: event.eventId, hash: event.hash, lastSyncedAt: new Date().toISOString() };
        });
        currentSchedule.lastSyncedAt = new Date().toISOString();
        return { action: "calendar-mock-sync", entityType: "calendar", entityId: "calendar", scheduleKey: currentSchedule.key, before, after: { calendar: draft.calendar, lastSyncedAt: currentSchedule.lastSyncedAt } };
      },
      note: "סנכרון יומן מדומה נרשם."
    });
  }

  const counts = useMemo(() => {
    const assigned = Object.values(schedule.assignments).filter((assignment) => assignment.doctorId && !assignment.pending).length;
    const pending = workspace.roles.length * days.length - assigned;
    const errors = schedule.validation.issues.filter((issue) => issue.severity === "error").length;
    const warnings = schedule.validation.issues.filter((issue) => issue.severity === "warning").length;
    return { assigned, pending, errors, warnings };
  }, [schedule, days.length, workspace.roles.length]);

  const canViewActiveSchedule = canSeeSchedule(role, schedule);
  const ownDoctorId = appUser?.doctorId ?? "";
  const visibleExclusions = canUsePlannerTools(role) ? schedule.exclusions : schedule.exclusions.filter((item) => item.doctorId === ownDoctorId);

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <h1>{workspace.workspace.name}</h1>
          <p>Chrome-only · Google login · Drive workspace · audit trail</p>
        </div>
        <div className="month-controls">
          <input type="number" value={month} min={1} max={12} onChange={(event) => setMonth(Number(event.target.value))} />
          <input type="number" value={year} min={2020} max={2100} onChange={(event) => setYear(Number(event.target.value))} />
          <span className={`status ${schedule.status}`}>{schedule.status === "published" ? "פורסם" : "טיוטה"}</span>
        </div>
      </header>

      <LoginBar
        clientId={clientId}
        setClientId={setClientId}
        session={session}
        connect={() => run(connectAndIdentify)}
        bootstrap={bootstrapPlanner}
        busy={busy}
      />

      {session.status === "blocked" ? <BlockedUser email={session.googleUser.email} /> : null}
      {message ? <div className="notice">{message}</div> : null}

      {role ? (
        <>
          <nav className="tabs">
            {visibleTabs.map((item) => {
              const Icon = item.icon;
              return (
                <button key={item.id} className={`tab ${tab === item.id ? "active" : ""}`} onClick={() => setTab(item.id)}>
                  <Icon size={17} />
                  {item.label}
                </button>
              );
            })}
          </nav>

          {tab === "dashboard" && (
            <Dashboard
              schedule={schedule}
              counts={counts}
              driveName={workspace.driveSync.fileName}
              role={role}
              userName={session.googleUser?.name ?? ""}
              validateCurrent={validateCurrent}
              publishCurrent={publishCurrent}
              unpublishCurrent={unpublishCurrent}
              installAvailable={installAvailable}
              installApp={async () => {
                const prompt = getInstallPrompt();
                if (!prompt) return setMessage("אם כפתור התקנה לא מופיע, פתח את תפריט Chrome ובחר Install app / Create shortcut.");
                await prompt.prompt();
                const choice = await prompt.userChoice;
                setInstallAvailable(Boolean(getInstallPrompt()));
                setMessage(choice.outcome === "accepted" ? "האפליקציה הותקנה כאייקון." : "ההתקנה בוטלה.");
              }}
            />
          )}
          {tab === "roster" && (
            canViewActiveSchedule ? (
              <Roster schedule={schedule} roles={workspace.roles} doctors={workspace.doctors} days={days} focusCell={focusCell} editable={canEditRoster(role, schedule)} updateAssignment={updateAssignment} />
            ) : (
              <LockedPanel title="השיבוץ עדיין טיוטה" text="מתמחים ובכירים רגילים יראו את החודש רק אחרי פרסום." />
            )
          )}
          {tab === "exclusions" && (
            <Exclusions
              schedule={schedule}
              exclusions={visibleExclusions}
              doctors={workspace.doctors}
              roles={workspace.roles}
              days={days}
              form={{ ...exclusionForm, doctorId: canUsePlannerTools(role) ? exclusionForm.doctorId : ownDoctorId }}
              canChooseDoctor={canUsePlannerTools(role)}
              setForm={setExclusionForm}
              selectedDates={selectedDates}
              setSelectedDates={setSelectedDates}
              addExclusions={addExclusions}
              deleteExclusion={deleteExclusion}
            />
          )}
          {tab === "requests" && (
            <RequestsPanel
              data={workspace}
              schedule={schedule}
              doctors={workspace.doctors}
              roles={workspace.roles}
              appUser={appUser}
              canReview={canReviewRequests(role)}
              canApply={(request) => canApplyRequest(role, request)}
              form={requestForm}
              setForm={setRequestForm}
              submitRequest={submitRequest}
              approve={(id) => decideRequest(id, "approve")}
              reject={(id) => decideRequest(id, "reject")}
              applyRequest={applyRequest}
            />
          )}
          {tab === "doctors" && (
            <Doctors
              data={workspace}
              form={doctorForm}
              setForm={setDoctorForm}
              userForm={userForm}
              setUserForm={setUserForm}
              addDoctor={addDoctor}
              toggleDoctor={toggleDoctor}
              addUser={addUser}
              toggleUser={toggleUser}
            />
          )}
          {tab === "review" && <Review schedule={schedule} counts={counts} validateCurrent={validateCurrent} publishCurrent={publishCurrent} canPublish={canPublish(role)} setFocusCell={(cell) => { setFocusCell(cell); setTab("roster"); }} />}
          {tab === "audit" && <AuditPanel entries={workspace.auditLog} full={canSeeFullAudit(role)} appUser={appUser} />}
          {tab === "drive" && (
            <DrivePanel
              data={workspace}
              clientId={clientId}
              setClientId={setClientId}
              driveFileInput={driveFileInput}
              setDriveFileInput={setDriveFileInput}
              busy={busy}
              run={run}
              setAndPersist={setAndPersist}
              actorRole={role}
              actor={actorFor()}
            />
          )}
          {tab === "calendar" && <CalendarPanel data={workspace} schedule={schedule} calendarInput={calendarInput} setCalendarInput={setCalendarInput} dryRunCalendar={() => run(dryRunCalendar)} mockCalendarSync={() => run(mockCalendarSync)} />}
          {tab === "settings" && (
            <SettingsPanel
              data={workspace}
              scheduleKey={key}
              importText={importText}
              setImportText={setImportText}
              importJson={() => {
                try {
                  const parsed = migrateWorkspace(JSON.parse(importText));
                  setAndPersist(parsed);
                  setMessage("קובץ JSON נטען.");
                } catch {
                  setMessage("JSON לא תקין.");
                }
              }}
              exportJson={() => downloadJson(workspace)}
              exportCsv={() => downloadCsv(workspace, key)}
            />
          )}
        </>
      ) : null}
    </main>
  );
}

function canSeeTab(item: (typeof tabs)[number], role: AppRole | null) {
  if (!role) return false;
  if (item.plannerOnly) return canUsePlannerTools(role);
  if (item.scheduleEditor) return role === "senior-planner" || role === "chief-resident";
  if (item.requestReviewer) return canReviewRequests(role);
  if (item.audit) return role === "senior-planner" || role === "chief-resident";
  return true;
}

function LoginBar({
  clientId,
  setClientId,
  session,
  connect,
  bootstrap,
  busy
}: {
  clientId: string;
  setClientId: (value: string) => void;
  session: ReturnType<typeof resolveSession>;
  connect: () => void;
  bootstrap: () => void;
  busy: boolean;
}) {
  return (
    <section className="login-strip">
      <div>
        <strong>{session.googleUser ? session.googleUser.name : "לא מחובר"}</strong>
        <span>{session.googleUser ? session.googleUser.email : "התחבר עם Google כדי לקבל הרשאות לפי תפקיד"}</span>
      </div>
      {session.role ? <b>{roleLabels[session.role]}</b> : null}
      <input dir="ltr" value={clientId} onChange={(event) => setClientId(event.target.value)} placeholder="Google OAuth Client ID" />
      <button onClick={connect} disabled={busy}><Cloud size={17} />התחבר Google</button>
      {session.status === "bootstrap" ? <button className="primary" onClick={bootstrap}>הגדר אותי כמתכנן ראשון</button> : null}
    </section>
  );
}

function BlockedUser({ email }: { email: string }) {
  return <section className="panel"><h2>אין הרשאה</h2><p>החשבון {email} לא נמצא ברשימת המשתמשים. פנה למתכנן הבכיר כדי שיוסיף אותך.</p></section>;
}

function LockedPanel({ title, text }: { title: string; text: string }) {
  return <section className="panel"><h2>{title}</h2><p>{text}</p></section>;
}

function Dashboard({
  schedule,
  counts,
  driveName,
  role,
  userName,
  validateCurrent,
  publishCurrent,
  unpublishCurrent,
  installAvailable,
  installApp
}: {
  schedule: MonthSchedule;
  counts: { assigned: number; pending: number; errors: number; warnings: number };
  driveName: string;
  role: AppRole;
  userName: string;
  validateCurrent: () => void;
  publishCurrent: () => void;
  unpublishCurrent: () => void;
  installAvailable: boolean;
  installApp: () => Promise<void>;
}) {
  return (
    <section className="sheet-dashboard">
      <div className="dashboard-title">Dashboard</div>
      <div className="status-grid">
        <InfoCell label="משתמש" value={userName || "מחובר"} />
        <InfoCell label="תפקיד" value={roleLabels[role]} />
        <InfoCell label="חודש פעיל" value={schedule.key} />
        <InfoCell label="סטטוס" value={schedule.status === "published" ? "פורסם" : "טיוטה"} tone={schedule.status === "published" ? "good" : "warn"} />
        <InfoCell label="בדיקה" value={schedule.validation.stale ? "צריך בדיקה" : "נבדק"} tone={schedule.validation.stale ? "warn" : "good"} />
        <InfoCell label="קובץ Drive" value={driveName} />
        <InfoCell label="שגיאות" value={String(counts.errors)} tone={counts.errors ? "bad" : "good"} />
        <InfoCell label="אזהרות" value={String(counts.warnings)} tone={counts.warnings ? "warn" : "good"} />
        <InfoCell label="שיבוצים" value={String(counts.assigned)} />
        <InfoCell label="סנכרון יומן" value={schedule.lastSyncedAt ? new Date(schedule.lastSyncedAt).toLocaleString("he-IL") : "טרם סונכרן"} />
        <InfoCell label="מצב אפליקציה" value={isStandaloneMode() ? "מותקן כאייקון" : installAvailable ? "מוכן להתקנה" : "פתוח בדפדפן"} tone={isStandaloneMode() ? "good" : installAvailable ? "warn" : undefined} />
      </div>
      <div className="action-map">
        <button onClick={validateCurrent} disabled={!canEditDraftRoster(role)}>בדוק וסמן בעיות</button>
        <button onClick={publishCurrent} disabled={!canPublish(role)}>פרסם חודש</button>
        <button onClick={unpublishCurrent} disabled={!canPublish(role)}>החזר לטיוטה</button>
        <button onClick={installApp}>התקן כאייקון Chrome</button>
      </div>
    </section>
  );
}

function InfoCell({ label, value, tone }: { label: string; value: string; tone?: "good" | "warn" | "bad" }) {
  return <div className={`info-cell ${tone ?? ""}`}><span>{label}</span><b>{value}</b></div>;
}

function Roster({
  schedule,
  roles,
  doctors,
  days,
  focusCell,
  editable,
  updateAssignment
}: {
  schedule: MonthSchedule;
  roles: Role[];
  doctors: Doctor[];
  days: ReturnType<typeof buildMonthDays>;
  focusCell: string | null;
  editable: boolean;
  updateAssignment: (date: string, roleCode: RoleCode, value: string) => void;
}) {
  const issueByCell = new Map(schedule.validation.issues.map((issue) => [issue.cellKey, issue.severity]));
  return (
    <section className="panel">
      <div className="toolbar"><h2>שיבוץ חודשי</h2><span>{editable ? "מצב עריכה" : "קריאה בלבד"}</span></div>
      <div className="board-wrap">
        <table className="roster-table">
          <thead><tr><th className="sticky-date">תאריך</th>{roles.map((role) => <th key={role.code}><span className="role-title"><i style={{ background: role.color }} />{role.name}</span></th>)}</tr></thead>
          <tbody>
            {days.map((day) => (
              <tr key={day.key}>
                <th className="sticky-date"><strong>{day.day}</strong><span>{day.weekdayLabel}</span></th>
                {roles.map((role) => {
                  const key = cellKey(day.key, role.code);
                  const assignment = schedule.assignments[key] ?? { doctorId: null, pending: false };
                  const disabled = isFridayOnlyRole(role.code) && !day.isFriday;
                  const issue = issueByCell.get(key);
                  const options = doctors.filter((doctor) => isDoctorEligibleForRole(doctor, role)).sort(doctorSortForRole(role));
                  return (
                    <td key={role.code} id={`cell-${key}`} className={`${disabled ? "disabled" : ""} ${issue ?? ""} ${focusCell === key ? "focused" : ""}`}>
                      {disabled ? <span className="blocked-cell">לא פעיל</span> : (
                        <select disabled={!editable} value={assignment.pending ? "__pending" : assignment.doctorId ?? ""} onChange={(event) => updateAssignment(day.key, role.code, event.target.value)}>
                          <option value="">לא שובץ</option>
                          <option value="__pending">ממתין</option>
                          {options.map((doctor) => <option key={doctor.id} value={doctor.id}>{doctor.group === "resident" ? "מתמחה · " : "בכיר · "}{doctor.name}{doctor.canAngio ? " · אנגיו" : ""}</option>)}
                        </select>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Exclusions({
  exclusions,
  doctors,
  roles,
  days,
  form,
  canChooseDoctor,
  setForm,
  selectedDates,
  setSelectedDates,
  addExclusions,
  deleteExclusion
}: {
  schedule: MonthSchedule;
  exclusions: MonthSchedule["exclusions"];
  doctors: Doctor[];
  roles: Role[];
  days: ReturnType<typeof buildMonthDays>;
  form: { doctorId: string; roleCode: string; reason: string };
  canChooseDoctor: boolean;
  setForm: (value: { doctorId: string; roleCode: string; reason: string }) => void;
  selectedDates: string[];
  setSelectedDates: (dates: string[]) => void;
  addExclusions: () => void;
  deleteExclusion: (id: string) => void;
}) {
  return (
    <section className="panel two">
      <div>
        <div className="toolbar"><h2>אילוצים</h2><button className="primary" onClick={addExclusions}><Plus size={17} />הוסף חסימה</button></div>
        <div className="form-row">
          {canChooseDoctor ? (
            <select value={form.doctorId} onChange={(event) => setForm({ ...form, doctorId: event.target.value })}>
              <option value="">בחר רופא</option>
              {doctors.map((doctor) => <option key={doctor.id} value={doctor.id}>{doctor.name}</option>)}
            </select>
          ) : <span className="readonly-chip">{doctors.find((doctor) => doctor.id === form.doctorId)?.name ?? "המשתמש לא מקושר לרופא"}</span>}
          <select value={form.roleCode} onChange={(event) => setForm({ ...form, roleCode: event.target.value })}>
            <option value="">כל היום</option>
            {roles.map((role) => <option key={role.code} value={role.code}>{role.name}</option>)}
          </select>
          <input value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} placeholder="סיבה / הערה" />
        </div>
        <div className="month-picker">
          {days.map((day) => {
            const active = selectedDates.includes(day.key);
            return <button key={day.key} className={active ? "selected" : ""} onClick={() => setSelectedDates(active ? selectedDates.filter((date) => date !== day.key) : [...selectedDates, day.key])}><b>{day.day}</b><span>{day.weekdayLabel}</span></button>;
          })}
        </div>
      </div>
      <div className="list">
        {exclusions.map((exclusion) => {
          const doctor = doctors.find((candidate) => candidate.id === exclusion.doctorId);
          const role = roles.find((candidate) => candidate.code === exclusion.roleCode);
          return <div className="list-row" key={exclusion.id}><span>{doctor?.name ?? "רופא לא ידוע"} · {exclusion.date} · {role?.name ?? "כל היום"}{exclusion.reason ? <small> · {exclusion.reason}</small> : null}</span><button onClick={() => deleteExclusion(exclusion.id)}>מחק</button></div>;
        })}
      </div>
    </section>
  );
}

function RequestsPanel({
  data,
  schedule,
  doctors,
  roles,
  appUser,
  canReview,
  canApply,
  form,
  setForm,
  submitRequest,
  approve,
  reject,
  applyRequest
}: {
  data: WorkspaceData;
  schedule: MonthSchedule;
  doctors: Doctor[];
  roles: Role[];
  appUser: AppUser | null;
  canReview: boolean;
  canApply: (request: ChangeRequest) => boolean;
  form: { date: string; roleCode: RoleCode; proposedDoctorId: string; reason: string };
  setForm: (value: { date: string; roleCode: RoleCode; proposedDoctorId: string; reason: string }) => void;
  submitRequest: () => void;
  approve: (id: string) => void;
  reject: (id: string) => void;
  applyRequest: (id: string) => void;
}) {
  const visibleRequests = canReview ? data.changeRequests : data.changeRequests.filter((request) => request.requesterUserId === appUser?.id);
  return (
    <section className="panel two">
      <div>
        <div className="toolbar"><h2>שינוי תורנות</h2><button className="primary" onClick={submitRequest}><Plus size={17} />שלח בקשה</button></div>
        <div className="form-row">
          <input type="date" value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} />
          <select value={form.roleCode} onChange={(event) => setForm({ ...form, roleCode: event.target.value as RoleCode })}>
            {roles.map((role) => <option key={role.code} value={role.code}>{role.name}</option>)}
          </select>
          <select value={form.proposedDoctorId} onChange={(event) => setForm({ ...form, proposedDoctorId: event.target.value })}>
            <option value="">ללא מחליף מוצע</option>
            {doctors.map((doctor) => <option key={doctor.id} value={doctor.id}>{doctor.name}</option>)}
          </select>
          <input value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} placeholder="סיבה / פרטים" />
        </div>
        <p className="hint">בקשות בכירים נרשמות כמאושרות-בכיר, אבל עדיין מוחלות על השיבוץ דרך פעולה מתועדת.</p>
      </div>
      <div className="list">
        {visibleRequests.map((request) => {
          const requester = doctors.find((doctor) => doctor.id === request.requesterDoctorId);
          const proposed = request.proposedDoctorId ? doctors.find((doctor) => doctor.id === request.proposedDoctorId) : null;
          const role = roles.find((candidate) => candidate.code === request.roleCode);
          return (
            <div className="list-row tall" key={request.id}>
              <span>
                <b>{requestStatusLabel(request.status)}</b> · {request.date} · {role?.name} · {requester?.name ?? "לא ידוע"}
                <small>{proposed ? `מחליף מוצע: ${proposed.name}` : "ללא מחליף מוצע"} · {request.reason || "אין הערה"}</small>
              </span>
              <div className="row-actions">
                {canReview && request.status === "submitted" ? <button onClick={() => approve(request.id)}>אשר</button> : null}
                {canReview && request.status === "submitted" ? <button onClick={() => reject(request.id)}>דחה</button> : null}
                {canApply(request) && (request.status === "approved" || request.status === "senior-confirmed") && schedule.status === "published" ? <button className="primary" onClick={() => applyRequest(request.id)}>החל</button> : null}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function requestStatusLabel(status: ChangeRequest["status"]) {
  const labels: Record<ChangeRequest["status"], string> = {
    submitted: "נשלח",
    "senior-confirmed": "אישור בכיר",
    approved: "אושר",
    rejected: "נדחה",
    applied: "הוחל"
  };
  return labels[status];
}

function Doctors({
  data,
  form,
  setForm,
  userForm,
  setUserForm,
  addDoctor,
  toggleDoctor,
  addUser,
  toggleUser
}: {
  data: WorkspaceData;
  form: { name: string; group: Doctor["group"]; canAngio: boolean };
  setForm: (value: { name: string; group: Doctor["group"]; canAngio: boolean }) => void;
  userForm: { email: string; name: string; role: AppRole; doctorId: string };
  setUserForm: (value: { email: string; name: string; role: AppRole; doctorId: string }) => void;
  addDoctor: () => void;
  toggleDoctor: (doctorId: string) => void;
  addUser: () => void;
  toggleUser: (userId: string) => void;
}) {
  return (
    <section className="panel two">
      <div>
        <h2>רופאים</h2>
        <div className="form-row">
          <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="שם רופא" />
          <select value={form.group} onChange={(event) => setForm({ ...form, group: event.target.value as Doctor["group"] })}><option value="resident">מתמחה</option><option value="senior">בכיר</option></select>
          <label className="check"><input type="checkbox" checked={form.canAngio} onChange={(event) => setForm({ ...form, canAngio: event.target.checked })} />אנגיו</label>
          <button className="primary" onClick={addDoctor}>הוסף</button>
        </div>
        <div className="list">{data.doctors.map((doctor) => <div className="list-row" key={doctor.id}><span>{doctor.name} · {doctor.group === "resident" ? "מתמחה" : "בכיר"} {doctor.canAngio ? "· אנגיו" : ""}</span><button onClick={() => toggleDoctor(doctor.id)}>{doctor.active ? "פעיל" : "לא פעיל"}</button></div>)}</div>
      </div>
      <div>
        <h2>משתמשים והרשאות</h2>
        <div className="form-row stacked">
          <input dir="ltr" value={userForm.email} onChange={(event) => setUserForm({ ...userForm, email: event.target.value })} placeholder="email@hospital.org" />
          <input value={userForm.name} onChange={(event) => setUserForm({ ...userForm, name: event.target.value })} placeholder="שם משתמש" />
          <select value={userForm.role} onChange={(event) => setUserForm({ ...userForm, role: event.target.value as AppRole })}>{Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <select value={userForm.doctorId} onChange={(event) => setUserForm({ ...userForm, doctorId: event.target.value })}><option value="">לא מקושר לרופא</option>{data.doctors.map((doctor) => <option key={doctor.id} value={doctor.id}>{doctor.name}</option>)}</select>
          <button className="primary" onClick={addUser}>הוסף משתמש</button>
        </div>
        <div className="list">{data.users.map((user) => <div className="list-row" key={user.id}><span>{user.name} · <b dir="ltr">{user.email}</b><small>{roleLabels[user.role]} · {data.doctors.find((doctor) => doctor.id === user.doctorId)?.name ?? "לא מקושר"}</small></span><button onClick={() => toggleUser(user.id)}>{user.active ? "פעיל" : "חסום"}</button></div>)}</div>
      </div>
    </section>
  );
}

function Review({ schedule, counts, validateCurrent, publishCurrent, canPublish: publishAllowed, setFocusCell }: { schedule: MonthSchedule; counts: { errors: number; warnings: number }; validateCurrent: () => void; publishCurrent: () => void; canPublish: boolean; setFocusCell: (cell: string) => void }) {
  return (
    <section className="panel">
      <div className="toolbar"><h2>בדיקה ופרסום</h2><div className="actions"><button onClick={validateCurrent}>בדוק עכשיו</button><button className="primary" disabled={!publishAllowed || (counts.errors > 0 && !schedule.validation.stale)} onClick={publishCurrent}>פרסם חודש</button></div></div>
      <div className="status-grid compact"><InfoCell label="שגיאות" value={String(counts.errors)} tone={counts.errors ? "bad" : "good"} /><InfoCell label="אזהרות" value={String(counts.warnings)} tone={counts.warnings ? "warn" : "good"} /><InfoCell label="בדיקה" value={schedule.validation.checkedAt ? new Date(schedule.validation.checkedAt).toLocaleString("he-IL") : "טרם נבדק"} /><InfoCell label="גרסאות פרסום" value={String(schedule.publishSnapshots.length)} /></div>
      <div className="list">{schedule.validation.issues.length === 0 ? <div className="list-row">אין בעיות שמורות.</div> : null}{schedule.validation.issues.map((issue) => <button key={issue.id} className={`issue-row ${issue.severity}`} onClick={() => issue.cellKey && setFocusCell(issue.cellKey)}><span>{issue.severity === "error" ? "שגיאה" : "אזהרה"}</span><b>{issue.message}</b><small>{issue.cellKey ?? ""}</small></button>)}</div>
    </section>
  );
}

function AuditPanel({ entries, full, appUser }: { entries: AuditEntry[]; full: boolean; appUser: AppUser | null }) {
  const visible = full ? entries : entries.filter((entry) => entry.actorUserId === appUser?.id || entry.entityType === "request");
  return (
    <section className="panel">
      <div className="toolbar"><h2>יומן פעולות</h2><span>{visible.length} פעולות</span></div>
      <div className="list audit-list">
        {visible.map((entry) => <div className="list-row audit-row" key={entry.id}><span><b>{entry.action}</b> · {entry.displayTime}<small>{entry.actorName} · {entry.actorEmail} · {entry.entityType} · {entry.scheduleKey ?? ""}</small></span><code>{JSON.stringify({ before: entry.before, after: entry.after }, null, 2)}</code></div>)}
      </div>
    </section>
  );
}

function DrivePanel({
  data,
  clientId,
  setClientId,
  driveFileInput,
  setDriveFileInput,
  busy,
  run,
  setAndPersist,
  actorRole,
  actor
}: {
  data: WorkspaceData;
  clientId: string;
  setClientId: (value: string) => void;
  driveFileInput: string;
  setDriveFileInput: (value: string) => void;
  busy: boolean;
  run: (action: () => Promise<void>, note?: string) => Promise<void>;
  setAndPersist: (data: WorkspaceData) => void;
  actorRole: AppRole | null;
  actor: ActorContext;
}) {
  async function connect() {
    await connectGoogle(clientId);
    saveGoogleClientId(clientId);
  }

  function withDriveMetadata(next: WorkspaceData, metadata: Awaited<ReturnType<typeof getDriveFileMetadata>>) {
    return {
      ...next,
      driveSync: {
        ...next.driveSync,
        fileId: metadata.id,
        fileName: metadata.name,
        fileUrl: metadata.webViewLink ?? next.driveSync.fileUrl,
        lastLoadedModifiedTime: metadata.modifiedTime,
        lastSavedModifiedTime: metadata.modifiedTime,
        lastLoadedVersion: metadata.version ?? null,
        lastSavedVersion: metadata.version ?? null
      }
    };
  }

  return (
    <section className="panel">
      <div className="toolbar"><h2>Google Drive Sync</h2><span>{hasDriveToken() ? "מחובר" : "לא מחובר"}</span></div>
      <div className="drive-grid">
        <label>Google OAuth Client ID<input dir="ltr" value={clientId} onChange={(event) => setClientId(event.target.value)} placeholder="xxx.apps.googleusercontent.com" /></label>
        <button onClick={() => run(connect, "Google מחובר.")} disabled={busy}><Cloud size={17} />התחבר</button>
        <label>Drive file URL / ID<input dir="ltr" value={driveFileInput} onChange={(event) => setDriveFileInput(event.target.value)} placeholder="https://drive.google.com/file/d/..." /></label>
        <button onClick={() => run(async () => { const fileId = extractDriveFileId(driveFileInput); const { data: loaded, metadata } = await loadWorkspaceFromDrive(fileId); setAndPersist(withDriveMetadata(loaded, metadata)); }, "נטען מ-Google Drive.")} disabled={busy}><FolderOpen size={17} />פתח</button>
        <button onClick={() => run(async () => {
          const auditEntry = createAuditEntry(actor, { action: "drive-create-file", entityType: "drive", entityId: "new-drive-file", before: null, after: { fileName: data.driveSync.fileName } });
          const metadata = await createDriveWorkspaceFile({ ...data, auditLog: [auditEntry, ...data.auditLog] });
          setAndPersist(withDriveMetadata({ ...data, auditLog: [auditEntry, ...data.auditLog] }, metadata));
        }, "נוצר קובץ Drive חדש.")} disabled={busy}><FileJson size={17} />צור קובץ</button>
        <button
          className="primary"
          onClick={() => run(async () => {
            if (!data.driveSync.fileId) throw new Error("אין קובץ Drive מחובר.");
            const remote = await getDriveFileMetadata(data.driveSync.fileId);
            const remoteChanged = data.driveSync.lastLoadedModifiedTime && remote.modifiedTime !== data.driveSync.lastLoadedModifiedTime;
            if (remoteChanged) {
              if (actorRole !== "senior-planner") throw new Error("הקובץ ב-Drive השתנה. טען מחדש או בקש מהמתכנן הבכיר להכריע.");
              const overwrite = window.confirm("הקובץ ב-Drive השתנה מאז הטעינה האחרונה. להחליף אותו בכל זאת? מומלץ קודם לייצא גיבוי.");
              if (!overwrite) return;
            }
            const auditEntry = createAuditEntry(actor, { action: remoteChanged ? "drive-force-save" : "drive-save", entityType: "drive", entityId: data.driveSync.fileId, before: { remote }, after: { localUpdatedAt: data.updatedAt } });
            const metadata = await saveWorkspaceToDrive(data.driveSync.fileId, { ...data, auditLog: [auditEntry, ...data.auditLog] });
            setAndPersist(withDriveMetadata({ ...data, auditLog: [auditEntry, ...data.auditLog] }, metadata));
          }, "נשמר ל-Google Drive.")}
          disabled={busy}
        ><Save size={17} />שמור ל-Drive</button>
        <button onClick={() => run(async () => { if (!data.driveSync.fileId) throw new Error("אין קובץ Drive מחובר."); const { data: loaded, metadata } = await loadWorkspaceFromDrive(data.driveSync.fileId); setAndPersist(withDriveMetadata(loaded, metadata)); }, "רוענן מ-Google Drive.")} disabled={busy}><RefreshCw size={17} />טען מ-Drive</button>
      </div>
      <div className="list">
        <div className="list-row"><span>קובץ</span><b dir="ltr">{data.driveSync.fileName}</b></div>
        <div className="list-row"><span>File ID</span><b dir="ltr">{data.driveSync.fileId ?? "לא נוצר"}</b></div>
        <div className="list-row"><span>גרסת Drive</span><b>{data.driveSync.lastLoadedVersion ?? "לא ידוע"}</b></div>
        <div className="list-row"><span>שמירה אחרונה</span><b>{data.driveSync.lastSavedModifiedTime ? new Date(data.driveSync.lastSavedModifiedTime).toLocaleString("he-IL") : "טרם נשמר"}</b></div>
      </div>
    </section>
  );
}

function CalendarPanel({ data, schedule, calendarInput, setCalendarInput, dryRunCalendar, mockCalendarSync }: { data: WorkspaceData; schedule: MonthSchedule; calendarInput: string; setCalendarInput: (value: string) => void; dryRunCalendar: () => void; mockCalendarSync: () => void }) {
  return (
    <section className="panel">
      <div className="toolbar"><h2>יומן Google</h2><span>{schedule.status === "published" ? "מוכן לסנכרון" : "טיוטה לא מסתנכרנת"}</span></div>
      <div className="form-row"><input dir="ltr" value={calendarInput} onChange={(event) => setCalendarInput(event.target.value)} placeholder="Shared Calendar URL or Calendar ID" /><button onClick={dryRunCalendar}>Dry run</button><button className="primary" onClick={mockCalendarSync}>Mock sync</button></div>
      <div className="list"><div className="list-row"><span>Calendar ID</span><b dir="ltr">{normalizeCalendarId(calendarInput) || "לא הוגדר"}</b></div><div className="list-row"><span>אירועים בתצוגה</span><b>{data.calendar.lastDryRun.length}</b></div></div>
      <pre className="codebox">{JSON.stringify(data.calendar.lastDryRun, null, 2)}</pre>
    </section>
  );
}

function SettingsPanel({ data, scheduleKey, importText, setImportText, importJson, exportJson, exportCsv }: { data: WorkspaceData; scheduleKey: string; importText: string; setImportText: (value: string) => void; importJson: () => void; exportJson: () => void; exportCsv: () => void }) {
  return (
    <section className="panel two">
      <div><h2>יבוא / יצוא</h2><textarea value={importText} onChange={(event) => setImportText(event.target.value)} placeholder="הדבק JSON מלא לטעינה" /><div className="actions"><button onClick={importJson}><Upload size={17} />ייבא JSON</button><button onClick={exportJson}><Download size={17} />ייצא JSON</button><button onClick={exportCsv}><Download size={17} />ייצא CSV</button></div></div>
      <div className="list"><div className="list-row"><span>Schema</span><b>{data.schemaVersion}</b></div><div className="list-row"><span>חודש פעיל</span><b>{scheduleKey}</b></div><div className="list-row"><span>עודכן מקומית</span><b>{new Date(data.updatedAt).toLocaleString("he-IL")}</b></div><div className="list-row"><span>Audit entries</span><b>{data.auditLog.length}</b></div></div>
    </section>
  );
}
