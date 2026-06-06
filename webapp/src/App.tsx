import { useEffect, useMemo, useRef, useState, type ElementType } from "react";
import {
  CalendarCheck,
  Check,
  Cloud,
  Download,
  FileJson,
  FileWarning,
  FolderOpen,
  History,
  LocateFixed,
  Mail,
  Moon,
  Plus,
  RefreshCw,
  Save,
  Settings,
  Sun,
  Table2,
  Trash2,
  Upload,
  UserCheck,
  Users,
  X
} from "lucide-react";
import { removeDoctorAndLinkedAccess } from "@/admin";
import { createAuditEntry, isAuditEntryVisibleForSchedule, type ActorContext, type AuditInput } from "@/audit";
import { resolveSession, type SessionUser } from "@/auth";
import { buildCalendarPreview, normalizeCalendarId, normalizeCalendarRecipientEmail } from "@/calendar";
import { cellKey, createId, doctorSortForRole, exclusionRoleCodesForAssignment, exclusionRoles, isDoctorEligibleForRole, isFridayOnlyRole, ROLE_CODES } from "@/domain";
import {
  getWebAppUrl,
  setWebAppUrl,
  hasCredentials,
  hashPassword,
  loginWithCredentials,
  bootstrapPlanner,
  submitRegistrationRequest,
  loadWorkspace,
  saveWorkspace,
  adminSaveUsers,
  clearLocalCredentials,
  getLocalCredentials
} from "@/googleDrive";
import { migrateWorkspace } from "@/migration";
import { buildMonthDays, monthKey, nextDayKey, previousDayKey } from "@/month";
import {
  canApplyRequest,
  canEditDraftRoster,
  canEditOwnRecords,
  canEditRoster,
  canManageUsers,
  canPublish,
  canReviewRequests,
  canSeeSchedule,
  canUsePlannerTools,
  isOwnDoctor
} from "@/permissions";
import { createChangeRequest, nextRequestStatusForDecision } from "@/requests";
import {
  approveRegistrationAsMerge,
  approveRegistrationAsNew,
  findLikelyRegistrationMatches,
  rejectRegistrationRequest
} from "@/registration";
import { buildScheduleView, currentWeekIndexForSchedule, scheduleTodayKey, type ScheduleLens } from "@/scheduleView";
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
  DoctorGroup,
  MonthSchedule,
  PublishedChangeDetails,
  RegistrationRequest,
  Role,
  RoleCode,
  WorkspaceData
} from "@/types";
import { validateSchedule } from "@/validation";
import "./styles.css";

type TabId = "published-roster" | "roster" | "exclusions" | "doctors" | "audit" | "drive" | "calendar" | "settings";
type PublishedChangeMode = "handoff" | "exchange" | "auto-exchange";
type AppliedPublishedChangeMode = Exclude<PublishedChangeMode, "auto-exchange">;
type RegistrationApprovalDraft = {
  mode: "new" | "merge";
  doctorId: string;
  group: DoctorGroup;
  role: AppRole;
  canAngio: boolean;
};
type SyncState = {
  lastSavedAt: string | null;
  lastSaveError: string | null;
  isSavePending: boolean;
  isSaving: boolean;
  dirtySince: string | null;
};

const LAST_SAVED_VERSION_KEY = "department-shift-scheduler.last-saved-version";

const tabs: Array<{ id: TabId; label: string; icon: ElementType; plannerOnly?: boolean; scheduleEditor?: boolean; requestReviewer?: boolean; audit?: boolean; draftPlanner?: boolean }> = [
  { id: "published-roster", label: "לוח תורנויות", icon: Table2, scheduleEditor: true },
  { id: "roster", label: "טיוטת סידור", icon: Table2, draftPlanner: true },
  { id: "exclusions", label: "אילוצים", icon: FileWarning },
  { id: "doctors", label: "רופאים ומשתמשים", icon: Users, plannerOnly: true },
  { id: "audit", label: "יומן פעולות", icon: History, audit: true },
  { id: "drive", label: "חיבור שרת", icon: Cloud, plannerOnly: true },
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

function useMediaQuery(query: string) {
  const getMatches = () => typeof window !== "undefined" && window.matchMedia(query).matches;
  const [matches, setMatches] = useState(getMatches);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);

  return matches;
}

export function App() {
  const [data, setData] = useState<WorkspaceData>(() => loadLocalWorkspace());
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const saved = localStorage.getItem("theme");
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });

  useEffect(() => {
    localStorage.setItem("theme", theme);
    if (theme === "dark") {
      document.body.classList.add("dark");
    } else {
      document.body.classList.remove("dark");
    }
  }, [theme]);

  const [year, setYear] = useState(current.getFullYear());
  const [month, setMonth] = useState(current.getMonth() + 1);
  const [tab, setTab] = useState<TabId>("roster");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [syncState, setSyncState] = useState<SyncState>({
    lastSavedAt: null,
    lastSaveError: null,
    isSavePending: false,
    isSaving: false,
    dirtySince: null
  });
  const [focusCell, setFocusCell] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<SessionUser | null>(() => {
    const creds = getLocalCredentials();
    return creds.username ? { username: creds.username, name: creds.username } : null;
  });
  const [loginUrl, setLoginUrl] = useState(() => getWebAppUrl());
  const [loginUsername, setLoginUsername] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [plannerName, setPlannerName] = useState("");
  const [showBootstrap, setShowBootstrap] = useState(false);
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [showRegistrationModal, setShowRegistrationModal] = useState(false);
  const [registrationForm, setRegistrationForm] = useState({ doctorName: "", gmail: "", username: "", password: "" });
  const [registrationApprovalDrafts, setRegistrationApprovalDrafts] = useState<Record<string, RegistrationApprovalDraft>>({});
  const [calendarInput, setCalendarInput] = useState(data.calendar.calendarInput);
  const [deviceId] = useState(() => loadDeviceId());
  const [doctorForm, setDoctorForm] = useState({ name: "", group: "resident" as Doctor["group"], canAngio: false });
  const [expandedDoctorId, setExpandedDoctorId] = useState<string | null>(null);
  const [doctorUsernameDrafts, setDoctorUsernameDrafts] = useState<Record<string, string>>({});
  const [doctorEmailDrafts, setDoctorEmailDrafts] = useState<Record<string, string>>({});
  const [doctorPasswordDrafts, setDoctorPasswordDrafts] = useState<Record<string, string>>({});
  const [doctorRoleDrafts, setDoctorRoleDrafts] = useState<Record<string, AppRole>>({});
  const [doctorNameDrafts, setDoctorNameDrafts] = useState<Record<string, string>>({});
  const [doctorGroupDrafts, setDoctorGroupDrafts] = useState<Record<string, DoctorGroup>>({});
  const [doctorAngioDrafts, setDoctorAngioDrafts] = useState<Record<string, boolean>>({});
  const [exclusionForm, setExclusionForm] = useState({ doctorId: "", reason: "" });
  const [exclusionRoleCodes, setExclusionRoleCodes] = useState<RoleCode[]>([ROLE_CODES.RESIDENT_ON_CALL]);
  const [requestForm, setRequestForm] = useState({ date: "", roleCode: ROLE_CODES.RESIDENT_ON_CALL as RoleCode, proposedDoctorId: "", reason: "" });
  const [selectedDates, setSelectedDates] = useState<string[]>([]);
  const [importText, setImportText] = useState("");
  const [swapModalCell, setSwapModalCell] = useState<{
    mode: AppliedPublishedChangeMode;
    date: string;
    roleCode: RoleCode;
    giverDoctorId: string;
    sourceDate?: string;
    sourceRoleCode?: RoleCode;
    targetDoctorId?: string;
  } | null>(null);
  const [swapTargetDoctorId, setSwapTargetDoctorId] = useState("");
  const [swapReason, setSwapReason] = useState("");
  const lastSavedVersionRef = useRef<string | null>(localStorage.getItem(LAST_SAVED_VERSION_KEY));
  const latestDataRef = useRef<WorkspaceData>(data);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const key = monthKey(year, month);
  const workspace = useMemo(() => ensureSchedule(data, year, month), [data, year, month]);
  const schedule = workspace.schedules[key];
  const days = useMemo(() => buildMonthDays(year, month), [year, month]);
  const isMobile = useMediaQuery("(max-width: 760px)");
  const session = useMemo(() => resolveSession(workspace, currentUser), [workspace, currentUser]);
  const role = session.role;
  const appUser = session.status === "recognized" ? session.appUser : null;
  const sessionDoctor = session.status === "recognized" ? session.doctor : null;
  const visibleTabs = useMemo(() => tabs.filter((item) => canSeeTab(item, role)), [role]);

  useEffect(() => {
    if (workspace !== data) {
      setAndPersist(workspace);
    }
  }, [workspace, data]);

  useEffect(() => {
    latestDataRef.current = data;
  }, [data]);

  useEffect(() => {
    if (!visibleTabs.some((item) => item.id === tab)) {
      setTab(visibleTabs[0]?.id ?? "roster");
    }
  }, [tab, visibleTabs]);

  useEffect(() => {
    if (tab !== "doctors" || !canManageUsers(role) || !hasCredentials()) return;
    loadWorkspace()
      .then((loaded) => setAndPersist(loaded, true))
      .catch((error) => {
        console.warn("Failed to refresh registration requests", error);
      });
  }, [tab, role]);

  function setAndPersist(next: WorkspaceData, isSavedToServer = false) {
    saveLocalWorkspace(next);
    if (isSavedToServer) {
      lastSavedVersionRef.current = next.updatedAt;
      localStorage.setItem(LAST_SAVED_VERSION_KEY, next.updatedAt);
      setSyncState({
        lastSavedAt: new Date().toISOString(),
        lastSaveError: null,
        isSavePending: false,
        isSaving: false,
        dirtySince: null
      });
    } else if (hasCredentials() && next.updatedAt !== lastSavedVersionRef.current) {
      setSyncState((current) => ({
        ...current,
        lastSaveError: null,
        isSavePending: true,
        dirtySince: current.dirtySince ?? new Date().toISOString()
      }));
    }
    latestDataRef.current = next;
    setData(next);
  }

  function actorFor(next?: WorkspaceData): ActorContext {
    const target = next ?? workspace;
    return {
      googleUser: currentUser ? { email: currentUser.username + "@local", name: currentUser.name } : null,
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

  function rememberServerSave(saved: WorkspaceData, savedVersion: string) {
    lastSavedVersionRef.current = savedVersion;
    localStorage.setItem(LAST_SAVED_VERSION_KEY, savedVersion);
    const hasNewerLocalChanges = latestDataRef.current.updatedAt !== savedVersion;
    if (hasNewerLocalChanges) {
      setSyncState((current) => ({
        ...current,
        lastSavedAt: new Date().toISOString(),
        lastSaveError: null,
        isSaving: false,
        isSavePending: true,
        dirtySince: current.dirtySince ?? new Date().toISOString()
      }));
      return;
    }
    setAndPersist(saved, true);
  }

  async function saveCurrentWorkspaceToServer(options: { checkRemote?: boolean } = {}) {
    if (!hasCredentials()) {
      setSyncState((current) => ({ ...current, isSavePending: false, isSaving: false }));
      return;
    }
    const dataToSave = latestDataRef.current;
    setSyncState((current) => ({ ...current, isSavePending: false, isSaving: true, lastSaveError: null }));
    try {
      if (options.checkRemote) {
        const remote = await loadWorkspace();
        const remoteChanged = Boolean(lastSavedVersionRef.current && remote.updatedAt !== lastSavedVersionRef.current);
        if (remoteChanged) {
          if (role !== "senior-planner") throw new Error("הקובץ בשרת השתנה. טען מחדש או בקש מהמתכנן הבכיר להכריע.");
          const overwrite = window.confirm("הקובץ בשרת השתנה מאז השמירה האחרונה. להחליף אותו בכל זאת? מומלץ קודם לייצא גיבוי.");
          if (!overwrite) {
            setSyncState((current) => ({ ...current, isSaving: false, isSavePending: true }));
            return;
          }
        }
      }
      const saved = await saveWorkspace(dataToSave);
      rememberServerSave(saved, dataToSave.updatedAt);
    } catch (err) {
      setSyncState((current) => ({
        ...current,
        isSaving: false,
        isSavePending: true,
        lastSaveError: err instanceof Error ? err.message : String(err),
        dirtySince: current.dirtySince ?? new Date().toISOString()
      }));
      throw err;
    }
  }

  async function retrySave() {
    try {
      await saveCurrentWorkspaceToServer({ checkRemote: true });
      setMessage("הנתונים נשמרו בהצלחה בשרת.");
    } catch (err) {
      setMessage("שמירה נכשלה: " + (err instanceof Error ? err.message : String(err)));
    }
  }

  async function loadFromServerWithUnsavedCheck() {
    const hasUnsavedLocalChanges = syncState.isSavePending || syncState.isSaving || Boolean(syncState.lastSaveError) || data.updatedAt !== lastSavedVersionRef.current;
    if (hasUnsavedLocalChanges) {
      const confirmed = window.confirm("יש שינויים מקומיים שעדיין לא נשמרו בשרת. טעינה מחדש מהשרת תחליף אותם. להמשיך?");
      if (!confirmed) return;
    }
    await run(async () => {
      const loaded = await loadWorkspace();
      setAndPersist(loaded, true);
    }, "הנתונים רועננו מהשרת.");
  }

  useEffect(() => {
    if (hasCredentials()) {
      run(async () => {
        const remoteData = await loadWorkspace();
        lastSavedVersionRef.current = remoteData.updatedAt;
        localStorage.setItem(LAST_SAVED_VERSION_KEY, remoteData.updatedAt);
        setAndPersist(remoteData, true);
      }, "הנתונים נטענו מחדש מהשרת.");
    }
  }, []);

  // Debounced autosave effect
  useEffect(() => {
    if (!data || !hasCredentials()) return;
    
    if (!lastSavedVersionRef.current) {
      lastSavedVersionRef.current = data.updatedAt;
      localStorage.setItem(LAST_SAVED_VERSION_KEY, data.updatedAt);
      return;
    }
    
    if (data.updatedAt === lastSavedVersionRef.current) return;
    
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    
    saveTimeoutRef.current = setTimeout(async () => {
      try {
        console.log("Autosaving changes to server...");
        await saveCurrentWorkspaceToServer();
      } catch (err) {
        console.error("Autosave failed: ", err);
        setMessage("שמירה אוטומטית נכשלה: " + (err instanceof Error ? err.message : String(err)));
      }
    }, 1500);
    
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [data]);

  useEffect(() => {
    if (currentUser && data) {
      const match = data.users.find((u) => u.active && (u.username ?? "").toLowerCase() === currentUser.username.toLowerCase());
      if (match && match.name !== currentUser.name) {
        setCurrentUser({ username: currentUser.username, name: match.name });
      }
    }
  }, [data, currentUser]);

  async function handleLogin() {
    if (!loginUrl) return setMessage("נא להזין את כתובת השרת.");
    if (!loginUsername) return setMessage("נא להזין שם משתמש.");
    if (!loginPassword) return setMessage("נא להזין סיסמה.");
    
    setBusy(true);
    setMessage("");
    try {
      const passHash = await hashPassword(loginPassword);
      const appUser = await loginWithCredentials(loginUrl, loginUsername, passHash);
      const loaded = await loadWorkspace();
      lastSavedVersionRef.current = loaded.updatedAt;
      localStorage.setItem(LAST_SAVED_VERSION_KEY, loaded.updatedAt);
      setAndPersist(loaded, true);
      setCurrentUser({ username: loginUsername, name: appUser.name });
      setMessage("התחברת בהצלחה!");
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "ההתחברות נכשלה.";
      if (errorMsg.includes("לא נמצא") || errorMsg.includes("שם משתמש או סיסמה") || errorMsg.includes("שגויים")) {
        setMessage(`${errorMsg}. אם זו הפעם הראשונה שאתה מחבר את השרת, לחץ על 'הקמה ראשונית' למטה.`);
      } else {
        setMessage(errorMsg);
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleBootstrap() {
    if (!loginUrl) return setMessage("נא להזין את כתובת השרת.");
    if (!loginUsername) return setMessage("נא להזין שם משתמש מבוקש.");
    if (!loginPassword) return setMessage("נא להזין סיסמה מבוקשת.");
    if (!plannerName) return setMessage("נא להזין את השם המלא שלך.");
    
    setBusy(true);
    setMessage("");
    try {
      const passHash = await hashPassword(loginPassword);
      const result = await bootstrapPlanner(loginUrl, loginUsername, plannerName, passHash);
      lastSavedVersionRef.current = result.data.updatedAt;
      localStorage.setItem(LAST_SAVED_VERSION_KEY, result.data.updatedAt);
      setAndPersist(result.data, true);
      setCurrentUser({ username: loginUsername, name: result.user.name });
      setMessage("המערכת הוקמה בהצלחה! הוגדרת כמתכנן בכיר.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "ההקמה נכשלה.");
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmitRegistrationRequest() {
    if (!loginUrl) return setMessage("נא להזין את כתובת השרת.");
    const doctorName = registrationForm.doctorName.trim();
    const gmail = registrationForm.gmail.trim().toLowerCase();
    const username = registrationForm.username.trim().toLowerCase();
    const password = registrationForm.password.trim();
    if (!doctorName) return setMessage("נא להזין שם רופא.");
    if (!username) return setMessage("נא להזין שם משתמש.");
    if (!password) return setMessage("נא להזין סיסמה.");
    if (gmail && !normalizeCalendarRecipientEmail(gmail)) return setMessage("כתובת Gmail לא תקינה.");

    setBusy(true);
    setMessage("");
    try {
      const passwordHash = await hashPassword(password);
      const result = await submitRegistrationRequest(loginUrl, { doctorName, gmail, username, passwordHash });
      setAndPersist({
        ...data,
        registrationRequests: [
          result.request,
          ...data.registrationRequests.filter((request) => request.id !== result.request.id)
        ],
        updatedAt: new Date().toISOString()
      });
      setRegistrationForm({ doctorName: "", gmail: "", username: "", password: "" });
      setShowRegistrationModal(false);
      setMessage("הבקשה נשלחה למתכנן הבכיר לאישור.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "שליחת הבקשה נכשלה.");
    } finally {
      setBusy(false);
    }
  }

  function handleLogout() {
    clearLocalCredentials();
    setCurrentUser(null);
    setLoginPassword("");
    setMessage("התנתקת בהצלחה.");
  }

  function updateAssignment(date: string, roleCode: RoleCode, value: string) {
    if (!canEditRoster(role, schedule)) {
      setMessage("רק צ׳יף או מתכנן בכיר יכולים לערוך טיוטת שיבוץ.");
      return;
    }
    commitChange({
      mutator: (_draft, currentSchedule) => {
        const assignment: Assignment = value === "__pending" || !value ? { doctorId: null, pending: value === "__pending" } : { doctorId: value, pending: false };
        const keys = linkedAssignmentKeys(date, roleCode);
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

  function autoGenerateRoster() {
    if (!canEditDraftRoster(role)) return setMessage("רק מנהל או צ'יף יכולים לערוך את הסידור.");
    
    const activeDoctors = workspace.doctors.filter(d => d.active);
    if (activeDoctors.length === 0) return setMessage("אין רופאים פעילים במערכת. אנא הוסף או טען רופאים תחילה.");
    
    const priorityRoles = [
      ROLE_CODES.ANGIO,
      ROLE_CODES.SENIOR_A,
      ROLE_CODES.SENIOR_B,
      ROLE_CODES.FRIDAY_MORNING_RESIDENT,
      ROLE_CODES.RESIDENT_ON_CALL,
      ROLE_CODES.HALF_SENIOR,
      ROLE_CODES.HALF_RESIDENT
    ];
    
    const newAssignments: Record<string, Assignment> = {};
    const doctorAssignmentCounts: Record<string, number> = {};
    activeDoctors.forEach(d => { doctorAssignmentCounts[d.id] = 0; });
    
    const roleByCode = new Map(workspace.roles.map(r => [r.code, r]));
    const exclusionsSet = new Set<string>();
    schedule.exclusions.forEach(ex => {
      exclusionsSet.add(`${ex.date}|${ex.roleCode ?? "*"}|${ex.doctorId}`);
    });
    
    function isAssignedOnDate(doctorId: string, dateStr: string) {
      return Object.entries(newAssignments).some(([key, assignment]) => key.startsWith(`${dateStr}|`) && assignment.doctorId === doctorId);
    }
    
    function getAssignedDoctor(dateStr: string, roleCode: RoleCode) {
      const key = cellKey(dateStr, roleCode);
      return newAssignments[key]?.doctorId || null;
    }
    
    for (let dayIndex = 0; dayIndex < days.length; dayIndex++) {
      const day = days[dayIndex];
      const dateStr = day.key;
      const weekday = new Date(`${dateStr}T00:00:00.000Z`).getUTCDay();
      
      for (const roleCode of priorityRoles) {
        const role = roleByCode.get(roleCode);
        if (!role) continue;
        
        if (isFridayOnlyRole(roleCode) && !day.allowsFridayRoles) continue;
        
        // Rule: Saturday half-senior must match Friday senior-a
        if (roleCode === ROLE_CODES.HALF_SENIOR && weekday === 6) {
          const prevFriday = previousDayKey(dateStr);
          const fridaySeniorA = getAssignedDoctor(prevFriday, ROLE_CODES.SENIOR_A);
          if (fridaySeniorA) {
            const isExcluded = isDoctorExcluded(exclusionsSet, dateStr, roleCode, fridaySeniorA);
            const alreadyAssigned = isAssignedOnDate(fridaySeniorA, dateStr);
            if (!isExcluded && !alreadyAssigned) {
              newAssignments[cellKey(dateStr, roleCode)] = { doctorId: fridaySeniorA, pending: false };
              doctorAssignmentCounts[fridaySeniorA]++;
              continue;
            }
          }
        }
        
        // Find eligible doctors
        let candidates = activeDoctors.filter(doc => {
          if (!isDoctorEligibleForRole(doc, role)) return false;
          if (isDoctorExcluded(exclusionsSet, dateStr, roleCode, doc.id)) return false;
          if (isAssignedOnDate(doc.id, dateStr)) return false;
          
          const prevDate = previousDayKey(dateStr);
          const prevAssignment = newAssignments[cellKey(prevDate, roleCode)];
          if (prevAssignment?.doctorId === doc.id) {
            if (roleCode === ROLE_CODES.RESIDENT_ON_CALL || roleCode === ROLE_CODES.HALF_SENIOR) return false;
          }
          
          if (roleCode === ROLE_CODES.SENIOR_A && weekday === 5) {
            const nextSaturday = nextDayKey(dateStr);
            const satExcluded = isDoctorExcluded(exclusionsSet, nextSaturday, ROLE_CODES.HALF_SENIOR, doc.id);
            if (satExcluded) return false;
          }
          
          return true;
        });
        
        if (candidates.length === 0) {
          candidates = activeDoctors.filter(doc => {
            if (!isDoctorEligibleForRole(doc, role)) return false;
            if (isDoctorExcluded(exclusionsSet, dateStr, roleCode, doc.id)) return false;
            if (isAssignedOnDate(doc.id, dateStr)) return false;
            return true;
          });
        }
        
        if (candidates.length > 0) {
          candidates.sort((a, b) => {
            const countA = doctorAssignmentCounts[a.id];
            const countB = doctorAssignmentCounts[b.id];
            if (countA !== countB) return countA - countB;
            return Math.random() - 0.5;
          });
          
          const chosen = candidates[0];
          newAssignments[cellKey(dateStr, roleCode)] = { doctorId: chosen.id, pending: false };
          doctorAssignmentCounts[chosen.id]++;
          
          if (roleCode === ROLE_CODES.SENIOR_A && weekday === 5) {
            const nextSaturday = nextDayKey(dateStr);
            newAssignments[cellKey(dateStr, ROLE_CODES.FRIDAY_MORNING_SENIOR)] = { doctorId: chosen.id, pending: false };
            newAssignments[cellKey(nextSaturday, ROLE_CODES.HALF_SENIOR)] = { doctorId: chosen.id, pending: false };
            doctorAssignmentCounts[chosen.id]++;
          }
        }
      }
    }
    
    commitChange({
      mutator: (draft, currentSchedule) => {
        const before = { ...currentSchedule.assignments };
        currentSchedule.assignments = newAssignments;
        currentSchedule.validation.stale = true;
        return {
          action: "schedule-generate-auto",
          entityType: "schedule",
          entityId: currentSchedule.key,
          before,
          after: newAssignments
        };
      },
      note: "השיבוץ האוטומטי הושלם בהצלחה!"
    });
  }

  async function loadTestData() {
    if (!canManageUsers(role)) return setMessage("רק מתכנן בכיר יכול לטעון נתוני בדיקה.");
    try {
      const testDoctors: Doctor[] = [
        { id: "doc-res-1", name: 'ד"ר מיכל כהן', group: "resident", canAngio: false, active: true },
        { id: "doc-res-2", name: 'ד"ר דוד לוי', group: "resident", canAngio: false, active: true },
        { id: "doc-res-3", name: 'ד"ר שירה מזרחי', group: "resident", canAngio: false, active: true },
        { id: "doc-res-4", name: 'ד"ר יוסף פרץ', group: "resident", canAngio: false, active: true },
        { id: "doc-res-5", name: 'ד"ר רחל ביטון', group: "resident", canAngio: false, active: true },
        { id: "doc-res-6", name: 'ד"ר משה דהן', group: "resident", canAngio: false, active: true },
        { id: "doc-res-7", name: 'ד"ר אסתר אברהם', group: "resident", canAngio: false, active: true },
        { id: "doc-res-8", name: 'ד"ר חיים אזולאי', group: "resident", canAngio: false, active: true },
        { id: "doc-res-9", name: 'ד"ר חנה חסן', group: "resident", canAngio: false, active: true },
        { id: "doc-res-10", name: 'ד"ר שמעון עמר', group: "resident", canAngio: false, active: true },
        
        { id: "doc-sen-1", name: 'ד"ר אהרן אבני', group: "senior", canAngio: true, active: true },
        { id: "doc-sen-2", name: 'ד"ר ברק גונן', group: "senior", canAngio: true, active: true },
        { id: "doc-sen-3", name: 'ד"ר שרה רוזן', group: "senior", canAngio: false, active: true },
        { id: "doc-sen-4", name: 'ד"ר דניאל שמידט', group: "senior", canAngio: true, active: true },
        { id: "doc-sen-5", name: 'ד"ר לאה קליין', group: "senior", canAngio: false, active: true },
        { id: "doc-sen-6", name: 'ד"ר גבריאל מילר', group: "senior", canAngio: true, active: true },
        { id: "doc-sen-7", name: 'ד"ר מרים גולדשטיין', group: "senior", canAngio: false, active: true },
        { id: "doc-sen-8", name: 'ד"ר אליעזר כץ', group: "senior", canAngio: false, active: true },
        { id: "doc-sen-9", name: 'ד"ר רות פרידמן', group: "senior", canAngio: false, active: true },
        { id: "doc-sen-10", name: 'ד"ר שמואל לוין', group: "senior", canAngio: false, active: true }
      ];

      const hash = await hashPassword("203-mais");
      const nextUsers = [...workspace.users];
      
      const cleanUsers = nextUsers.filter((u) => (u.username ?? u.email.split("@")[0]) !== "mais");
      cleanUsers.push({
        id: "user-mais",
        username: "mais",
        email: "mais@local",
        name: "מאיס",
        role: "senior-planner",
        doctorId: null,
        active: true,
        createdAt: new Date().toISOString(),
        passwordHash: hash
      });

      commitChange({
        mutator: (draft) => {
          const before = { doctors: draft.doctors, users: draft.users };
          draft.doctors = testDoctors;
          draft.users = cleanUsers;
          return {
            action: "test-data-load",
            entityType: "settings",
            entityId: "test-data",
            before,
            after: { doctors: draft.doctors, users: draft.users }
          };
        },
        note: "20 רופאי בדיקה והמשתמש mais (סיסמה: 203-mais) נטענו מקומית ויישמרו ברקע."
      });
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "טעינת נתוני בדיקה נכשלה.");
    }
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
    const roleCodes = Array.from(new Set(exclusionRoleCodes.filter(Boolean)));
    if (!doctorId || !selectedDates.length || !roleCodes.length) return setMessage("צריך לבחור רופא, תאריך ותפקיד אחד לפחות.");
    if (!canUsePlannerTools(role) && !isOwnDoctor(appUser, sessionDoctor, doctorId)) return setMessage("אפשר לערוך רק אילוצים שלך.");
    commitChange({
      mutator: (_draft, currentSchedule) => {
        const created = selectedDates.flatMap((date) =>
          roleCodes.map((roleCode) => ({
            id: createId("exclusion"),
            doctorId,
            date,
            roleCode,
            reason: exclusionForm.reason,
            createdBy: appUser.id,
            createdAt: new Date().toISOString()
          }))
        );
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
    setExclusionForm({ doctorId: canUsePlannerTools(role) ? "" : doctorId, reason: "" });
    setExclusionRoleCodes([ROLE_CODES.RESIDENT_ON_CALL]);
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

  async function saveDoctorUser(doctorId: string) {
    if (!canManageUsers(role)) return setMessage("רק מתכנן בכיר יכול לנהל משתמשים.");
    const doctor = workspace.doctors.find((candidate) => candidate.id === doctorId);
    if (!doctor) return setMessage("הרופא לא נמצא.");
    
    const newName = (doctorNameDrafts[doctorId] ?? doctor.name).trim();
    if (!newName) return setMessage("שם הרופא לא יכול להיות ריק.");
    const newGroup = doctorGroupDrafts[doctorId] ?? doctor.group;
    const newCanAngio = doctorAngioDrafts[doctorId] ?? doctor.canAngio;
    
    const existing = workspace.users.find((user) => user.doctorId === doctorId);
    const username = (doctorUsernameDrafts[doctorId] ?? existing?.username ?? "").trim().toLowerCase();
    const calendarEmailInput = (doctorEmailDrafts[doctorId] ?? existing?.email ?? "").trim().toLowerCase();
    const password = (doctorPasswordDrafts[doctorId] ?? "").trim();
    const appRole = doctorRoleDrafts[doctorId] ?? (newGroup === "senior" ? "senior" : "resident");
    if (!username && !existing) return setMessage("צריך להזין שם משתמש לרופא.");
    if (!existing && !password) return setMessage("צריך להזין סיסמה ראשונית למשתמש חדש.");
    
    if (calendarEmailInput && !normalizeCalendarRecipientEmail(calendarEmailInput)) return setMessage("Invalid Gmail address for calendar invitations.");

    let passwordHash = existing?.passwordHash || "";
    if (password) {
      passwordHash = await hashPassword(password);
    }
    
    const calendarEmail = normalizeCalendarRecipientEmail(calendarEmailInput) || `${username || existing?.username || newName}@local`;
    commitChange({
      mutator: (draft) => {
        const before = {
          doctor: draft.doctors.find((d) => d.id === doctorId) ?? null,
          user: draft.users.find((u) => u.doctorId === doctorId) ?? null
        };
        const docIndex = draft.doctors.findIndex((d) => d.id === doctorId);
        if (docIndex !== -1) {
          draft.doctors[docIndex] = {
            ...draft.doctors[docIndex],
            name: newName,
            group: newGroup,
            canAngio: newCanAngio
          };
        }

        const matchIndex = draft.users.findIndex((u) => u.doctorId === doctorId);
        if (matchIndex !== -1) {
          draft.users[matchIndex] = {
            ...draft.users[matchIndex],
            username,
            email: calendarEmail,
            name: newName,
            role: appRole,
            active: true,
            passwordHash
          };
        } else {
          draft.users.push({
            id: createId("user"),
            username,
            email: calendarEmail,
            name: newName,
            role: appRole,
            doctorId,
            active: true,
            createdAt: new Date().toISOString(),
            passwordHash
          });
        }
        return {
          action: "doctor-user-update",
          entityType: "doctor",
          entityId: doctorId,
          before,
          after: {
            doctor: draft.doctors.find((d) => d.id === doctorId) ?? null,
            user: draft.users.find((u) => u.doctorId === doctorId) ?? null
          }
        };
      },
      note: "פרטי הרופא והמשתמש עודכנו מקומית ויישמרו ברקע."
    });
    try {
      const saved = await adminSaveUsers(latestDataRef.current.users, latestDataRef.current.doctors, latestDataRef.current.registrationRequests);
      setAndPersist(saved, true);
    } catch (err) {
      setMessage("שמירת פרטי המשתמש לשרת נכשלה: " + (err instanceof Error ? err.message : String(err)));
    }
    setDoctorPasswordDrafts(prev => ({ ...prev, [doctorId]: "" }));
  }

  async function approvePendingRegistration(requestId: string) {
    if (!canManageUsers(role)) return setMessage("רק מתכנן בכיר יכול לאשר בקשות משתמש.");
    const request = workspace.registrationRequests.find((item) => item.id === requestId);
    if (!request) return setMessage("הבקשה לא נמצאה.");
    const draft = registrationApprovalDrafts[requestId] ?? defaultRegistrationApprovalDraft(workspace, request);
    try {
      const next = draft.mode === "merge"
        ? approveRegistrationAsMerge(workspace, { requestId, doctorId: draft.doctorId, decidedByUserId: appUser?.id ?? null })
        : approveRegistrationAsNew(workspace, { requestId, group: draft.group, role: draft.role, canAngio: draft.canAngio, decidedByUserId: appUser?.id ?? null });
      const saved = await adminSaveUsers(next.users, next.doctors, next.registrationRequests);
      setAndPersist(saved, true);
      setRegistrationApprovalDrafts(({ [requestId]: _removed, ...rest }) => rest);
      setMessage(draft.mode === "merge" ? "הבקשה אושרה והסיסמה עודכנה למשתמש הקיים." : "הבקשה אושרה ונוצר משתמש חדש.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "אישור הבקשה נכשל.");
    }
  }

  async function rejectPendingRegistration(requestId: string) {
    if (!canManageUsers(role)) return setMessage("רק מתכנן בכיר יכול לדחות בקשות משתמש.");
    try {
      const next = rejectRegistrationRequest(workspace, requestId, appUser?.id ?? null);
      const saved = await adminSaveUsers(next.users, next.doctors, next.registrationRequests);
      setAndPersist(saved, true);
      setRegistrationApprovalDrafts(({ [requestId]: _removed, ...rest }) => rest);
      setMessage("הבקשה נדחתה.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "דחיית הבקשה נכשלה.");
    }
  }

  async function removeDoctor(doctorId: string) {
    if (!canManageUsers(role)) return setMessage("רק מתכנן בכיר יכול לנהל רופאים.");
    const doctor = workspace.doctors.find((candidate) => candidate.id === doctorId);
    if (!doctor) return;
    const confirmed = window.confirm(`להסיר את ${doctor.name}? השיבוצים והאילוצים שלו יימחקו מהנתונים המקומיים.`);
    if (!confirmed) return;
    const draft = ensureSchedule(cloneWorkspace(data), year, month);
    const audit = removeDoctorAndLinkedAccess(draft, doctorId);
    draft.updatedAt = new Date().toISOString();
    if (audit) draft.auditLog.unshift(createAuditEntry(actorFor(draft), audit));
    setAndPersist(draft);
    setMessage("הרופא והגישה של המשתמש המקושר הוסרו.");
    setExpandedDoctorId((current) => (current === doctorId ? null : current));
    if (!hasCredentials()) return;
    try {
      await saveWorkspace(draft);
      const saved = await adminSaveUsers(draft.users, draft.doctors, draft.registrationRequests);
      setAndPersist(saved, true);
    } catch (err) {
      setMessage("שמירת הסרת הגישה בשרת נכשלה: " + (err instanceof Error ? err.message : String(err)));
    }
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
          if (!event.attendeeEmails.length) return;
          draft.calendar.syncRecords[event.assignmentKey] = {
            assignmentKey: event.assignmentKey,
            eventId: event.eventId,
            hash: event.hash,
            lastSyncedAt: new Date().toISOString(),
            attendeeEmails: event.attendeeEmails
          };
        });
        currentSchedule.lastSyncedAt = new Date().toISOString();
        return { action: "calendar-mock-sync", entityType: "calendar", entityId: "calendar", scheduleKey: currentSchedule.key, before, after: { calendar: draft.calendar, lastSyncedAt: currentSchedule.lastSyncedAt } };
      },
      note: "סנכרון יומן מדומה נרשם."
    });
  }

  async function handleExecuteSwap(input: typeof swapModalCell = swapModalCell, reasonOverride = swapReason) {
    if (!input) return;
    const { mode, date, roleCode, giverDoctorId, sourceDate, sourceRoleCode, targetDoctorId } = input;
    const targetKey = cellKey(date, roleCode);
    const sourceKey = sourceDate && sourceRoleCode ? cellKey(sourceDate, sourceRoleCode) : targetKey;
    const isExchange = mode === "exchange";
    const targetBeforeDoctorId = schedule.assignments[targetKey]?.doctorId ?? null;
    const sourceDoctor = workspace.doctors.find(d => d.id === giverDoctorId);
    const selectedDoctorId = isExchange ? giverDoctorId : swapTargetDoctorId;
    const selectedDoctor = selectedDoctorId ? workspace.doctors.find(d => d.id === selectedDoctorId) : null;
    const targetAfterDoctor = isExchange ? sourceDoctor ?? null : selectedDoctor ?? null;
    if (!sourceDoctor || !targetAfterDoctor) return;

    const user = requireUser();
    const isDirect = role === "senior-planner" || (role === "senior" && sourceDoctor.group === "senior");
    const changeCode = createChangeCode();
    const details: PublishedChangeDetails = {
      kind: mode,
      code: changeCode,
      reason: reasonOverride,
      status: isDirect ? "direct" : "requested",
      source: {
        date: isExchange ? sourceDate ?? date : date,
        roleCode: isExchange ? sourceRoleCode ?? roleCode : roleCode,
        doctorId: giverDoctorId
      },
      target: {
        date,
        roleCode,
        doctorId: targetBeforeDoctorId
      },
      result: {
        sourceDoctorId: isExchange ? targetDoctorId ?? null : null,
        targetDoctorId: targetAfterDoctor.id
      }
    };

    if (isDirect) {
      setMessage(mode === "exchange" ? "מבצע החלפה ומתעד ביומן..." : "מבצע מסירה ומתעד ביומן...");
      try {
        commitChange({
          mutator: (_draft, currentSchedule) => {
            const cellKeyStr = targetKey;
            const before = {
              assignment: currentSchedule.assignments[cellKeyStr] ?? null,
              sourceAssignment: isExchange ? currentSchedule.assignments[sourceKey] ?? null : undefined,
              changeCode,
              changeDetails: details
            };
            currentSchedule.assignments[cellKeyStr] = { doctorId: targetAfterDoctor.id, pending: false };
            if (isExchange) {
              currentSchedule.assignments[sourceKey] = targetDoctorId ? { doctorId: targetDoctorId, pending: false } : { doctorId: null, pending: false };
            }
            currentSchedule.validation.stale = true;

            const auditEntryInput: AuditInput = {
              action: "published-swap-direct",
              entityType: "assignment",
              entityId: cellKeyStr,
              scheduleKey: currentSchedule.key,
              date,
              roleCode,
              before,
              after: {
                assignment: currentSchedule.assignments[cellKeyStr],
                sourceAssignment: isExchange ? currentSchedule.assignments[sourceKey] : undefined,
                changeCode,
                changeDetails: details
              },
              changeCode,
              changeKind: mode,
              changeDetails: details
            };

            return auditEntryInput;
          },
          note: `${mode === "exchange" ? "ההחלפה" : "המסירה"} בוצעה בהצלחה ותועדה ביומן הפעולות.`
        });

      } catch (err) {
        setMessage("שגיאה בביצוע השינוי: " + (err instanceof Error ? err.message : String(err)));
      } finally {
        setSwapModalCell(null);
        setSwapTargetDoctorId("");
        setSwapReason("");
      }
    } else {
      commitChange({
        mutator: (_draft, currentSchedule) => {
          const request = createChangeRequest({
            schedule: currentSchedule,
            requesterUser: user,
            date,
            roleCode,
            proposedDoctorId: targetAfterDoctor.id,
            reason: reasonOverride
          });
          request.currentDoctorId = targetBeforeDoctorId;
          request.changeKind = mode;
          request.sourceDate = details.source.date;
          request.sourceRoleCode = details.source.roleCode;
          request.sourceDoctorId = details.source.doctorId;
          request.changeCode = changeCode;
          _draft.changeRequests.unshift(request);
          return {
            action: "request-create-published-swap",
            entityType: "request",
            entityId: request.id,
            scheduleKey: currentSchedule.key,
            date,
            roleCode,
            before: null,
            after: {
              request,
              sourceAssignment: isExchange ? currentSchedule.assignments[sourceKey] ?? null : undefined,
              changeCode,
              changeDetails: details
            },
            changeCode,
            changeKind: mode,
            changeDetails: details
          };
        },
        note: `${mode === "exchange" ? "בקשת החלפה" : "בקשת מסירה"} נשלחה לאישור הצ'יף.`
      });
      setSwapModalCell(null);
      setSwapTargetDoctorId("");
      setSwapReason("");
    }
  }

  async function handleApproveRequest(requestId: string, resolutionNote: string) {
    const request = data.changeRequests.find(r => r.id === requestId);
    if (!request) return;

    const changeKind = request.changeKind ?? "handoff";
    const sourceDoctorId = request.sourceDoctorId ?? request.requesterDoctorId;
    const targetDoctorId = request.currentDoctorId;
    const receiverDoctor = request.proposedDoctorId ? workspace.doctors.find(d => d.id === request.proposedDoctorId) : null;
    if (!receiverDoctor || (changeKind === "exchange" && !targetDoctorId)) {
      setMessage("לא נמצאו הרופאים המתאימים לבקשה זו.");
      return;
    }

    setMessage("מאשר שינוי ומתעד ביומן...");
    const changeCode = request.changeCode ?? createChangeCode();
    const details: PublishedChangeDetails = {
      kind: changeKind,
      code: changeCode,
      reason: request.reason,
      status: "approved",
      source: {
        date: request.sourceDate ?? request.date,
        roleCode: request.sourceRoleCode ?? request.roleCode,
        doctorId: sourceDoctorId
      },
      target: {
        date: request.date,
        roleCode: request.roleCode,
        doctorId: targetDoctorId
      },
      result: {
        sourceDoctorId: changeKind === "exchange" ? targetDoctorId : null,
        targetDoctorId: request.proposedDoctorId
      }
    };

    try {
      commitChange({
        mutator: (draft) => {
          const targetRequest = draft.changeRequests.find(r => r.id === requestId);
          const targetSchedule = targetRequest ? draft.schedules[targetRequest.scheduleKey] : null;
          if (!targetRequest || !targetSchedule) return;

          const cellKeyStr = cellKey(targetRequest.date, targetRequest.roleCode);
          const sourceKey = targetRequest.sourceDate && targetRequest.sourceRoleCode ? cellKey(targetRequest.sourceDate, targetRequest.sourceRoleCode) : cellKeyStr;
          const before = {
            request: { ...targetRequest },
            assignment: targetSchedule.assignments[cellKeyStr] ?? null,
            sourceAssignment: changeKind === "exchange" ? targetSchedule.assignments[sourceKey] ?? null : undefined,
            changeCode,
            changeDetails: details
          };

          targetSchedule.assignments[cellKeyStr] = { doctorId: targetRequest.proposedDoctorId, pending: false };
          if (changeKind === "exchange") {
            targetSchedule.assignments[sourceKey] = targetRequest.currentDoctorId ? { doctorId: targetRequest.currentDoctorId, pending: false } : { doctorId: null, pending: false };
          }
          targetSchedule.validation.stale = true;

          targetRequest.status = "applied";
          targetRequest.resolutionNote = resolutionNote || "אושר ע\"י צ'יף";
          targetRequest.appliedAt = new Date().toISOString();
          targetRequest.appliedByUserId = appUser?.id ?? null;
          targetRequest.updatedAt = targetRequest.appliedAt;

          const auditEntryInput: AuditInput = {
            action: "published-swap-approved",
            entityType: "request",
            entityId: targetRequest.id,
            scheduleKey: targetRequest.scheduleKey,
            date: targetRequest.date,
            roleCode: targetRequest.roleCode,
            before,
            after: {
              request: targetRequest,
              assignment: targetSchedule.assignments[cellKeyStr],
              sourceAssignment: changeKind === "exchange" ? targetSchedule.assignments[sourceKey] : undefined,
              changeCode,
              changeDetails: details
            },
            changeCode,
            changeKind,
            changeDetails: details
          };

          return auditEntryInput;
        },
        note: "הבקשה אושרה והוחלה על השיבוץ."
      });

    } catch (err) {
      setMessage("שגיאה באישור הבקשה: " + (err instanceof Error ? err.message : String(err)));
    }
  }

  function handleRejectRequest(requestId: string) {
    if (!canReviewRequests(role)) return setMessage("אין הרשאה לטפל בבקשות.");
    commitChange({
      mutator: (draft) => {
        const request = draft.changeRequests.find(r => r.id === requestId);
        if (!request) return;
        const before = { ...request };
        request.status = "rejected";
        request.decidedAt = new Date().toISOString();
        request.decidedByUserId = appUser?.id ?? null;
        request.resolutionNote = "נדחה";
        request.updatedAt = request.decidedAt;
        return {
          action: "published-swap-rejected",
          entityType: "request",
          entityId: request.id,
          scheduleKey: request.scheduleKey,
          date: request.date,
          roleCode: request.roleCode,
          before,
          after: request
        };
      },
      note: "הבקשה נדחתה."
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
  const visibleExclusions = useMemo(() => {
    if (canUsePlannerTools(role)) return schedule.exclusions;
    if (!sessionDoctor) return schedule.exclusions.filter((item) => item.doctorId === ownDoctorId);
    const visibleDoctorIds = new Set(workspace.doctors.filter((doctor) => doctor.group === sessionDoctor.group).map((doctor) => doctor.id));
    return schedule.exclusions.filter((item) => visibleDoctorIds.has(item.doctorId));
  }, [ownDoctorId, role, schedule.exclusions, sessionDoctor, workspace.doctors]);

  if (!currentUser) {
    return (
      <main className="shell">
        <header className="topbar">
          <div>
            <h1>{workspace.workspace.name}</h1>
            <p>חיבור למערכת סידור תורנויות מחלקתי</p>
          </div>
          <button
            type="button"
            className="theme-toggle-btn"
            onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
            aria-label="Toggle theme"
          >
            {theme === "light" ? <Moon size={18} /> : <Sun size={18} />}
          </button>
        </header>
        
        <section className="panel" style={{ maxWidth: "450px", margin: "40px auto", padding: "24px" }}>
          <h2 style={{ marginBottom: "16px", textAlign: "center" }}>התחברות למערכת</h2>
          {message ? <div className="notice" style={{ marginBottom: "16px" }}>{message}</div> : null}
          
          <form onSubmit={(e) => { e.preventDefault(); handleLogin(); }} className="drive-grid" style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            {(showUrlInput || !loginUrl) && (
              <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                כתובת שרת Apps Script
                <input dir="ltr" value={loginUrl} onChange={(e) => setLoginUrl(e.target.value)} placeholder="https://script.google.com/macros/s/..." />
              </label>
            )}
            
            {!showBootstrap ? (
              <>
                <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                  שם משתמש
                  <input dir="ltr" value={loginUsername} onChange={(e) => setLoginUsername(e.target.value)} placeholder="Username" />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                  סיסמה
                  <input type="password" dir="ltr" value={loginPassword} onChange={(e) => setLoginPassword(e.target.value)} placeholder="Password" />
                </label>
                <button type="submit" className="primary" disabled={busy} style={{ alignSelf: "center", width: "100%", padding: "10px", marginTop: "8px" }}>
                  {busy ? "מתחבר..." : "התחבר"}
                </button>
                <button type="button" disabled={busy} onClick={() => { setShowRegistrationModal(true); setMessage(""); }} style={{ alignSelf: "center", width: "100%", padding: "10px" }}>
                  משתמש חדש
                </button>
                <div style={{ textAlign: "center", marginTop: "12px" }}>
                  <a href="#" onClick={(e) => { e.preventDefault(); setShowBootstrap(true); setMessage(""); }} style={{ fontSize: "12px", color: "var(--color-primary-blue, #2563eb)" }}>
                    הקמה ראשונית של המערכת (התקנה חדשה)
                  </a>
                </div>
              </>
            ) : (
              <>
                <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                  שם משתמש מבוקש למנהל
                  <input dir="ltr" value={loginUsername} onChange={(e) => setLoginUsername(e.target.value)} placeholder="לדוגמה: admin" />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                  שם מלא של המנהל
                  <input value={plannerName} onChange={(e) => setPlannerName(e.target.value)} placeholder="שם מלא" />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                  סיסמה מבוקשת למנהל
                  <input type="password" dir="ltr" value={loginPassword} onChange={(e) => setLoginPassword(e.target.value)} placeholder="סיסמה" />
                </label>
                <button type="button" onClick={handleBootstrap} className="primary" disabled={busy} style={{ alignSelf: "center", width: "100%", padding: "10px", marginTop: "8px" }}>
                  {busy ? "מקים מערכת..." : "בצע הקמה ראשונית"}
                </button>
                <div style={{ textAlign: "center", marginTop: "12px" }}>
                  <a href="#" onClick={(e) => { e.preventDefault(); setShowBootstrap(false); setMessage(""); }} style={{ fontSize: "12px", color: "var(--color-primary-blue, #2563eb)" }}>
                    חזור למסך התחברות רגיל
                  </a>
                </div>
              </>
            )}
            
            <div style={{ textAlign: "center", marginTop: "12px", borderTop: "1px solid var(--line, #d8dfeb)", paddingTop: "12px" }}>
              <a href="#" onClick={(e) => { e.preventDefault(); setShowUrlInput(!showUrlInput); }} style={{ fontSize: "12px", color: "var(--muted, #64748b)" }}>
                {showUrlInput ? "הסתר הגדרות שרת" : "הגדרות שרת (מתקדם)"}
              </a>
            </div>
          </form>
        </section>
        {showRegistrationModal ? (
          <div className="modal-overlay registration-modal-overlay" onClick={() => setShowRegistrationModal(false)}>
            <section className="modal-panel registration-modal-panel" onClick={(event) => event.stopPropagation()}>
              <header className="day-schedule-modal-header">
                <div><h3>בקשת משתמש חדש</h3></div>
                <button type="button" className="icon-button" onClick={() => setShowRegistrationModal(false)} aria-label="סגור"><X size={16} /></button>
              </header>
              <div className="drive-grid" style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>שם רופא בעברית
                  <input value={registrationForm.doctorName} onChange={(event) => setRegistrationForm({ ...registrationForm, doctorName: event.target.value })} placeholder="ד״ר ישראל ישראלי" />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>Gmail לאירועי יומן
                  <input dir="ltr" value={registrationForm.gmail} onChange={(event) => setRegistrationForm({ ...registrationForm, gmail: event.target.value })} placeholder="doctor@gmail.com" />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>שם משתמש
                  <input dir="ltr" value={registrationForm.username} onChange={(event) => setRegistrationForm({ ...registrationForm, username: event.target.value })} placeholder="username" />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>סיסמה
                  <input type="password" dir="ltr" value={registrationForm.password} onChange={(event) => setRegistrationForm({ ...registrationForm, password: event.target.value })} placeholder="password" />
                </label>
                <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end", marginTop: "8px" }}>
                  <button type="button" onClick={() => setShowRegistrationModal(false)}>ביטול</button>
                  <button type="button" className="primary" disabled={busy} onClick={handleSubmitRegistrationRequest}>{busy ? "שולח..." : "שלח בקשה"}</button>
                </div>
              </div>
            </section>
          </div>
        ) : null}
      </main>
    );
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <h1>{workspace.workspace.name}</h1>
          <p>סידור תורנויות מחלקתי · RTL Roster Portal</p>
        </div>
        <div className="month-controls">
          <button
            type="button"
            className="theme-toggle-btn"
            onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
            aria-label="Toggle theme"
          >
            {theme === "light" ? <Moon size={18} /> : <Sun size={18} />}
          </button>
          <input type="number" value={month} min={1} max={12} onChange={(event) => setMonth(Number(event.target.value))} />
          <input type="number" value={year} min={2020} max={2100} onChange={(event) => setYear(Number(event.target.value))} />
          <span className={`status ${schedule.status}`}>{schedule.status === "published" ? "נעול" : "טיוטה"}</span>
          <SyncStatus state={syncState} connected={hasCredentials()} onRetry={retrySave} />
        </div>
      </header>

      <section className="login-strip">
        <div>
          <strong>מחובר כ-{currentUser.name}</strong>
          <span>שם משתמש: {currentUser.username}</span>
        </div>
        {role ? <b>{roleLabels[role]}</b> : null}
        <button className="danger" onClick={handleLogout}><Mail size={17} />התנתק</button>
      </section>

      {session.status === "blocked" ? <BlockedUser email={currentUser.username} recover={() => setMessage("פנה למנהל המערכת כדי לקבל הרשאות מתאימות.")} /> : null}
      {message ? <div className="notice">{message}</div> : null}

      {role ? (
        <>
          <nav className="tabs mobile-bottom-tabs">
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

          {tab === "published-roster" && (
            canSeeSchedule(role, schedule) ? (
              <PublishedRoster
                schedule={schedule}
                roles={workspace.roles}
                doctors={workspace.doctors}
                days={days}
                role={role}
                appUser={appUser}
                currentUser={currentUser}
                isMobile={isMobile}
                changeRequests={workspace.changeRequests}
                onSwapCellClick={(mode, date, roleCode, giverDoctorId, targetDoctorId, sourceDate, sourceRoleCode) => {
                  setSwapModalCell({ mode, date, roleCode, giverDoctorId, targetDoctorId, sourceDate, sourceRoleCode });
                  if (mode === "exchange") setSwapTargetDoctorId(giverDoctorId);
                  else if (sourceDate && sourceRoleCode) setSwapTargetDoctorId(giverDoctorId);
                  else if (targetDoctorId) setSwapTargetDoctorId(targetDoctorId);
                  else setSwapTargetDoctorId("");
                }}
                onApproveRequest={handleApproveRequest}
                onRejectRequest={handleRejectRequest}
              />
            ) : (
              <LockedPanel title="השיבוץ עדיין טיוטה" text="מתמחים ובכירים רגילים יראו את החודש רק אחרי פרסום." />
            )
          )}

          {tab === "roster" && (
            canViewActiveSchedule ? (
              <Roster
                schedule={schedule}
                roles={workspace.roles}
                doctors={workspace.doctors}
                days={days}
                counts={counts}
                role={role}
                ownDoctorId={ownDoctorId || null}
                isMobile={isMobile}
                focusCell={focusCell}
                editable={canEditRoster(role, schedule)}
                validateCurrent={validateCurrent}
                publishCurrent={publishCurrent}
                unpublishCurrent={unpublishCurrent}
                updateAssignment={updateAssignment}
                setFocusCell={setFocusCell}
                autoSchedule={autoGenerateRoster}
              />
            ) : (
              <LockedPanel title="השיבוץ עדיין טיוטה" text="מתמחים ובכירים רגילים יראו את החודש רק אחרי פרסום." />
            )
          )}
          {tab === "exclusions" && (
            <Exclusions
              schedule={schedule}
              exclusions={visibleExclusions}
              doctors={workspace.doctors}
              roles={exclusionRoles}
              days={days}
              form={{ ...exclusionForm, doctorId: canUsePlannerTools(role) ? exclusionForm.doctorId : ownDoctorId }}
              roleCodes={exclusionRoleCodes}
              canChooseDoctor={canUsePlannerTools(role)}
              setForm={setExclusionForm}
              setRoleCodes={setExclusionRoleCodes}
              selectedDates={selectedDates}
              setSelectedDates={setSelectedDates}
              addExclusions={addExclusions}
              deleteExclusion={deleteExclusion}
            />
          )}
          {tab === "doctors" && (
            <Doctors
              data={workspace}
              form={doctorForm}
              setForm={setDoctorForm}
              expandedDoctorId={expandedDoctorId}
              setExpandedDoctorId={setExpandedDoctorId}
              usernameDrafts={doctorUsernameDrafts}
              setUsernameDrafts={setDoctorUsernameDrafts}
              emailDrafts={doctorEmailDrafts}
              setEmailDrafts={setDoctorEmailDrafts}
              passwordDrafts={doctorPasswordDrafts}
              setPasswordDrafts={setDoctorPasswordDrafts}
              roleDrafts={doctorRoleDrafts}
              setRoleDrafts={setDoctorRoleDrafts}
              nameDrafts={doctorNameDrafts}
              setNameDrafts={setDoctorNameDrafts}
              groupDrafts={doctorGroupDrafts}
              setGroupDrafts={setDoctorGroupDrafts}
              angioDrafts={doctorAngioDrafts}
              setAngioDrafts={setDoctorAngioDrafts}
              registrationApprovalDrafts={registrationApprovalDrafts}
              setRegistrationApprovalDrafts={setRegistrationApprovalDrafts}
              addDoctor={addDoctor}
              toggleDoctor={toggleDoctor}
              saveDoctorUser={saveDoctorUser}
              removeDoctor={removeDoctor}
              approvePendingRegistration={approvePendingRegistration}
              rejectPendingRegistration={rejectPendingRegistration}
              refreshFromServer={() => run(() => loadFromServerWithUnsavedCheck())}
              loadTestData={loadTestData}
            />
          )}
          {tab === "audit" && <AuditPanel entries={workspace.auditLog} activeScheduleKey={schedule.key} doctors={workspace.doctors} roles={workspace.roles} />}
          {tab === "drive" && (
            <DrivePanel
              data={workspace}
              busy={busy}
              syncState={syncState}
              retrySave={retrySave}
              loadFromServer={loadFromServerWithUnsavedCheck}
              actorRole={role}
              handleLogout={handleLogout}
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

          {swapModalCell && (
            <div className="modal-overlay">
              <div className="panel modal-panel mobile-modal-panel">
                <h3 style={{ marginTop: 0 }}>{swapModalCell.mode === "exchange" ? "אישור החלפה" : "מסירת תורנות"}</h3>
                {(() => {
                  const giverDoc = workspace.doctors.find(d => d.id === swapModalCell.giverDoctorId);
                  const roleName = workspace.roles.find(r => r.code === swapModalCell.roleCode)?.name ?? "";
                  const dateStr = swapModalCell.date.split("-").reverse().join("/");
                  const targetDoc = swapTargetDoctorId ? workspace.doctors.find(d => d.id === swapTargetDoctorId) : null;
                  const isDirect = role === "senior-planner" || (role === "senior" && giverDoc?.group === "senior");
                  const isExchange = swapModalCell.mode === "exchange";
                  const sourceDate = swapModalCell.sourceDate ?? swapModalCell.date;
                  const sourceRoleCode = swapModalCell.sourceRoleCode ?? swapModalCell.roleCode;
                  const sourceRoleName = workspace.roles.find(r => r.code === sourceRoleCode)?.name ?? "";
                  const sourceDateStr = sourceDate.split("-").reverse().join("/");
                  const exchangeTargetDoc = swapModalCell.targetDoctorId ? workspace.doctors.find(d => d.id === swapModalCell.targetDoctorId) : null;
                  if (isExchange) {
                    return (
                      <>
                        <div className="exchange-confirm-card">
                          <div className="exchange-confirm-person">
                            <b>ד"ר {giverDoc?.name ?? "?"}</b>
                            <small>{sourceDateStr}</small>
                            <small>{sourceRoleName}</small>
                          </div>
                          <div className="exchange-confirm-arrow">⇄</div>
                          <div className="exchange-confirm-person">
                            <b>ד"ר {exchangeTargetDoc?.name ?? "?"}</b>
                            <small>{dateStr}</small>
                            <small>{roleName}</small>
                          </div>
                        </div>
                        <div style={{ background: "#f8fafc", border: "1px solid var(--line)", borderRadius: "8px", padding: "12px 14px", marginBottom: "16px", fontSize: "13px", color: "var(--muted)" }}>
                          {isDirect ? "השינוי יוחל מיד ויירשם ביומן הפעולות." : "הבקשה תישלח לאישור לפי ההרשאות הקיימות."}
                        </div>
                        <label style={{ display: "flex", flexDirection: "column", gap: "6px", marginBottom: "20px", fontWeight: "bold" }}>
                          סיבה לשינוי
                          <input
                            value={swapReason}
                            onChange={(e) => setSwapReason(e.target.value)}
                            placeholder="הקלד סיבה להחלפה..."
                            style={{ width: "100%" }}
                          />
                        </label>
                        <div className="modal-actions">
                          <button onClick={() => { setSwapModalCell(null); setSwapTargetDoctorId(""); setSwapReason(""); }}>ביטול</button>
                          <button className="primary" onClick={() => handleExecuteSwap()}>
                            {isDirect ? "אשר והחלף" : "שלח בקשה לאישור"}
                          </button>
                        </div>
                      </>
                    );
                  }
                  return (
                    <>
                      <div style={{ background: "#f8fafc", border: "1px solid var(--line)", borderRadius: "8px", padding: "12px 14px", marginBottom: "16px", fontSize: "14px" }}>
                        <div style={{ marginBottom: "6px" }}>
                          <span style={{ color: "var(--muted)" }}>תפקיד: </span><strong>{roleName}</strong>
                          <span style={{ color: "var(--muted)", marginRight: "12px" }}>תאריך: </span><strong>{dateStr}</strong>
                        </div>
                        <div>
                          <span style={{ color: "var(--muted)" }}>מעביר: </span>
                          <strong style={{ color: "#b91c1c" }}>ד"ר {giverDoc?.name ?? "?"}</strong>
                          {targetDoc && (
                            <>
                              <span style={{ margin: "0 8px", color: "var(--muted)" }}>→ מקבל:</span>
                              <strong style={{ color: "#16a34a" }}>ד"ר {targetDoc.name}</strong>
                            </>
                          )}
                        </div>
                        <div style={{ marginTop: "6px", fontSize: "12px", color: "var(--muted)" }}>
                          {isDirect ? "✓ שינוי ישיר — יוחל מיד ויתועד ביומן" : "⏳ בקשה — תישלח לאישור הצ'יף"}
                        </div>
                      </div>

                      <label style={{ display: "flex", flexDirection: "column", gap: "6px", marginBottom: "12px", fontWeight: "bold" }}>
                        {swapTargetDoctorId ? "רופא מקבל (ניתן לשינוי)" : "בחר רופא מקבל"}
                        <select
                          value={swapTargetDoctorId}
                          onChange={(e) => setSwapTargetDoctorId(e.target.value)}
                          style={{ width: "100%" }}
                        >
                          <option value="">-- בחר רופא --</option>
                          {(() => {
                            const giverDoctor = workspace.doctors.find(d => d.id === swapModalCell.giverDoctorId);
                            const roleObj = workspace.roles.find(r => r.code === swapModalCell.roleCode);
                            if (!giverDoctor || !roleObj) return null;
                            const options = workspace.doctors.filter(d =>
                              d.active &&
                              d.id !== swapModalCell.giverDoctorId &&
                              d.group === giverDoctor.group &&
                              isDoctorEligibleForRole(d, roleObj)
                            );
                            const availableOptions = options.filter(d => !isDoctorBlockedForAssignment(schedule, d.id, swapModalCell.date, swapModalCell.roleCode));
                            const blockedOptions = options.filter(d => isDoctorBlockedForAssignment(schedule, d.id, swapModalCell.date, swapModalCell.roleCode));
                            return (
                              <>
                                {availableOptions.map(d => (
                                  <option key={d.id} value={d.id}>{formatDoctorOption(d)}</option>
                                ))}
                                {blockedOptions.length > 0 && <option disabled>━━ אילוצים ━━</option>}
                                {blockedOptions.map(d => (
                                  <option key={d.id} value={d.id}>{formatDoctorOption(d)} (אילוץ)</option>
                                ))}
                              </>
                            );
                          })()}
                        </select>
                      </label>

                      <label style={{ display: "flex", flexDirection: "column", gap: "6px", marginBottom: "20px", fontWeight: "bold" }}>
                        סיבה לשינוי
                        <input
                          value={swapReason}
                          onChange={(e) => setSwapReason(e.target.value)}
                          placeholder="הקלד סיבה להעברה..."
                          style={{ width: "100%" }}
                        />
                      </label>

                      <div className="modal-actions">
                        <button onClick={() => { setSwapModalCell(null); setSwapTargetDoctorId(""); setSwapReason(""); }}>ביטול</button>
                        <button
                          className="primary"
                          disabled={!swapTargetDoctorId}
                          onClick={() => handleExecuteSwap()}
                        >
                          {isDirect ? "בצע מסירה מיידית" : "שלח בקשה לאישור"}
                        </button>
                      </div>
                    </>
                  );
                })()}
              </div>
            </div>
          )}
        </>
      ) : null}
    </main>
  );
}

function canSeeTab(item: (typeof tabs)[number], role: AppRole | null) {
  if (!role) return false;
  if (item.plannerOnly) return canUsePlannerTools(role);
  if (item.draftPlanner) return role === "senior-planner" || role === "chief-resident";
  if (item.scheduleEditor) return true;
  if (item.requestReviewer) return canReviewRequests(role);
  if (item.audit) return role === "senior-planner" || role === "chief-resident";
  return true;
}

function BlockedUser({ email, recover }: { email: string; recover: () => void }) {
  return (
    <section className="panel">
      <h2>אין הרשאה במערכת</h2>
      <p>החשבון {email} לא רשום או אינו פעיל. אנא פנה למנהל המערכת (מתכנן בכיר) על מנת להסדיר את הרשאות הגישה שלך.</p>
    </section>
  );
}

function LockedPanel({ title, text }: { title: string; text: string }) {
  return <section className="panel"><h2>{title}</h2><p>{text}</p></section>;
}

function InfoCell({ label, value, tone }: { label: string; value: string; tone?: "good" | "warn" | "bad" }) {
  return <div className={`info-cell ${tone ?? ""}`}><span>{label}</span><b>{value}</b></div>;
}

function SyncStatus({ state, connected, onRetry }: { state: SyncState; connected: boolean; onRetry: () => void }) {
  if (!connected) {
    return <span className="sync-status local">עובד מקומית</span>;
  }
  if (state.lastSaveError) {
    return (
      <span className="sync-status failed">
        שמירה נכשלה
        <button onClick={onRetry}>נסה שוב</button>
      </span>
    );
  }
  if (state.isSaving || state.isSavePending) {
    return <span className="sync-status saving">שומר...</span>;
  }
  return <span className="sync-status saved">נשמר</span>;
}

function createChangeCode() {
  const timePart = Date.now().toString(36).slice(-5).toUpperCase();
  const randomPart = Math.random().toString(36).slice(2, 5).toUpperCase();
  return `SWP-${timePart}-${randomPart}`;
}

function linkedAssignmentKeys(date: string, roleCode: RoleCode) {
  const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  if ((roleCode === ROLE_CODES.SENIOR_A || roleCode === ROLE_CODES.FRIDAY_MORNING_SENIOR) && weekday === 5) {
    return [
      cellKey(date, ROLE_CODES.SENIOR_A),
      cellKey(date, ROLE_CODES.FRIDAY_MORNING_SENIOR),
      cellKey(nextDayKey(date), ROLE_CODES.HALF_SENIOR)
    ];
  }
  if (roleCode === ROLE_CODES.HALF_SENIOR && weekday === 6) {
    const friday = previousDayKey(date);
    return [
      cellKey(friday, ROLE_CODES.SENIOR_A),
      cellKey(friday, ROLE_CODES.FRIDAY_MORNING_SENIOR),
      cellKey(date, ROLE_CODES.HALF_SENIOR)
    ];
  }
  return [cellKey(date, roleCode)];
}

function isDoctorExcluded(exclusionsSet: Set<string>, date: string, roleCode: RoleCode, doctorId: string) {
  return exclusionsSet.has(`${date}|*|${doctorId}`) ||
    exclusionRoleCodesForAssignment(roleCode).some((candidate) => exclusionsSet.has(`${date}|${candidate}|${doctorId}`));
}

function isDoctorBlockedForAssignment(schedule: MonthSchedule, doctorId: string, date: string, roleCode: RoleCode) {
  const roleCodes = new Set(exclusionRoleCodesForAssignment(roleCode));
  return schedule.exclusions.some((exclusion) =>
    exclusion.doctorId === doctorId &&
    exclusion.date === date &&
    (exclusion.roleCode === null || roleCodes.has(exclusion.roleCode))
  );
}

function defaultRegistrationApprovalDraft(data: WorkspaceData, request: RegistrationRequest): RegistrationApprovalDraft {
  const likelyMatch = findLikelyRegistrationMatches(data, request)[0];
  return {
    mode: likelyMatch ? "merge" : "new",
    doctorId: likelyMatch?.id ?? "",
    group: "resident",
    role: "resident",
    canAngio: false
  };
}

function formatDoctorOption(doctor: Doctor) {
  return `${doctor.group === "resident" ? "מתמחה · " : "בכיר · "}${doctor.name}${doctor.canAngio ? " · אנגיו" : ""}`;
}

function formatScheduleMonth(schedule: MonthSchedule) {
  return `${String(schedule.month).padStart(2, "0")}/${schedule.year}`;
}

function formatShortDate(date: string) {
  const [year, month, day] = date.split("-");
  return `${day}/${month}/${year}`;
}

function ScheduleLensControls({
  lens,
  setLens,
  weekIndex,
  setWeekIndex,
  weeks,
  mineCount,
  canUseMine
}: {
  lens: ScheduleLens;
  setLens: (lens: ScheduleLens) => void;
  weekIndex: number;
  setWeekIndex: (index: number) => void;
  weeks: ReturnType<typeof buildMonthDays>[];
  mineCount: number;
  canUseMine: boolean;
}) {
  return (
    <div className="schedule-lens-bar">
      <div className="segmented-control" role="tablist" aria-label="תצוגת סידור">
        <button type="button" className={lens === "month" ? "active" : ""} onClick={() => setLens("month")}>
          חודש
        </button>
        <button type="button" className={lens === "mine" ? "active" : ""} onClick={() => setLens("mine")} disabled={!canUseMine}>
          <LocateFixed size={16} />
          שלי {canUseMine ? `(${mineCount})` : ""}
        </button>
      </div>
    </div>
  );
}

function MonthScheduleMap({
  days,
  lens,
  todayKey,
  visibleDayKeys,
  assignmentCountsByDay,
  ownAssignmentDayKeys,
  onSelectDay
}: {
  days: ReturnType<typeof buildMonthDays>;
  lens: ScheduleLens;
  todayKey: string | null;
  visibleDayKeys: Set<string>;
  assignmentCountsByDay: Map<string, number>;
  ownAssignmentDayKeys: Set<string>;
  onSelectDay?: (date: string) => void;
}) {
  return (
    <div className="schedule-month-map" aria-label="מפת חודש">
      {days.map((day) => {
        const count = assignmentCountsByDay.get(day.key) ?? 0;
        const mine = ownAssignmentDayKeys.has(day.key);
        const inLens = visibleDayKeys.has(day.key);
        return (
          <button
            type="button"
            key={day.key}
            className={`${todayKey === day.key ? "today" : ""} ${mine ? "mine" : ""} ${inLens ? "in-lens" : ""} ${day.isJewishHoliday ? "holiday-day" : ""}`}
            title={day.holidayName ?? undefined}
            onClick={() => onSelectDay?.(day.key)}
          >
            <b>{day.day}</b>
            <span>{day.weekdayLabel}</span>
            <i>{count || ""}</i>
          </button>
        );
      })}
      {lens === "mine" && !visibleDayKeys.size ? <p>אין לך שיבוצים בחודש הזה.</p> : null}
    </div>
  );
}

function MobileRosterDayCards({
  schedule,
  roles,
  doctorsById,
  eligibleDoctorsByRole,
  days,
  issueByCell,
  focusCell,
  editable,
  ownDoctorId,
  ownAssignmentDayKeys,
  updateAssignment
}: {
  schedule: MonthSchedule;
  roles: Role[];
  doctorsById: Map<string, Doctor>;
  eligibleDoctorsByRole: Map<RoleCode, Doctor[]>;
  days: ReturnType<typeof buildMonthDays>;
  issueByCell: Map<string | undefined, string>;
  focusCell: string | null;
  editable: boolean;
  ownDoctorId: string | null;
  ownAssignmentDayKeys: Set<string>;
  updateAssignment: (date: string, roleCode: RoleCode, value: string) => void;
}) {
  return (
    <div className="mobile-roster-list">
      {days.map((day) => (
        <article className={`mobile-roster-card ${ownAssignmentDayKeys.has(day.key) ? "mine-day" : ""} ${day.isJewishHoliday ? "holiday-day" : ""}`} key={day.key} title={day.holidayName ?? undefined}>
          <header className="mobile-roster-card-header">
            <strong>{day.day}</strong>
            <span>{day.weekdayLabel}</span>
            <small>{formatShortDate(day.key)}</small>
            {day.holidayName ? <small className="holiday-name">{day.holidayName}</small> : null}
          </header>
          <div className="mobile-roster-rows">
            {roles.map((roleItem) => {
              const key = cellKey(day.key, roleItem.code);
              const assignment = schedule.assignments[key] ?? { doctorId: null, pending: false };
              const disabled = isFridayOnlyRole(roleItem.code) && !day.allowsFridayRoles;
              const issue = issueByCell.get(key);
              const assignedDoc = assignment.doctorId ? doctorsById.get(assignment.doctorId) : null;
              const mine = assignment.doctorId === ownDoctorId;
              const options = eligibleDoctorsByRole.get(roleItem.code) ?? [];
              const availableOptions = options.filter((doctor) => !isDoctorBlockedForAssignment(schedule, doctor.id, day.key, roleItem.code));
              const blockedOptions = options.filter((doctor) => isDoctorBlockedForAssignment(schedule, doctor.id, day.key, roleItem.code));
              return (
                <div className={`mobile-roster-row ${disabled ? "disabled" : ""} ${issue ?? ""} ${focusCell === key ? "focused" : ""} ${mine ? "mine-assignment" : ""}`} key={roleItem.code}>
                  <div className="mobile-roster-row-meta">
                    <span className="role-title">
                      <i style={{ background: roleItem.color }} />
                      {roleItem.name}
                    </span>
                    <small>{disabled ? "לא פעיל ביום זה" : assignment.pending ? "ממתין" : assignedDoc?.name ?? "לא שובץ"}</small>
                  </div>
                  <div className="mobile-roster-row-action">
                    {disabled ? (
                      <span className="blocked-cell">לא פעיל</span>
                    ) : (
                      <select disabled={!editable} value={assignment.pending ? "__pending" : assignment.doctorId ?? ""} onChange={(event) => updateAssignment(day.key, roleItem.code, event.target.value)}>
                        <option value="">לא שובץ</option>
                        <option value="__pending">ממתין</option>
                        {availableOptions.map((doctor) => <option key={doctor.id} value={doctor.id}>{formatDoctorOption(doctor)}</option>)}
                        {blockedOptions.length ? <option disabled>━━ אילוצים ━━</option> : null}
                        {blockedOptions.map((doctor) => <option key={doctor.id} value={doctor.id}>{formatDoctorOption(doctor)}</option>)}
                      </select>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </article>
      ))}
    </div>
  );
}

function Roster({
  schedule,
  roles,
  doctors,
  days,
  counts,
  role,
  ownDoctorId,
  isMobile,
  focusCell,
  editable,
  validateCurrent,
  publishCurrent,
  unpublishCurrent,
  setFocusCell,
  updateAssignment,
  autoSchedule
}: {
  schedule: MonthSchedule;
  roles: Role[];
  doctors: Doctor[];
  days: ReturnType<typeof buildMonthDays>;
  counts: { assigned: number; pending: number; errors: number; warnings: number };
  role: AppRole;
  ownDoctorId: string | null;
  isMobile: boolean;
  focusCell: string | null;
  editable: boolean;
  validateCurrent: () => void;
  publishCurrent: () => void;
  unpublishCurrent: () => void;
  setFocusCell: (cell: string) => void;
  updateAssignment: (date: string, roleCode: RoleCode, value: string) => void;
  autoSchedule: () => void;
}) {
  const [lens, setLens] = useState<ScheduleLens>("month");
  const [weekIndex, setWeekIndex] = useState(() => currentWeekIndexForSchedule(schedule, days));
  useEffect(() => {
    setWeekIndex(currentWeekIndexForSchedule(schedule, days));
  }, [schedule.key, days]);
  const issueByCell = useMemo(() => new Map(schedule.validation.issues.map((issue) => [issue.cellKey, issue.severity])), [schedule.validation.issues]);
  const doctorsById = useMemo(() => new Map(doctors.map((doctor) => [doctor.id, doctor] as const)), [doctors]);
  const eligibleDoctorsByRole = useMemo(() => new Map(roles.map((roleItem) => [
    roleItem.code,
    doctors.filter((doctor) => isDoctorEligibleForRole(doctor, roleItem)).sort(doctorSortForRole(roleItem))
  ] as const)), [doctors, roles]);
  const scheduleView = useMemo(() => (
    isMobile ? buildScheduleView(schedule, roles, days, lens, weekIndex, ownDoctorId) : null
  ), [days, isMobile, lens, ownDoctorId, roles, schedule, weekIndex]);
  const todayKey = useMemo(() => scheduleTodayKey(schedule), [schedule]);
  return (
    <section className="panel">
      <div className="toolbar roster-toolbar">
        <div>
          <h2>שיבוץ חודשי</h2>
          <span>{formatScheduleMonth(schedule)} · {editable ? "מצב עריכה" : "קריאה בלבד"} · {schedule.status === "published" ? <b className="locked-status">נעול</b> : "טיוטה"}</span>
        </div>
        <div className="actions">
          {canUsePlannerTools(role) && editable && (
            <button onClick={autoSchedule} style={{ background: "#eff6ff", borderColor: "#bfdbfe", color: "#1e40af" }}>
              שיבוץ אוטומטי
            </button>
          )}
          <button onClick={validateCurrent} disabled={!canEditDraftRoster(role)}>בדוק</button>
          {canUsePlannerTools(role) ? (
            <>
              <button className="primary" onClick={publishCurrent} disabled={!canPublish(role)}>פרסם</button>
              <button onClick={unpublishCurrent} disabled={!canPublish(role) || schedule.status === "draft"}>החזר לטיוטה</button>
            </>
          ) : null}
        </div>
      </div>
      <div className="roster-summary">
        <InfoCell label="שיבוצים" value={String(counts.assigned)} />
        <InfoCell label="שגיאות" value={String(counts.errors)} tone={counts.errors ? "bad" : "good"} />
        <InfoCell label="אזהרות" value={String(counts.warnings)} tone={counts.warnings ? "warn" : "good"} />
        <InfoCell label="בדיקה" value={schedule.validation.stale ? "צריך בדיקה" : "נבדק"} tone={schedule.validation.stale ? "warn" : "good"} />
        <InfoCell label="סנכרון יומן" value={schedule.lastSyncedAt ? new Date(schedule.lastSyncedAt).toLocaleString("he-IL") : "טרם סונכרן"} />
      </div>
      {schedule.validation.issues.length ? (
        <div className="issue-strip">
          {schedule.validation.issues.slice(0, 6).map((issue) => (
            <button key={issue.id} className={`issue-pill ${issue.severity}`} onClick={() => issue.cellKey && setFocusCell(issue.cellKey)}>
              <span>{issue.severity === "error" ? "שגיאה" : "אזהרה"}</span>
              {issue.message}
            </button>
          ))}
          {schedule.validation.issues.length > 6 ? <span className="hint">+{schedule.validation.issues.length - 6} נוספות</span> : null}
        </div>
      ) : null}
      {isMobile && scheduleView ? <div className="mobile-schedule-tools">
        <ScheduleLensControls
          lens={lens}
          setLens={setLens}
          weekIndex={weekIndex}
          setWeekIndex={setWeekIndex}
          weeks={scheduleView.weeks}
          mineCount={scheduleView.mineCount}
          canUseMine={Boolean(ownDoctorId)}
        />
        <MonthScheduleMap
          days={days}
          lens={lens}
          todayKey={todayKey}
          visibleDayKeys={scheduleView.visibleDayKeys}
          assignmentCountsByDay={scheduleView.assignmentCountsByDay}
          ownAssignmentDayKeys={scheduleView.ownAssignmentDayKeys}
          onSelectDay={(date) => {
            const index = scheduleView.weeks.findIndex((week) => week.some((day) => day.key === date));
            if (index >= 0) setWeekIndex(index);
            setLens("week");
          }}
        />
      </div> : null}
      {!isMobile ? <div className="board-wrap desktop-roster-table">
        <table className="roster-table">
          <thead><tr><th className="sticky-date">תאריך</th>{roles.map((role) => <th key={role.code}><span className="role-title"><i style={{ background: role.color }} />{role.name}</span></th>)}</tr></thead>
          <tbody>
            {days.map((day) => (
              <tr className={day.isJewishHoliday ? "holiday-row" : ""} key={day.key} title={day.holidayName ?? undefined}>
                <th className="sticky-date"><strong>{day.day}</strong><span>{day.weekdayLabel}</span>{day.holidayName ? <small className="holiday-name">{day.holidayName}</small> : null}</th>
                {roles.map((role) => {
                  const key = cellKey(day.key, role.code);
                  const assignment = schedule.assignments[key] ?? { doctorId: null, pending: false };
                  const disabled = isFridayOnlyRole(role.code) && !day.allowsFridayRoles;
                  const issue = issueByCell.get(key);
                  const options = eligibleDoctorsByRole.get(role.code) ?? [];
                  const availableOptions = options.filter((doctor) => !isDoctorBlockedForAssignment(schedule, doctor.id, day.key, role.code));
                  const blockedOptions = options.filter((doctor) => isDoctorBlockedForAssignment(schedule, doctor.id, day.key, role.code));
                  return (
                    <td key={role.code} id={`cell-${key}`} className={`${disabled ? "disabled" : ""} ${issue ?? ""} ${focusCell === key ? "focused" : ""}`}>
                      {disabled ? <span className="blocked-cell">לא פעיל</span> : (
                        <select disabled={!editable} value={assignment.pending ? "__pending" : assignment.doctorId ?? ""} onChange={(event) => updateAssignment(day.key, role.code, event.target.value)}>
                          <option value="">לא שובץ</option>
                          <option value="__pending">ממתין</option>
                          {availableOptions.map((doctor) => <option key={doctor.id} value={doctor.id}>{formatDoctorOption(doctor)}</option>)}
                          {blockedOptions.length ? <option disabled>━━ אילוצים ━━</option> : null}
                          {blockedOptions.map((doctor) => <option key={doctor.id} value={doctor.id}>{formatDoctorOption(doctor)}</option>)}
                        </select>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div> : null}
      {isMobile && scheduleView ? <MobileRosterDayCards
        schedule={schedule}
        roles={roles}
        doctorsById={doctorsById}
        eligibleDoctorsByRole={eligibleDoctorsByRole}
        days={scheduleView.visibleDays}
        issueByCell={issueByCell}
        focusCell={focusCell}
        editable={editable}
        ownDoctorId={ownDoctorId}
        ownAssignmentDayKeys={scheduleView.ownAssignmentDayKeys}
        updateAssignment={updateAssignment}
      /> : null}
    </section>
  );
}

function Exclusions({
  schedule,
  exclusions,
  doctors,
  roles,
  days,
  form,
  roleCodes,
  canChooseDoctor,
  setForm,
  setRoleCodes,
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
  form: { doctorId: string; reason: string };
  roleCodes: RoleCode[];
  canChooseDoctor: boolean;
  setForm: (value: { doctorId: string; reason: string }) => void;
  setRoleCodes: (value: RoleCode[]) => void;
  selectedDates: string[];
  setSelectedDates: (dates: string[]) => void;
  addExclusions: () => void;
  deleteExclusion: (id: string) => void;
}) {
  const sortedExclusions = [...exclusions].sort((a, b) =>
    a.date.localeCompare(b.date) ||
    String(a.roleCode ?? "").localeCompare(String(b.roleCode ?? "")) ||
    a.doctorId.localeCompare(b.doctorId)
  );
  const groupedExclusions = Array.from(
    sortedExclusions.reduce((groups, exclusion) => {
      const group = groups.get(exclusion.doctorId) ?? [];
      group.push(exclusion);
      groups.set(exclusion.doctorId, group);
      return groups;
    }, new Map<string, typeof sortedExclusions>())
  ).sort(([doctorIdA], [doctorIdB]) => {
    const doctorA = doctors.find((doctor) => doctor.id === doctorIdA)?.name ?? "";
    const doctorB = doctors.find((doctor) => doctor.id === doctorIdB)?.name ?? "";
    return doctorA.localeCompare(doctorB, "he");
  });

  return (
    <section className="panel exclusions-panel">
      <div className="toolbar">
        <div>
          <h2>אילוצים</h2>
          <span className="section-date">{formatScheduleMonth(schedule)}</span>
        </div>
        <button className="primary" onClick={addExclusions}><Plus size={17} />הוסף חסימה</button>
      </div>
      <div className="form-row">
        {canChooseDoctor ? (
          <select value={form.doctorId} onChange={(event) => setForm({ ...form, doctorId: event.target.value })}>
            <option value="">בחר רופא</option>
            {doctors.map((doctor) => <option key={doctor.id} value={doctor.id}>{doctor.name}</option>)}
          </select>
        ) : <span className="readonly-chip">{doctors.find((doctor) => doctor.id === form.doctorId)?.name ?? "המשתמש לא מקושר לרופא"}</span>}
        <div className="role-blockers">
          {roleCodes.map((roleCode, index) => (
            <div className="role-blocker" key={`${roleCode}-${index}`}>
              <select value={roleCode} onChange={(event) => setRoleCodes(roleCodes.map((item, itemIndex) => itemIndex === index ? event.target.value as RoleCode : item))}>
                {roles.map((role) => <option key={role.code} value={role.code}>{role.name}</option>)}
              </select>
              {roleCodes.length > 1 ? <button aria-label="הסר תפקיד" onClick={() => setRoleCodes(roleCodes.filter((_, itemIndex) => itemIndex !== index))}><Trash2 size={16} /></button> : null}
            </div>
          ))}
          <button onClick={() => setRoleCodes([...roleCodes, roles[0]?.code ?? ROLE_CODES.RESIDENT_ON_CALL])}><Plus size={16} />הוסף תפקיד</button>
        </div>
        <input value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} placeholder="סיבה / הערה" />
      </div>
      <div className="month-picker">
        {days.map((day) => {
          const active = selectedDates.includes(day.key);
          return <button key={day.key} className={active ? "selected" : ""} onClick={() => setSelectedDates(active ? selectedDates.filter((date) => date !== day.key) : [...selectedDates, day.key])}><b>{day.day}</b><span>{day.weekdayLabel}</span></button>;
        })}
      </div>
      <div className="exclusion-review">
        <div className="toolbar compact"><h2>אילוצים שנוספו</h2><span>{sortedExclusions.length} רשומות</span></div>
        <div className="exclusion-card-list">
          {sortedExclusions.length === 0 ? <div className="list-row">אין עדיין אילוצים בחודש הזה.</div> : null}
          {groupedExclusions.map(([doctorId, doctorExclusions]) => {
            const doctor = doctors.find((candidate) => candidate.id === doctorId);
            return (
              <article className="exclusion-card grouped" key={doctorId}>
                <div className="exclusion-card-header">
                  <span>
                    <b>{doctor?.name ?? "רופא לא ידוע"}</b>
                    <small>{doctor?.group === "senior" ? "בכיר" : "מתמחה"} · {doctorExclusions.length} אילוצים</small>
                  </span>
                </div>
                <div className="exclusion-chip-list">
                  {doctorExclusions.map((exclusion) => {
                    const role = roles.find((candidate) => candidate.code === exclusion.roleCode);
                    return (
                      <span className="exclusion-chip" key={exclusion.id}>
                        <span>
                          <b>{exclusion.date}</b>
                          <small>{role?.name ?? "כל התפקידים"}{exclusion.reason ? ` · ${exclusion.reason}` : ""}</small>
                        </span>
                        <button className="danger icon-button" aria-label="מחק אילוץ" onClick={() => deleteExclusion(exclusion.id)}><Trash2 size={14} /></button>
                      </span>
                    );
                  })}
                </div>
              </article>
            );
          })}
        </div>
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

function MobilePublishedRosterDayCards({
  schedule,
  roles,
  doctorsById,
  days,
  changeMode,
  selectedExchangeCell,
  ownDoctorId,
  ownAssignmentDayKeys,
  canUseCell,
  canExchangeCells,
  onSwapCellClick,
  setSelectedExchangeCell,
  setExchangeMessage
}: {
  schedule: MonthSchedule;
  roles: Role[];
  doctorsById: Map<string, Doctor>;
  days: ReturnType<typeof buildMonthDays>;
  changeMode: PublishedChangeMode | null;
  selectedExchangeCell: { date: string; roleCode: RoleCode; doctorId: string } | null;
  ownDoctorId: string | null;
  ownAssignmentDayKeys: Set<string>;
  canUseCell: (assignment: Assignment) => boolean;
  canExchangeCells: (source: { date: string; roleCode: RoleCode; doctorId: string }, targetDate: string, targetRoleCode: RoleCode) => boolean;
  onSwapCellClick: (mode: AppliedPublishedChangeMode, date: string, roleCode: RoleCode, giverDoctorId: string, targetDoctorId?: string, sourceDate?: string, sourceRoleCode?: RoleCode) => void;
  setSelectedExchangeCell: (cell: { date: string; roleCode: RoleCode; doctorId: string } | null) => void;
  setExchangeMessage: (message: string) => void;
}) {
  function handleCellTap(date: string, roleCode: RoleCode, assignment: Assignment) {
    if (!changeMode || !assignment.doctorId || !canUseCell(assignment)) return;
    if (changeMode === "handoff") {
      onSwapCellClick("handoff", date, roleCode, assignment.doctorId);
      return;
    }
    if (!selectedExchangeCell) {
      setSelectedExchangeCell({ date, roleCode, doctorId: assignment.doctorId });
      setExchangeMessage("נבחר תא ראשון להחלפה. עכשיו בחר תא משובץ שני.");
      return;
    }
    if (selectedExchangeCell.date === date && selectedExchangeCell.roleCode === roleCode) {
      setSelectedExchangeCell(null);
      setExchangeMessage("");
      return;
    }
    if (!canExchangeCells(selectedExchangeCell, date, roleCode)) {
      setExchangeMessage("לא ניתן לבצע החלפה בין שני התאים האלה.");
      return;
    }
    onSwapCellClick("exchange", date, roleCode, selectedExchangeCell.doctorId, assignment.doctorId, selectedExchangeCell.date, selectedExchangeCell.roleCode);
    setSelectedExchangeCell(null);
    setExchangeMessage("");
  }

  return (
    <div className="mobile-roster-list">
      {days.map((day) => (
        <article className={`mobile-roster-card ${ownAssignmentDayKeys.has(day.key) ? "mine-day" : ""} ${day.isJewishHoliday ? "holiday-day" : ""}`} key={day.key} title={day.holidayName ?? undefined}>
          <div className="mobile-roster-rows">
            {roles.map((roleItem) => {
              const key = cellKey(day.key, roleItem.code);
              const assignment = schedule.assignments[key] ?? { doctorId: null, pending: false };
              const disabled = isFridayOnlyRole(roleItem.code) && !day.allowsFridayRoles;
              if (disabled) return null;
              const assignedDoc = assignment.doctorId ? doctorsById.get(assignment.doctorId) : null;
              const selected = selectedExchangeCell?.date === day.key && selectedExchangeCell.roleCode === roleItem.code;
              const tappable = !!assignment.doctorId && canUseCell(assignment);
              const mine = assignment.doctorId === ownDoctorId;
              const actionLabel = selected ? "נבחר" : changeMode === "handoff" && tappable ? "מסירה" : changeMode === "exchange" && tappable ? "החלפה" : null;
              const statusLabel = assignment.pending ? "ממתין" : actionLabel ?? (mine ? "התורנות שלי" : null);
              return (
                <button
                  type="button"
                  className={`mobile-roster-row mobile-roster-row-button ${selected ? "selected" : ""} ${tappable ? "interactive" : ""} ${mine ? "mine-assignment" : ""}`}
                  key={roleItem.code}
                  disabled={!tappable}
                  onClick={() => handleCellTap(day.key, roleItem.code, assignment)}
                >
                  <span className="mobile-roster-row-meta">
                    <span className="mobile-roster-row-main">
                      <span className="role-title">
                        <i style={{ background: roleItem.color }} />
                        {roleItem.name}
                      </span>
                      <strong className={assignedDoc ? "" : "unassigned"}>{assignedDoc?.name ?? "לא שובץ"}</strong>
                    </span>
                    {statusLabel ? <small>{statusLabel}</small> : null}
                  </span>
                </button>
              );
            })}
          </div>
        </article>
      ))}
    </div>
  );
}

function PublishedRoster({
  schedule,
  roles,
  doctors,
  days,
  role,
  appUser,
  currentUser,
  isMobile,
  changeRequests,
  onSwapCellClick,
  onApproveRequest,
  onRejectRequest
}: {
  schedule: MonthSchedule;
  roles: Role[];
  doctors: Doctor[];
  days: ReturnType<typeof buildMonthDays>;
  role: AppRole;
  appUser: AppUser | null;
  currentUser: SessionUser;
  isMobile: boolean;
  changeRequests: ChangeRequest[];
  onSwapCellClick: (mode: AppliedPublishedChangeMode, date: string, roleCode: RoleCode, giverDoctorId: string, targetDoctorId?: string, sourceDate?: string, sourceRoleCode?: RoleCode) => void;
  onApproveRequest: (id: string, reason: string) => Promise<void>;
  onRejectRequest: (id: string) => void;
}) {
  const [changeMode, setChangeMode] = useState<PublishedChangeMode | null>(null);
  const [selectedExchangeCell, setSelectedExchangeCell] = useState<{ date: string; roleCode: RoleCode; doctorId: string } | null>(null);
  const [approveNotes, setApproveNotes] = useState<Record<string, string>>({});
  const [dragSource, setDragSource] = useState<{ date: string; roleCode: RoleCode; doctorId: string } | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [exchangeMessage, setExchangeMessage] = useState("");
  const ownDoctorId = appUser?.doctorId ??
    doctors.find((doctor) => {
      const doctorName = doctor.name.replace(/^ד["״']?ר\s*/, "").trim();
      return [appUser?.name, currentUser.name].some((name) => {
        const normalizedName = name?.replace(/^ד["״']?ר\s*/, "").trim();
        return Boolean(normalizedName && (normalizedName === doctorName || doctorName.includes(normalizedName) || normalizedName.includes(doctorName)));
      });
    })?.id ??
    null;
  const [lens, setLens] = useState<ScheduleLens>("month");
  const [weekIndex, setWeekIndex] = useState(() => currentWeekIndexForSchedule(schedule, days));
  const [selectedMobileDayKey, setSelectedMobileDayKey] = useState<string | null>(null);

  useEffect(() => {
    setWeekIndex(currentWeekIndexForSchedule(schedule, days));
  }, [schedule.key, days]);

  useEffect(() => {
    setSelectedMobileDayKey(null);
  }, [schedule.key]);

  const pendingRequests = useMemo(() => {
    return changeRequests.filter(r => r.scheduleKey === schedule.key && r.status === "submitted");
  }, [changeRequests, schedule.key]);
  const doctorsById = useMemo(() => new Map(doctors.map((doctor) => [doctor.id, doctor] as const)), [doctors]);
  const rolesByCode = useMemo(() => new Map(roles.map((roleItem) => [roleItem.code, roleItem] as const)), [roles]);
  const scheduleView = useMemo(() => (
    isMobile ? buildScheduleView(schedule, roles, days, lens, weekIndex, ownDoctorId) : null
  ), [days, isMobile, lens, ownDoctorId, roles, schedule, weekIndex]);
  const todayKey = useMemo(() => scheduleTodayKey(schedule), [schedule]);
  const canUsePublishedChangeTools = schedule.status === "published";
  const disabledChangeToolsTitle = canUsePublishedChangeTools ? undefined : "אפשר לבצע מסירה והחלפות רק אחרי פרסום הסידור.";
  const ownAssignmentDayKeys = useMemo(() => {
    const keys = new Set<string>();
    const currentNames = [appUser?.name, currentUser.name]
      .map((name) => name?.replace(/^ד["״']?ר\s*/, "").trim())
      .filter((name): name is string => Boolean(name));
    Object.entries(schedule.assignments).forEach(([assignmentKey, assignment]) => {
      if (assignment.pending || !assignment.doctorId) return;
      const assignedDoctor = doctorsById.get(assignment.doctorId);
      const assignedName = assignedDoctor?.name.replace(/^ד["״']?ר\s*/, "").trim();
      const sameLinkedDoctor = ownDoctorId && assignment.doctorId === ownDoctorId;
      const sameNamedDoctor = Boolean(assignedName && currentNames.some((name) => name === assignedName || assignedName.includes(name) || name.includes(assignedName)));
      if (!sameLinkedDoctor && !sameNamedDoctor) return;
      const [date] = assignmentKey.split("|");
      keys.add(date);
    });
    return keys;
  }, [appUser?.name, currentUser.name, doctorsById, ownDoctorId, schedule.assignments]);
  const automaticReplacementTargets = useMemo(() => {
    if (changeMode !== "auto-exchange" || !selectedExchangeCell) return new Set<string>();
    const sourceAssignment = schedule.assignments[cellKey(selectedExchangeCell.date, selectedExchangeCell.roleCode)];
    if (!sourceAssignment?.doctorId || sourceAssignment.pending) return new Set<string>();

    const baseErrorIds = new Set(validateSchedule(schedule, roles, doctors).filter((issue) => issue.severity === "error").map((issue) => issue.id));
    const targets = new Set<string>();

    days.forEach((day) => {
      const targetKey = cellKey(day.key, selectedExchangeCell.roleCode);
      if (day.key === selectedExchangeCell.date) return;
      const targetAssignment = schedule.assignments[targetKey];
      if (!targetAssignment?.doctorId || targetAssignment.pending) return;
      if (!canExchangeCells(selectedExchangeCell, day.key, selectedExchangeCell.roleCode)) return;

      const simulatedSchedule: MonthSchedule = {
        ...schedule,
        assignments: {
          ...schedule.assignments,
          [cellKey(selectedExchangeCell.date, selectedExchangeCell.roleCode)]: { doctorId: targetAssignment.doctorId, pending: false },
          [targetKey]: { doctorId: sourceAssignment.doctorId, pending: false }
        }
      };
      const newErrors = validateSchedule(simulatedSchedule, roles, doctors)
        .filter((issue) => issue.severity === "error" && !baseErrorIds.has(issue.id));
      if (!newErrors.length) targets.add(targetKey);
    });

    return targets;
  }, [changeMode, days, doctors, roles, schedule, selectedExchangeCell]);

  function canDragCell(assignment: Assignment): boolean {
    if (schedule.status !== "published") return false;
    if (!assignment.doctorId) return false;
    const assignedDoc = doctorsById.get(assignment.doctorId);
    if (!assignedDoc) return false;
    if (role === "senior-planner") return true;
    if (role === "senior") return assignedDoc.group === "senior";
    if (role === "resident" || role === "chief-resident") return assignedDoc.group === "resident";
    return false;
  }

  function canDropOnCell(targetDate: string, targetRoleCode: RoleCode): boolean {
    if (changeMode !== "exchange" || !dragSource) return false;
    const sourceDoc = doctorsById.get(dragSource.doctorId);
    const targetRole = rolesByCode.get(targetRoleCode);
    const sourceRole = rolesByCode.get(dragSource.roleCode);
    const targetAssignment = schedule.assignments[cellKey(targetDate, targetRoleCode)];
    const targetDoc = targetAssignment?.doctorId ? doctorsById.get(targetAssignment.doctorId) : null;
    if (!sourceDoc || !targetRole || !targetDoc) return false;
    if (targetDate === dragSource.date && targetRoleCode === dragSource.roleCode) return false;
    if (!isDoctorEligibleForRole(sourceDoc, targetRole)) return false;
    if (targetDoc && sourceRole && !isDoctorEligibleForRole(targetDoc, sourceRole)) return false;
    return true;
  }

  function canUseCell(assignment: Assignment): boolean {
    if (!changeMode || schedule.status !== "published") return false;
    return canDragCell(assignment);
  }

  function canExchangeCells(source: { date: string; roleCode: RoleCode; doctorId: string }, targetDate: string, targetRoleCode: RoleCode) {
    const sourceDoc = doctorsById.get(source.doctorId);
    const targetAssignment = schedule.assignments[cellKey(targetDate, targetRoleCode)];
    const targetDoc = targetAssignment?.doctorId ? doctorsById.get(targetAssignment.doctorId) : null;
    const sourceRole = rolesByCode.get(source.roleCode);
    const targetRole = rolesByCode.get(targetRoleCode);
    if (!sourceDoc || !targetDoc || !sourceRole || !targetRole) return false;
    if (source.date === targetDate && source.roleCode === targetRoleCode) return false;
    return isDoctorEligibleForRole(sourceDoc, targetRole) && isDoctorEligibleForRole(targetDoc, sourceRole);
  }

  function handleExchangeDoubleClick(date: string, roleCode: RoleCode, assignment: Assignment) {
    if (changeMode !== "exchange" || !assignment.doctorId || !canDragCell(assignment)) return;
    if (!selectedExchangeCell) {
      setSelectedExchangeCell({ date, roleCode, doctorId: assignment.doctorId });
      setExchangeMessage("נבחר תא ראשון להחלפה. לחץ פעמיים על תא שני משובץ.");
      return;
    }
    if (selectedExchangeCell.date === date && selectedExchangeCell.roleCode === roleCode) {
      setSelectedExchangeCell(null);
      setExchangeMessage("");
      return;
    }
    if (!canExchangeCells(selectedExchangeCell, date, roleCode)) {
      setExchangeMessage("לא ניתן לבצע החלפה בין שני התאים האלה. התא השני חייב להיות משובץ ושני הרופאים חייבים להתאים לתפקידים.");
      return;
    }
    const targetDoctorId = assignment.doctorId;
    onSwapCellClick("exchange", date, roleCode, selectedExchangeCell.doctorId, targetDoctorId, selectedExchangeCell.date, selectedExchangeCell.roleCode);
    setSelectedExchangeCell(null);
    setExchangeMessage("");
  }

  function handleAutomaticReplacementClick(date: string, roleCode: RoleCode, assignment: Assignment) {
    if (changeMode !== "auto-exchange" || !assignment.doctorId || assignment.pending) return;
    const key = cellKey(date, roleCode);
    if (!selectedExchangeCell) {
      if (!canDragCell(assignment)) return;
      setSelectedExchangeCell({ date, roleCode, doctorId: assignment.doctorId });
      setExchangeMessage("נבחר שיבוץ מקור. תאים מתאימים באותה עמודה מסומנים בירוק.");
      return;
    }
    if (selectedExchangeCell.date === date && selectedExchangeCell.roleCode === roleCode) {
      setSelectedExchangeCell(null);
      setExchangeMessage("");
      return;
    }
    if (!automaticReplacementTargets.has(key)) {
      setExchangeMessage("התא הזה לא מתאים להחלפה אוטומטית לפי הכללים והאילוצים.");
      return;
    }
    onSwapCellClick("exchange", date, roleCode, selectedExchangeCell.doctorId, assignment.doctorId, selectedExchangeCell.date, selectedExchangeCell.roleCode);
  }

  return (
    <section className="panel">
      <div className="toolbar roster-toolbar">
        <div>
          <h2>לוח תורנויות מפורסם</h2>
          <span>{formatScheduleMonth(schedule)} · {schedule.status === "published" ? "מצב צפייה פעיל" : "טיוטה (קריאה בלבד)"}</span>
        </div>
        <div className="actions">
            <>
              <button
                className={changeMode === "handoff" ? "primary" : ""}
                disabled={!canUsePublishedChangeTools}
                title={disabledChangeToolsTitle}
                onClick={() => {
                  if (!canUsePublishedChangeTools) return;
                  setChangeMode(changeMode === "handoff" ? null : "handoff");
                  setSelectedExchangeCell(null);
                  setDragSource(null);
                  setExchangeMessage("");
                }}
              >
                <UserCheck size={17} />
                {changeMode === "handoff" ? "בטל מסירה" : "מסירה"}
              </button>
              <button
                className={changeMode === "exchange" ? "primary" : ""}
                disabled={!canUsePublishedChangeTools}
                title={disabledChangeToolsTitle}
                onClick={() => {
                  if (!canUsePublishedChangeTools) return;
                  setChangeMode(changeMode === "exchange" ? null : "exchange");
                  setSelectedExchangeCell(null);
                  setDragSource(null);
                  setExchangeMessage("");
                }}
              >
                <RefreshCw size={17} />
                {changeMode === "exchange" ? "בטל החלפה" : "החלפה"}
              </button>
              {!isMobile ? (
                <button
                  className={changeMode === "auto-exchange" ? "primary" : ""}
                  disabled={!canUsePublishedChangeTools}
                  title={disabledChangeToolsTitle}
                  onClick={() => {
                    if (!canUsePublishedChangeTools) return;
                    setChangeMode(changeMode === "auto-exchange" ? null : "auto-exchange");
                    setSelectedExchangeCell(null);
                    setDragSource(null);
                    setExchangeMessage("");
                  }}
                >
                  <LocateFixed size={17} />
                  {changeMode === "auto-exchange" ? "בטל החלפה אוטומטית" : "החלפה אוטומטית"}
                </button>
              ) : null}
            </>
        </div>
      </div>

      {canUsePublishedChangeTools && changeMode && (
        <div className="notice" style={{ background: "#eff6ff", borderColor: "#bfdbfe", color: "#1e40af", marginBottom: "12px", fontSize: "14px" }}>
          {changeMode === "handoff" ? (
            <><strong>מסירה:</strong> לחץ על תא משובץ כדי לבחור רופא שיקבל את התורנות.</>
          ) : changeMode === "auto-exchange" ? (
            <><strong>החלפה אוטומטית:</strong> לחץ על שיבוץ בטבלה. המערכת תסמן החלפות אפשריות באותה עמודה שמכבדות אילוצים וכללי שיבוץ.</>
          ) : (
            <><strong>החלפה:</strong> גרור בין שני תאים משובצים, או לחץ פעמיים על תא ראשון ואז פעמיים על תא שני.</>
          )}
          <br />
          <small>* בכירים יכולים לשנות בכירים בלבד. מתמחים שולחים בקשה לאישור צ'יף. מתכנן בכיר — גישה מלאה.</small>
          {exchangeMessage ? <><br /><small>{exchangeMessage}</small></> : null}
        </div>
      )}

      {isMobile && scheduleView ? <div className="mobile-schedule-tools">
        <div className="my-schedule-summary">
          <span>התורנויות שלי</span>
          <b>{scheduleView.mineCount}</b>
          <small>{ownDoctorId ? "בחודש הפעיל" : "המשתמש לא מקושר לרופא"}</small>
        </div>
        <ScheduleLensControls
          lens={lens}
          setLens={setLens}
          weekIndex={weekIndex}
          setWeekIndex={setWeekIndex}
          weeks={scheduleView.weeks}
          mineCount={scheduleView.mineCount}
          canUseMine={Boolean(ownDoctorId)}
        />
        <MonthScheduleMap
          days={days}
          lens={lens}
          todayKey={todayKey}
          visibleDayKeys={scheduleView.visibleDayKeys}
          assignmentCountsByDay={scheduleView.assignmentCountsByDay}
          ownAssignmentDayKeys={scheduleView.ownAssignmentDayKeys}
          onSelectDay={(date) => {
            const index = scheduleView.weeks.findIndex((week) => week.some((day) => day.key === date));
            if (index >= 0) setWeekIndex(index);
            setSelectedMobileDayKey(date);
          }}
        />
      </div> : null}

      {!isMobile ? <div className="board-wrap desktop-roster-table">
        <table className="roster-table">
          <thead>
            <tr>
              <th className="sticky-date">תאריך</th>
              {roles.map((roleItem) => (
                <th key={roleItem.code}>
                  <span className="role-title">
                    <i style={{ background: roleItem.color }} />
                    {roleItem.name}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {days.map((day) => (
              <tr className={`${ownAssignmentDayKeys.has(day.key) ? "own-assignment-day" : ""} ${day.isJewishHoliday ? "holiday-row" : ""}`} key={day.key} title={day.holidayName ?? undefined}>
                <th className="sticky-date">
                  <strong>{day.day}</strong>
                  <span>{day.weekdayLabel}</span>
                  {day.holidayName ? <small className="holiday-name">{day.holidayName}</small> : null}
                </th>
                {roles.map((roleItem) => {
                  const key = cellKey(day.key, roleItem.code);
                  const assignment = schedule.assignments[key] ?? { doctorId: null, pending: false };
                  const disabled = isFridayOnlyRole(roleItem.code) && !day.allowsFridayRoles;
                  const assignedDoc = assignment.doctorId ? doctorsById.get(assignment.doctorId) : null;

                  const draggable = changeMode === "exchange" && !disabled && canDragCell(assignment);
                  const droppable = !disabled && canDropOnCell(day.key, roleItem.code);
                  const isOver = dragOverKey === key;
                  const usable = !disabled && canUseCell(assignment);
                  const clickable = changeMode === "handoff" && usable;
                  const selected = selectedExchangeCell?.date === day.key && selectedExchangeCell.roleCode === roleItem.code;
                  const automaticCandidate = automaticReplacementTargets.has(key);
                  const automaticSelectable = changeMode === "auto-exchange" && !selectedExchangeCell && !disabled && !!assignment.doctorId && canDragCell(assignment);
                  const automaticClickable = changeMode === "auto-exchange" && (automaticSelectable || automaticCandidate || selected);
                  const hasLightInteractionState = selected || automaticCandidate || isOver;

                  let cellStyle: React.CSSProperties = {};
                  if (selected) {
                    cellStyle = { background: "#dbeafe", border: "2px solid #2563eb", color: "#0f172a", cursor: "pointer" };
                  } else if (automaticCandidate) {
                    cellStyle = { background: "#dcfce7", border: "2px solid #16a34a", color: "#0f172a", cursor: "pointer" };
                  } else if (isOver && droppable) {
                    cellStyle = { background: "#dcfce7", border: "2px dashed #16a34a", color: "#0f172a", transition: "background 0.15s" };
                  } else if (isOver && dragSource && !droppable) {
                    cellStyle = { background: "#fee2e2", border: "2px dashed #dc2626", color: "#0f172a", transition: "background 0.15s" };
                  } else if (draggable) {
                    cellStyle = { cursor: "grab" };
                  } else if (clickable) {
                    cellStyle = { cursor: "pointer" };
                  } else if (automaticSelectable) {
                    cellStyle = { cursor: "pointer" };
                  }

                  return (
                    <td
                      key={roleItem.code}
                      className={`${disabled ? "disabled" : ""} ${automaticCandidate ? "auto-replacement-candidate" : ""} ${hasLightInteractionState ? "light-interaction-cell" : ""}`}
                      style={cellStyle}
                      onClick={() => {
                        if (automaticClickable) {
                          handleAutomaticReplacementClick(day.key, roleItem.code, assignment);
                          return;
                        }
                        if (clickable && assignment.doctorId) {
                          onSwapCellClick("handoff", day.key, roleItem.code, assignment.doctorId);
                        }
                      }}
                      onDoubleClick={() => handleExchangeDoubleClick(day.key, roleItem.code, assignment)}
                      draggable={draggable}
                      onDragStart={(e) => {
                        if (!draggable || !assignment.doctorId) return;
                        setDragSource({ date: day.key, roleCode: roleItem.code, doctorId: assignment.doctorId });
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", assignment.doctorId);
                      }}
                      onDragEnd={() => {
                        setDragSource(null);
                        setDragOverKey(null);
                      }}
                      onDragOver={(e) => {
                        if (changeMode !== "exchange") return;
                        e.preventDefault();
                        setDragOverKey(key);
                        e.dataTransfer.dropEffect = droppable ? "move" : "none";
                      }}
                      onDragLeave={() => {
                        setDragOverKey(prev => prev === key ? null : prev);
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        setDragOverKey(null);
                        if (!dragSource || !droppable) return;
                        const targetAssignment = schedule.assignments[key] ?? { doctorId: null, pending: false };
                        const targetDoctorId = targetAssignment.doctorId ?? undefined;
                        if (!targetDoctorId) return;
                        onSwapCellClick("exchange", day.key, roleItem.code, dragSource.doctorId, targetDoctorId, dragSource.date, dragSource.roleCode);
                        setDragSource(null);
                      }}
                    >
                      {disabled ? (
                        <span className="blocked-cell">לא פעיל</span>
                      ) : assignment.pending ? (
                        <span style={{ color: "var(--muted)", fontStyle: "italic" }}>ממתין</span>
                      ) : assignedDoc ? (
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "2px" }}>
                          <span style={{ fontWeight: 600, userSelect: draggable ? "none" : undefined }}>
                            {assignedDoc.name}
                          </span>
                          {draggable && !dragSource && (
                            <span style={{ fontSize: "10px", color: "#94a3b8" }}>⠇ גרור</span>
                          )}
                          {automaticCandidate && (
                            <span className="cell-action-note">החלפה אפשרית</span>
                          )}
                        </div>
                      ) : (
                        <span style={{ color: droppable ? "#16a34a" : "#cbd5e1", fontSize: droppable ? "12px" : undefined }}>
                          {droppable ? "↓ שחרר כאן" : "-"}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div> : null}
      {isMobile && selectedMobileDayKey ? (
        <MobileDayScheduleModal
          schedule={schedule}
          roles={roles}
          doctorsById={doctorsById}
          day={days.find((day) => day.key === selectedMobileDayKey) ?? null}
          changeMode={changeMode}
          selectedExchangeCell={selectedExchangeCell}
          ownDoctorId={ownDoctorId}
          ownAssignmentDayKeys={scheduleView?.ownAssignmentDayKeys ?? new Set<string>()}
          canUseCell={canUseCell}
          canExchangeCells={canExchangeCells}
          onSwapCellClick={onSwapCellClick}
          setSelectedExchangeCell={setSelectedExchangeCell}
          setExchangeMessage={setExchangeMessage}
          onClose={() => setSelectedMobileDayKey(null)}
        />
      ) : null}

      {canReviewRequests(role) && (
        <div className="request-review-section">
          <h3>בקשות החלפה והעברת תורנויות הממתינות לאישור</h3>
          {pendingRequests.length === 0 ? (
            <p style={{ color: "var(--muted)", fontSize: "14px" }}>אין בקשות תלויות ועומדות לאישור בחודש זה.</p>
          ) : (
            <div className="request-review-list">
              {pendingRequests.map((req) => {
                const requesterDoc = doctorsById.get(req.requesterDoctorId);
                const currentDoc = req.currentDoctorId ? doctorsById.get(req.currentDoctorId) : null;
                const proposedDoc = req.proposedDoctorId ? doctorsById.get(req.proposedDoctorId) : null;
                const kind = req.changeKind ?? "handoff";
                const sourceDoc = kind === "exchange"
                  ? (req.sourceDoctorId ? doctorsById.get(req.sourceDoctorId) : null) ?? requesterDoc
                  : currentDoc ?? requesterDoc;
                const targetDoc = kind === "exchange" ? currentDoc : proposedDoc;
                const sourceRole = rolesByCode.get(req.sourceRoleCode ?? req.roleCode);
                const targetRole = rolesByCode.get(req.roleCode);

                return (
                  <article className={`request-review-card ${kind}`} key={req.id}>
                    <header className="request-review-header">
                      <div>
                        <b>{kind === "exchange" ? "החלפה" : "מסירה"}</b>
                        <small>הוגש ע"י {requesterDoc?.name ?? "לא ידוע"} · {roleLabels[req.requesterRole]}</small>
                      </div>
                      {req.reason ? <small className="request-reason">סיבה: {req.reason}</small> : null}
                    </header>
                    <div className="request-flow">
                      <div className="request-person">
                        <b>{sourceDoc?.name ?? "לא שובץ"}</b>
                        <small>{formatShortDate(req.sourceDate ?? req.date)}</small>
                        <small>{sourceRole?.name ?? req.sourceRoleCode ?? req.roleCode}</small>
                      </div>
                      <div className="request-arrow" aria-label={kind === "exchange" ? "החלפה" : "מסירה"}>
                        <span>{kind === "exchange" ? "⇄" : "←"}</span>
                        <small>{kind === "exchange" ? "החלפה" : "מסירה"}</small>
                      </div>
                      <div className="request-person">
                        <b>{targetDoc?.name ?? "ללא מחליף"}</b>
                        <small>{formatShortDate(req.date)}</small>
                        <small>{targetRole?.name ?? req.roleCode}</small>
                      </div>
                    </div>
                    <div className="request-actions">
                      <input 
                        type="text" 
                        placeholder="הערה לאישור (אופציונלי)..." 
                        value={approveNotes[req.id] ?? ""} 
                        onChange={(e) => setApproveNotes({ ...approveNotes, [req.id]: e.target.value })}
                      />
                      <button 
                        className="primary" 
                        onClick={() => onApproveRequest(req.id, approveNotes[req.id] ?? "")}
                      >
                        <Check size={16} />
                        אשר
                      </button>
                      <button 
                        className="danger" 
                        onClick={() => onRejectRequest(req.id)}
                      >
                        <X size={16} />
                        דחה
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function MobileDayScheduleModal({
  day,
  onClose,
  ...props
}: Omit<Parameters<typeof MobilePublishedRosterDayCards>[0], "days"> & {
  day: ReturnType<typeof buildMonthDays>[number] | null;
  onClose: () => void;
}) {
  if (!day) return null;
  return (
    <div className="modal-overlay" onClick={onClose}>
      <section className="modal-panel mobile-modal-panel day-schedule-modal" onClick={(event) => event.stopPropagation()}>
        <header className="day-schedule-modal-header">
          <div>
            <h3>{day.weekdayLabel} · {formatShortDate(day.key)}</h3>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="סגור"><X size={16} /></button>
        </header>
        <MobilePublishedRosterDayCards {...props} days={[day]} />
      </section>
    </div>
  );
}

function PendingRegistrationRequests({
  data,
  requests,
  drafts,
  setDrafts,
  approve,
  reject
}: {
  data: WorkspaceData;
  requests: RegistrationRequest[];
  drafts: Record<string, RegistrationApprovalDraft>;
  setDrafts: (value: Record<string, RegistrationApprovalDraft>) => void;
  approve: (requestId: string) => void;
  reject: (requestId: string) => void;
}) {
  if (!requests.length) return null;

  function updateDraft(request: RegistrationRequest, patch: Partial<RegistrationApprovalDraft>) {
    const current = drafts[request.id] ?? defaultRegistrationApprovalDraft(data, request);
    setDrafts({ ...drafts, [request.id]: { ...current, ...patch } });
  }

  return (
    <section className="pending-registration-panel">
      <div className="toolbar">
        <h3>בקשות משתמש ממתינות</h3>
        <span>{requests.length} לאישור</span>
      </div>
      <div className="doctor-card-list">
        {requests.map((request) => {
          const draft = drafts[request.id] ?? defaultRegistrationApprovalDraft(data, request);
          const matches = findLikelyRegistrationMatches(data, request);
          return (
            <article className="doctor-card expanded" key={request.id}>
              <div className="doctor-card-main">
                <span>
                  <b>{request.doctorName}</b>
                  <small dir="ltr">{request.username}{request.gmail ? ` · ${request.gmail}` : ""}</small>
                </span>
                <span className="status draft">{matches.length ? `${matches.length} התאמות אפשריות` : "בקשה חדשה"}</span>
              </div>
              <div className="doctor-edit" style={{ display: "grid", gridTemplateColumns: "1fr", gap: "12px" }}>
                <div className="form-row">
                  <label className="check">
                    <input type="radio" checked={draft.mode === "new"} onChange={() => updateDraft(request, { mode: "new" })} />
                    צור רופא ומשתמש חדשים
                  </label>
                  <label className="check">
                    <input type="radio" checked={draft.mode === "merge"} onChange={() => updateDraft(request, { mode: "merge", doctorId: draft.doctorId || data.doctors[0]?.id || "" })} />
                    איחוד עם משתמש קיים / איפוס סיסמה
                  </label>
                </div>

                {draft.mode === "new" ? (
                  <div className="form-row">
                    <select value={draft.group} onChange={(event) => updateDraft(request, { group: event.target.value as DoctorGroup, role: event.target.value === "senior" ? "senior" : "resident" })}>
                      <option value="resident">מתמחה</option>
                      <option value="senior">בכיר</option>
                    </select>
                    <select value={draft.role} onChange={(event) => updateDraft(request, { role: event.target.value as AppRole })}>
                      {Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                    <label className="check"><input type="checkbox" checked={draft.canAngio} onChange={(event) => updateDraft(request, { canAngio: event.target.checked })} />אנגיו</label>
                  </div>
                ) : (
                  <div className="form-row">
                    <select value={draft.doctorId} onChange={(event) => updateDraft(request, { doctorId: event.target.value })}>
                      <option value="">בחר רופא קיים</option>
                      {matches.length ? <option disabled value="__matches">התאמות אפשריות</option> : null}
                      {matches.map((doctor) => <option key={doctor.id} value={doctor.id}>{formatDoctorOption(doctor)}</option>)}
                      {matches.length ? <option disabled value="__all">כל הרופאים</option> : null}
                      {data.doctors.filter((doctor) => !matches.some((match) => match.id === doctor.id)).map((doctor) => <option key={doctor.id} value={doctor.id}>{formatDoctorOption(doctor)}</option>)}
                    </select>
                  </div>
                )}

                <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
                  <button className="danger" onClick={() => reject(request.id)}>דחה</button>
                  <button className="primary" disabled={draft.mode === "merge" && !draft.doctorId} onClick={() => approve(request.id)}>אשר</button>
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function Doctors({
  data,
  form,
  setForm,
  expandedDoctorId,
  setExpandedDoctorId,
  usernameDrafts,
  setUsernameDrafts,
  emailDrafts,
  setEmailDrafts,
  passwordDrafts,
  setPasswordDrafts,
  roleDrafts,
  setRoleDrafts,
  nameDrafts,
  setNameDrafts,
  groupDrafts,
  setGroupDrafts,
  angioDrafts,
  setAngioDrafts,
  registrationApprovalDrafts,
  setRegistrationApprovalDrafts,
  addDoctor,
  toggleDoctor,
  saveDoctorUser,
  removeDoctor,
  approvePendingRegistration,
  rejectPendingRegistration,
  refreshFromServer,
  loadTestData
}: {
  data: WorkspaceData;
  form: { name: string; group: Doctor["group"]; canAngio: boolean };
  setForm: (value: { name: string; group: Doctor["group"]; canAngio: boolean }) => void;
  expandedDoctorId: string | null;
  setExpandedDoctorId: (value: string | null) => void;
  usernameDrafts: Record<string, string>;
  setUsernameDrafts: (value: Record<string, string>) => void;
  emailDrafts: Record<string, string>;
  setEmailDrafts: (value: Record<string, string>) => void;
  passwordDrafts: Record<string, string>;
  setPasswordDrafts: (value: Record<string, string>) => void;
  roleDrafts: Record<string, AppRole>;
  setRoleDrafts: (value: Record<string, AppRole>) => void;
  nameDrafts: Record<string, string>;
  setNameDrafts: (value: Record<string, string>) => void;
  groupDrafts: Record<string, DoctorGroup>;
  setGroupDrafts: (value: Record<string, DoctorGroup>) => void;
  angioDrafts: Record<string, boolean>;
  setAngioDrafts: (value: Record<string, boolean>) => void;
  registrationApprovalDrafts: Record<string, RegistrationApprovalDraft>;
  setRegistrationApprovalDrafts: (value: Record<string, RegistrationApprovalDraft>) => void;
  addDoctor: () => void;
  toggleDoctor: (doctorId: string) => void;
  saveDoctorUser: (doctorId: string) => void;
  removeDoctor: (doctorId: string) => void;
  approvePendingRegistration: (requestId: string) => void;
  rejectPendingRegistration: (requestId: string) => void;
  refreshFromServer: () => void;
  loadTestData?: () => void;
}) {
  const pendingRegistrationRequests = data.registrationRequests.filter((request) => request.status === "pending");
  return (
    <section className="panel">
      <div className="toolbar">
        <h2>רופאים ומשתמשים</h2>
        <span>{data.doctors.length} רשומות</span>
        <span>{pendingRegistrationRequests.length} בקשות ממתינות</span>
        <button onClick={refreshFromServer}>רענן מהשרת</button>
        {loadTestData && (
          <button onClick={loadTestData} style={{ background: "#f0fdf4", borderColor: "#bbf7d0", color: "#166534" }}>
            טען 20 רופאי בדיקה ומשתמש mais
          </button>
        )}
      </div>
      <PendingRegistrationRequests
        data={data}
        requests={pendingRegistrationRequests}
        drafts={registrationApprovalDrafts}
        setDrafts={setRegistrationApprovalDrafts}
        approve={approvePendingRegistration}
        reject={rejectPendingRegistration}
      />
      <div className="form-row doctor-add-row">
        <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="שם רופא" />
        <select value={form.group} onChange={(event) => setForm({ ...form, group: event.target.value as Doctor["group"] })}><option value="resident">מתמחה</option><option value="senior">בכיר</option></select>
        <label className="check"><input type="checkbox" checked={form.canAngio} onChange={(event) => setForm({ ...form, canAngio: event.target.checked })} />אנגיו</label>
        <button className="primary" onClick={addDoctor}>הוסף</button>
      </div>
      <div className="doctor-card-list">
        {data.doctors.map((doctor) => {
          const linkedUser = data.users.find((user) => user.doctorId === doctor.id);
          const expanded = expandedDoctorId === doctor.id;
          const displayUsername = linkedUser?.username ?? "";
          const displayCalendarEmail = linkedUser?.email ?? "";
          const username = usernameDrafts[doctor.id] ?? displayUsername;
          const calendarEmail = emailDrafts[doctor.id] ?? displayCalendarEmail;
          const password = passwordDrafts[doctor.id] ?? "";
          const appRole = roleDrafts[doctor.id] ?? linkedUser?.role ?? (doctor.group === "senior" ? "senior" : "resident");
          const drName = nameDrafts[doctor.id] ?? doctor.name;
          const drGroup = groupDrafts[doctor.id] ?? doctor.group;
          const drCanAngio = angioDrafts[doctor.id] ?? doctor.canAngio;
          
          return (
            <article className={`doctor-card ${expanded ? "expanded" : ""}`} key={doctor.id} onClick={() => setExpandedDoctorId(expanded ? null : doctor.id)}>
              <div className="doctor-card-main">
                <span>
                  <b>{doctor.name}</b>
                  <small>{doctor.group === "resident" ? "מתמחה" : "בכיר"}{doctor.canAngio ? " · אנגיו" : ""}{displayUsername ? ` · שם משתמש: ${displayUsername}` : ""}</small>
                </span>
                <div className="row-actions">
                  <button onClick={(event) => { event.stopPropagation(); toggleDoctor(doctor.id); }}>{doctor.active ? "פעיל" : "לא פעיל"}</button>
                  <button className="danger" onClick={(event) => { event.stopPropagation(); removeDoctor(doctor.id); }}><Trash2 size={16} />הסר</button>
                </div>
              </div>
              {expanded ? (
                <div className="doctor-edit" onClick={(event) => event.stopPropagation()} style={{ display: "grid", gridTemplateColumns: "1fr", gap: "16px" }}>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "12px" }}>
                    <h3 style={{ gridColumn: "1 / -1", margin: "0 0 -4px", fontSize: "14px", color: "var(--muted)" }}>פרטי רופא</h3>
                    <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>שם מלא של הרופא
                      <input value={drName} onChange={(event) => setNameDrafts({ ...nameDrafts, [doctor.id]: event.target.value })} placeholder="שם רופא" />
                    </label>
                    <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>סוג
                      <select value={drGroup} onChange={(event) => setGroupDrafts({ ...groupDrafts, [doctor.id]: event.target.value as DoctorGroup })}><option value="resident">מתמחה</option><option value="senior">בכיר</option></select>
                    </label>
                    <label className="check" style={{ alignSelf: "end", minHeight: "38px" }}>
                      <input type="checkbox" checked={drCanAngio} onChange={(event) => setAngioDrafts({ ...angioDrafts, [doctor.id]: event.target.checked })} />מורשה אנגיו
                    </label>
                  </div>
                  
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "12px", borderTop: "1px dashed var(--line)", paddingTop: "12px" }}>
                    <h3 style={{ gridColumn: "1 / -1", margin: "0 0 -4px", fontSize: "14px", color: "var(--muted)" }}>פרטי כניסה והרשאות מערכת</h3>
                    <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>שם משתמש
                      <input dir="ltr" value={username} onChange={(event) => setUsernameDrafts({ ...usernameDrafts, [doctor.id]: event.target.value })} placeholder="שם משתמש" />
                    </label>
                    <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>סיסמה חדשה
                      <input type="password" dir="ltr" value={password} onChange={(event) => setPasswordDrafts({ ...passwordDrafts, [doctor.id]: event.target.value })} placeholder="השאר ריק לשמירה על הקודמת" />
                    </label>
                    <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>הרשאה במערכת
                      <select value={appRole} onChange={(event) => setRoleDrafts({ ...roleDrafts, [doctor.id]: event.target.value as AppRole })}>{Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
                    </label>
                    <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>Calendar Gmail
                      <input dir="ltr" value={calendarEmail} onChange={(event) => setEmailDrafts({ ...emailDrafts, [doctor.id]: event.target.value })} placeholder="doctor@gmail.com" />
                    </label>
                  </div>
                  
                  <div style={{ display: "flex", justifyContent: "flex-end", borderTop: "1px solid var(--line)", paddingTop: "12px", marginTop: "4px" }}>
                    <button className="primary" onClick={() => saveDoctorUser(doctor.id)}>שמור שינויים</button>
                  </div>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
function AuditPanel({ entries, activeScheduleKey, doctors, roles }: { entries: AuditEntry[]; activeScheduleKey: string; doctors: Doctor[]; roles: Role[] }) {
  const doctorById = new Map(doctors.map((doctor) => [doctor.id, doctor.name]));
  const roleByCode = new Map(roles.map((role) => [role.code, role.name]));
  const visible = entries.filter((entry) => isAuditEntryVisibleForSchedule(entry, activeScheduleKey));
  const formatDate = (date: string | undefined) => date ? date.split("-").reverse().join("/") : "";
  function fallbackDetails(entry: AuditEntry): PublishedChangeDetails | null {
    const before = entry.before as { assignment?: Assignment | null; request?: ChangeRequest; changeCode?: string } | null;
    const after = entry.after as { assignment?: Assignment | null; request?: ChangeRequest; changeCode?: string } | null;
    const request = after?.request ?? before?.request;
    const code = entry.changeCode ?? after?.changeCode ?? before?.changeCode ?? "";
    const date = entry.date ?? request?.date;
    const roleCode = entry.roleCode ?? request?.roleCode;
    if (!date || !roleCode) return null;
    return {
      kind: entry.changeKind ?? request?.changeKind ?? "handoff",
      code,
      reason: request?.reason ?? "",
      status: entry.action === "published-swap-approved" ? "approved" : "direct",
      source: {
        date: request?.sourceDate ?? date,
        roleCode: request?.sourceRoleCode ?? roleCode,
        doctorId: request?.sourceDoctorId ?? before?.assignment?.doctorId ?? request?.currentDoctorId ?? null
      },
      target: {
        date,
        roleCode,
        doctorId: request?.currentDoctorId ?? before?.assignment?.doctorId ?? null
      },
      result: {
        sourceDoctorId: request?.changeKind === "exchange" ? request.currentDoctorId : null,
        targetDoctorId: after?.assignment?.doctorId ?? request?.proposedDoctorId ?? null
      }
    };
  }
  return (
    <section className="panel">
      <div className="toolbar"><h2>יומן פעולות</h2><span>{visible.length} שינויים אחרי פרסום · {activeScheduleKey}</span></div>
      <div className="list audit-list schedule-audit">
        {visible.length === 0 ? <div className="list-row">אין עדיין שינויי שיבוץ אחרי פרסום לחודש {activeScheduleKey}.</div> : null}
        {visible.map((entry) => {
          const details = entry.changeDetails ?? fallbackDetails(entry);
          if (!details) return null;
          const sourceDoctor = doctorById.get(details.source.doctorId ?? "") ?? "לא שובץ";
          const targetDoctor = doctorById.get(details.target.doctorId ?? "") ?? "לא שובץ";
          const resultSourceDoctor = doctorById.get(details.result.sourceDoctorId ?? "") ?? "לא שובץ";
          const resultTargetDoctor = doctorById.get(details.result.targetDoctorId ?? "") ?? "לא שובץ";
          const sourceRole = roleByCode.get(details.source.roleCode) ?? details.source.roleCode;
          const targetRole = roleByCode.get(details.target.roleCode) ?? details.target.roleCode;
          const statusLabel = details.status === "approved" ? "אושר והוחל" : details.status === "requested" ? "בקשה נשלחה" : "בוצע ישירות";
          return (
            <article className="audit-change-card" key={entry.id}>
              <header className="audit-change-header">
                <div>
                  <b>{details.kind === "exchange" ? "החלפה" : "מסירה"}</b>
                  <small>{statusLabel}</small>
                </div>
                <div>
                  <b>{entry.actorName || entry.actorEmail}</b>
                  <small>{entry.displayTime}</small>
                </div>
              </header>
              <div className={`audit-change-flow ${details.kind}`}>
                <div className="audit-change-person">
                  <b>{sourceDoctor}</b>
                  <small>{formatDate(details.source.date)} · {sourceRole}</small>
                </div>
                <div className="audit-change-arrows">
                  <span>{details.kind === "exchange" ? "⇄" : "←"}</span>
                  {details.kind === "exchange" ? <small>החלפה דו-כיוונית</small> : <small>מסירה ללא החזרה</small>}
                </div>
                <div className="audit-change-person">
                  <b>{targetDoctor}</b>
                  <small>{formatDate(details.target.date)} · {targetRole}</small>
                </div>
              </div>
              <div className="audit-change-result">
                {details.kind === "exchange" ? (
                  <>
                    <span>{resultTargetDoctor} מקבל/ת את {targetRole}</span>
                    <span>{resultSourceDoctor} מקבל/ת את {sourceRole}</span>
                  </>
                ) : (
                  <span>{resultTargetDoctor} מקבל/ת את {targetRole} בתאריך {formatDate(details.target.date)}</span>
                )}
              </div>
              {details.reason ? <small className="audit-change-reason">סיבה: {details.reason}</small> : null}
              {entry.snapshotUrl && (
                <small style={{ marginTop: "4px" }}>
                  <a href={entry.snapshotUrl} target="_blank" rel="noreferrer" style={{ color: "var(--blue)", textDecoration: "underline" }}>
                    הצג צילום מסך ישן מ-Google Drive
                  </a>
                </small>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function DrivePanel({
  data,
  busy,
  syncState,
  retrySave,
  loadFromServer,
  actorRole,
  handleLogout
}: {
  data: WorkspaceData;
  busy: boolean;
  syncState: SyncState;
  retrySave: () => void;
  loadFromServer: () => void;
  actorRole: AppRole | null;
  handleLogout: () => void;
}) {
  const credentials = getLocalCredentials();
  const saveLabel = syncState.lastSaveError ? "נסה לשמור שוב" : syncState.isSavePending || syncState.isSaving ? "שמור עכשיו" : "שמור שינויים לשרת";
  
  return (
    <section className="panel">
      <div className="toolbar">
        <h2>חיבור וסנכרון לשרת</h2>
        <span>מחובר כ-{roleLabels[actorRole || "resident"]}</span>
      </div>
      <div className="drive-grid" style={{ gridTemplateColumns: "1fr auto auto auto", gap: "10px" }}>
        <label>כתובת שרת Apps Script
          <input dir="ltr" value={getWebAppUrl()} disabled placeholder="https://script.google.com/macros/s/..." />
        </label>
        <button onClick={handleLogout} className="danger" style={{ alignSelf: "end" }}><Mail size={17} />התנתק</button>
        
        <button
          className="primary"
          style={{ alignSelf: "end" }}
          onClick={retrySave}
          disabled={busy || syncState.isSaving}
        >
          <Save size={17} />{syncState.isSaving ? "שומר..." : saveLabel}
        </button>
        
        <button
          style={{ alignSelf: "end" }}
          onClick={loadFromServer}
          disabled={busy}
        >
          <RefreshCw size={17} />טען מחדש מהשרת
        </button>
      </div>
      <div className="list">
        <div className="list-row"><span>שם משתמש מחובר</span><b dir="ltr">{credentials.username}</b></div>
        <div className="list-row"><span>כתובת שרת</span><b dir="ltr" className="truncate">{getWebAppUrl()}</b></div>
        <div className="list-row"><span>עדכון מקומי אחרון</span><b>{data.updatedAt ? new Date(data.updatedAt).toLocaleString("he-IL") : "טרם נשמר"}</b></div>
        <div className="list-row"><span>שמירה אחרונה לשרת</span><b>{syncState.lastSavedAt ? new Date(syncState.lastSavedAt).toLocaleString("he-IL") : "טרם נשמר בסשן הזה"}</b></div>
        {syncState.lastSaveError ? <div className="list-row error"><span>שגיאת שמירה</span><b>{syncState.lastSaveError}</b></div> : null}
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
