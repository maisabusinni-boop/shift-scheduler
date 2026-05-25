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
  Mail,
  Plus,
  RefreshCw,
  Save,
  Settings,
  Table2,
  Trash2,
  Upload,
  UserCheck,
  Users,
  X
} from "lucide-react";
import { createAuditEntry, type ActorContext, type AuditInput } from "@/audit";
import { resolveSession, type SessionUser } from "@/auth";
import { buildCalendarPreview, normalizeCalendarId } from "@/calendar";
import { cellKey, createId, doctorSortForRole, exclusionRoleCodesForAssignment, exclusionRoles, isDoctorEligibleForRole, isFridayOnlyRole, ROLE_CODES } from "@/domain";
import {
  getWebAppUrl,
  setWebAppUrl,
  hasCredentials,
  hashPassword,
  loginWithCredentials,
  bootstrapPlanner,
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
  Role,
  RoleCode,
  WorkspaceData
} from "@/types";
import { validateSchedule } from "@/validation";
import "./styles.css";

type TabId = "published-roster" | "roster" | "exclusions" | "doctors" | "audit" | "drive" | "calendar" | "settings";
type PublishedChangeMode = "handoff" | "exchange";

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

export function App() {
  const [data, setData] = useState<WorkspaceData>(() => loadLocalWorkspace());
  const [year, setYear] = useState(current.getFullYear());
  const [month, setMonth] = useState(current.getMonth() + 1);
  const [tab, setTab] = useState<TabId>("roster");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
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
  const [calendarInput, setCalendarInput] = useState(data.calendar.calendarInput);
  const [deviceId] = useState(() => loadDeviceId());
  const [doctorForm, setDoctorForm] = useState({ name: "", group: "resident" as Doctor["group"], canAngio: false });
  const [expandedDoctorId, setExpandedDoctorId] = useState<string | null>(null);
  const [doctorUsernameDrafts, setDoctorUsernameDrafts] = useState<Record<string, string>>({});
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
    mode: PublishedChangeMode;
    date: string;
    roleCode: RoleCode;
    giverDoctorId: string;
    sourceDate?: string;
    sourceRoleCode?: RoleCode;
    targetDoctorId?: string;
  } | null>(null);
  const [swapTargetDoctorId, setSwapTargetDoctorId] = useState("");
  const [swapReason, setSwapReason] = useState("");
  const lastSavedVersionRef = useRef<string | null>(null);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const key = monthKey(year, month);
  const workspace = useMemo(() => ensureSchedule(data, year, month), [data, year, month]);
  const schedule = workspace.schedules[key];
  const days = useMemo(() => buildMonthDays(year, month), [year, month]);
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
    if (!visibleTabs.some((item) => item.id === tab)) {
      setTab(visibleTabs[0]?.id ?? "roster");
    }
  }, [tab, visibleTabs]);

  function setAndPersist(next: WorkspaceData, isSavedToServer = false) {
    saveLocalWorkspace(next);
    if (isSavedToServer) {
      lastSavedVersionRef.current = next.updatedAt;
    }
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

  useEffect(() => {
    if (hasCredentials()) {
      run(async () => {
        const remoteData = await loadWorkspace();
        lastSavedVersionRef.current = remoteData.updatedAt;
        setData(remoteData);
      }, "הנתונים נטענו מחדש מהשרת.");
    }
  }, []);

  // Debounced autosave effect
  useEffect(() => {
    if (!data || !hasCredentials()) return;
    
    if (!lastSavedVersionRef.current) {
      lastSavedVersionRef.current = data.updatedAt;
      return;
    }
    
    if (data.updatedAt === lastSavedVersionRef.current) return;
    
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    
    saveTimeoutRef.current = setTimeout(async () => {
      try {
        console.log("Autosaving changes to server...");
        const saved = await saveWorkspace(data);
        lastSavedVersionRef.current = saved.updatedAt;
        setAndPersist(saved, true);
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
      const match = data.users.find(u => u.active && (u.email ? u.email.split('@')[0] : "").toLowerCase() === currentUser.username.toLowerCase());
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
      setData(loaded);
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
      setData(result.data);
      setCurrentUser({ username: loginUsername, name: result.user.name });
      setMessage("המערכת הוקמה בהצלחה! הוגדרת כמתכנן בכיר.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "ההקמה נכשלה.");
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
        
        if (isFridayOnlyRole(roleCode) && weekday !== 5) continue;
        
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
    setBusy(true);
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
      
      const cleanUsers = nextUsers.filter(u => u.email.split('@')[0] !== "mais");
      cleanUsers.push({
        id: "user-mais",
        email: "mais@local",
        name: "מאיס",
        role: "senior-planner",
        doctorId: null,
        active: true,
        createdAt: new Date().toISOString(),
        passwordHash: hash
      });

      const updatedWorkspace = await adminSaveUsers(cleanUsers, testDoctors);
      setAndPersist(updatedWorkspace, true);
      setMessage("20 רופאי בדיקה והמשתמש mais (סיסמה: 203-mais) נטענו בהצלחה מחשבון השרת!");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "טעינת נתוני בדיקה נכשלה.");
    } finally {
      setBusy(false);
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
    
    const username = (doctorUsernameDrafts[doctorId] ?? "").trim().toLowerCase();
    const password = (doctorPasswordDrafts[doctorId] ?? "").trim();
    const appRole = doctorRoleDrafts[doctorId] ?? (newGroup === "senior" ? "senior" : "resident");
    
    const existing = workspace.users.find((user) => user.doctorId === doctorId);
    if (!username && !existing) return setMessage("צריך להזין שם משתמש לרופא.");
    if (!existing && !password) return setMessage("צריך להזין סיסמה ראשונית למשתמש חדש.");
    
    let passwordHash = existing?.passwordHash || "";
    if (password) {
      passwordHash = await hashPassword(password);
    }
    
    setBusy(true);
    try {
      const nextUsers = [...workspace.users];
      const matchIndex = nextUsers.findIndex(u => u.doctorId === doctorId);
      
      const userMail = username ? username + "@local" : (existing?.email || (newName + "@local"));
      
      if (matchIndex !== -1) {
        nextUsers[matchIndex] = {
          ...nextUsers[matchIndex],
          email: userMail,
          name: newName,
          role: appRole,
          active: true,
          passwordHash
        };
      } else {
        nextUsers.push({
          id: createId("user"),
          email: userMail,
          name: newName,
          role: appRole,
          doctorId: doctorId,
          active: true,
          createdAt: new Date().toISOString(),
          passwordHash
        });
      }
      
      const nextDoctors = [...workspace.doctors];
      const docIndex = nextDoctors.findIndex((d) => d.id === doctorId);
      if (docIndex !== -1) {
        nextDoctors[docIndex] = {
          ...nextDoctors[docIndex],
          name: newName,
          group: newGroup,
          canAngio: newCanAngio
        };
      }
      
      const updatedWorkspace = await adminSaveUsers(nextUsers, nextDoctors);
      setAndPersist(updatedWorkspace, true);
      setMessage("פרטי הרופא והמשתמש עודכנו בהצלחה בשרת.");
      
      // Clear password draft
      setDoctorPasswordDrafts(prev => ({ ...prev, [doctorId]: "" }));
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "השמירה נכשלה.");
    } finally {
      setBusy(false);
    }
  }

  function removeDoctor(doctorId: string) {
    if (!canManageUsers(role)) return setMessage("רק מתכנן בכיר יכול לנהל רופאים.");
    const doctor = workspace.doctors.find((candidate) => candidate.id === doctorId);
    if (!doctor) return;
    const confirmed = window.confirm(`להסיר את ${doctor.name}? השיבוצים והאילוצים שלו יימחקו מהנתונים המקומיים.`);
    if (!confirmed) return;
    commitChange({
      mutator: (draft) => {
        const before = {
          doctor: draft.doctors.find((candidate) => candidate.id === doctorId) ?? null,
          linkedUsers: draft.users.filter((user) => user.doctorId === doctorId),
          schedules: Object.fromEntries(Object.entries(draft.schedules).map(([scheduleKey, item]) => [scheduleKey, {
            assignments: Object.entries(item.assignments).filter(([, assignment]) => assignment.doctorId === doctorId).map(([key]) => key),
            exclusions: item.exclusions.filter((exclusion) => exclusion.doctorId === doctorId).map((exclusion) => exclusion.id)
          }]))
        };
        draft.doctors = draft.doctors.filter((candidate) => candidate.id !== doctorId);
        draft.users = draft.users.map((user) => (user.doctorId === doctorId ? { ...user, doctorId: null, active: false } : user));
        Object.values(draft.schedules).forEach((item) => {
          Object.entries(item.assignments).forEach(([assignmentKey, assignment]) => {
            if (assignment.doctorId === doctorId) item.assignments[assignmentKey] = { doctorId: null, pending: false };
          });
          item.exclusions = item.exclusions.filter((exclusion) => exclusion.doctorId !== doctorId);
          item.validation.stale = true;
        });
        draft.changeRequests = draft.changeRequests.filter((request) => (
          request.requesterDoctorId !== doctorId &&
          request.currentDoctorId !== doctorId &&
          request.proposedDoctorId !== doctorId
        ));
        return { action: "doctor-remove", entityType: "doctor", entityId: doctorId, before, after: null };
      },
      note: "הרופא הוסר."
    });
    setExpandedDoctorId((current) => (current === doctorId ? null : current));
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
      setBusy(true);
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
        setBusy(false);
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

    setBusy(true);
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
    } finally {
      setBusy(false);
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
          <input type="number" value={month} min={1} max={12} onChange={(event) => setMonth(Number(event.target.value))} />
          <input type="number" value={year} min={2020} max={2100} onChange={(event) => setYear(Number(event.target.value))} />
          <span className={`status ${schedule.status}`}>{schedule.status === "published" ? "נעול" : "טיוטה"}</span>
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

          {tab === "published-roster" && (
            canSeeSchedule(role, schedule) ? (
              <PublishedRoster
                schedule={schedule}
                roles={workspace.roles}
                doctors={workspace.doctors}
                days={days}
                role={role}
                appUser={appUser}
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
              addDoctor={addDoctor}
              toggleDoctor={toggleDoctor}
              saveDoctorUser={saveDoctorUser}
              removeDoctor={removeDoctor}
              loadTestData={loadTestData}
            />
          )}
          {tab === "audit" && <AuditPanel entries={workspace.auditLog} doctors={workspace.doctors} roles={workspace.roles} />}
          {tab === "drive" && (
            <DrivePanel
              data={workspace}
              busy={busy}
              run={run}
              setAndPersist={setAndPersist}
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
            <div className="modal-overlay" style={{
              position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
              background: "rgba(0, 0, 0, 0.4)", display: "flex",
              alignItems: "center", justifyContent: "center", zIndex: 1000
            }}>
              <div className="panel" style={{ width: "480px", padding: "24px", direction: "rtl" }}>
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
                        <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
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

                      <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
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

function formatDoctorOption(doctor: Doctor) {
  return `${doctor.group === "resident" ? "מתמחה · " : "בכיר · "}${doctor.name}${doctor.canAngio ? " · אנגיו" : ""}`;
}

function formatScheduleMonth(schedule: MonthSchedule) {
  return `${String(schedule.month).padStart(2, "0")}/${schedule.year}`;
}

function Roster({
  schedule,
  roles,
  doctors,
  days,
  counts,
  role,
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
  focusCell: string | null;
  editable: boolean;
  validateCurrent: () => void;
  publishCurrent: () => void;
  unpublishCurrent: () => void;
  setFocusCell: (cell: string) => void;
  updateAssignment: (date: string, roleCode: RoleCode, value: string) => void;
  autoSchedule: () => void;
}) {
  const issueByCell = new Map(schedule.validation.issues.map((issue) => [issue.cellKey, issue.severity]));
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
      </div>
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

function PublishedRoster({
  schedule,
  roles,
  doctors,
  days,
  role,
  appUser,
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
  changeRequests: ChangeRequest[];
  onSwapCellClick: (mode: PublishedChangeMode, date: string, roleCode: RoleCode, giverDoctorId: string, targetDoctorId?: string, sourceDate?: string, sourceRoleCode?: RoleCode) => void;
  onApproveRequest: (id: string, reason: string) => Promise<void>;
  onRejectRequest: (id: string) => void;
}) {
  const [changeMode, setChangeMode] = useState<PublishedChangeMode | null>(null);
  const [selectedExchangeCell, setSelectedExchangeCell] = useState<{ date: string; roleCode: RoleCode; doctorId: string } | null>(null);
  const [approveNotes, setApproveNotes] = useState<Record<string, string>>({});
  const [dragSource, setDragSource] = useState<{ date: string; roleCode: RoleCode; doctorId: string } | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [exchangeMessage, setExchangeMessage] = useState("");

  const pendingRequests = useMemo(() => {
    return changeRequests.filter(r => r.scheduleKey === schedule.key && r.status === "submitted");
  }, [changeRequests, schedule.key]);

  function canDragCell(assignment: Assignment): boolean {
    if (schedule.status !== "published") return false;
    if (!assignment.doctorId) return false;
    const assignedDoc = doctors.find(d => d.id === assignment.doctorId);
    if (!assignedDoc) return false;
    if (role === "senior-planner") return true;
    if (role === "senior") return assignedDoc.group === "senior";
    if (role === "resident" || role === "chief-resident") return assignedDoc.group === "resident";
    return false;
  }

  function canDropOnCell(targetDate: string, targetRoleCode: RoleCode): boolean {
    if (changeMode !== "exchange" || !dragSource) return false;
    const sourceDoc = doctors.find(d => d.id === dragSource.doctorId);
    const targetRole = roles.find(r => r.code === targetRoleCode);
    const sourceRole = roles.find(r => r.code === dragSource.roleCode);
    const targetAssignment = schedule.assignments[cellKey(targetDate, targetRoleCode)];
    const targetDoc = targetAssignment?.doctorId ? doctors.find(d => d.id === targetAssignment.doctorId) : null;
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
    const sourceDoc = doctors.find(d => d.id === source.doctorId);
    const targetAssignment = schedule.assignments[cellKey(targetDate, targetRoleCode)];
    const targetDoc = targetAssignment?.doctorId ? doctors.find(d => d.id === targetAssignment.doctorId) : null;
    const sourceRole = roles.find(r => r.code === source.roleCode);
    const targetRole = roles.find(r => r.code === targetRoleCode);
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

  return (
    <section className="panel">
      <div className="toolbar roster-toolbar">
        <div>
          <h2>לוח תורנויות מפורסם</h2>
          <span>{formatScheduleMonth(schedule)} · {schedule.status === "published" ? "מצב צפייה פעיל" : "טיוטה (קריאה בלבד)"}</span>
        </div>
        <div className="actions">
          {schedule.status === "published" && (
            <>
              <button
                className={changeMode === "handoff" ? "primary" : ""}
                onClick={() => {
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
                onClick={() => {
                  setChangeMode(changeMode === "exchange" ? null : "exchange");
                  setSelectedExchangeCell(null);
                  setDragSource(null);
                  setExchangeMessage("");
                }}
              >
                <RefreshCw size={17} />
                {changeMode === "exchange" ? "בטל החלפה" : "החלפה"}
              </button>
            </>
          )}
        </div>
      </div>

      {schedule.status === "published" && changeMode && (
        <div className="notice" style={{ background: "#eff6ff", borderColor: "#bfdbfe", color: "#1e40af", marginBottom: "12px", fontSize: "14px" }}>
          {changeMode === "handoff" ? (
            <><strong>מסירה:</strong> לחץ על תא משובץ כדי לבחור רופא שיקבל את התורנות.</>
          ) : (
            <><strong>החלפה:</strong> גרור בין שני תאים משובצים, או לחץ פעמיים על תא ראשון ואז פעמיים על תא שני.</>
          )}
          <br />
          <small>* בכירים יכולים לשנות בכירים בלבד. מתמחים שולחים בקשה לאישור צ'יף. מתכנן בכיר — גישה מלאה.</small>
          {exchangeMessage ? <><br /><small>{exchangeMessage}</small></> : null}
        </div>
      )}

      <div className="board-wrap">
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
              <tr key={day.key}>
                <th className="sticky-date">
                  <strong>{day.day}</strong>
                  <span>{day.weekdayLabel}</span>
                </th>
                {roles.map((roleItem) => {
                  const key = cellKey(day.key, roleItem.code);
                  const assignment = schedule.assignments[key] ?? { doctorId: null, pending: false };
                  const disabled = isFridayOnlyRole(roleItem.code) && !day.isFriday;
                  const assignedDoc = assignment.doctorId ? doctors.find(d => d.id === assignment.doctorId) : null;

                  const draggable = changeMode === "exchange" && !disabled && canDragCell(assignment);
                  const droppable = !disabled && canDropOnCell(day.key, roleItem.code);
                  const isOver = dragOverKey === key;
                  const usable = !disabled && canUseCell(assignment);
                  const clickable = changeMode === "handoff" && usable;
                  const selected = selectedExchangeCell?.date === day.key && selectedExchangeCell.roleCode === roleItem.code;

                  let cellStyle: React.CSSProperties = {};
                  if (selected) {
                    cellStyle = { background: "#dbeafe", border: "2px solid #2563eb", cursor: "pointer" };
                  } else if (isOver && droppable) {
                    cellStyle = { background: "#dcfce7", border: "2px dashed #16a34a", transition: "background 0.15s" };
                  } else if (isOver && dragSource && !droppable) {
                    cellStyle = { background: "#fee2e2", border: "2px dashed #dc2626", transition: "background 0.15s" };
                  } else if (draggable) {
                    cellStyle = { cursor: "grab" };
                  } else if (clickable) {
                    cellStyle = { cursor: "pointer", background: "#f0f9ff", border: "1.5px dashed #0284c7" };
                  }

                  return (
                    <td
                      key={roleItem.code}
                      className={disabled ? "disabled" : ""}
                      style={cellStyle}
                      onClick={() => {
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
                          {clickable && (
                            <span style={{ fontSize: "10px", color: "#0284c7" }}>לחץ למסירה</span>
                          )}
                          {changeMode === "exchange" && usable && !draggable && (
                            <span style={{ fontSize: "10px", color: "#0284c7" }}>לחץ פעמיים</span>
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
      </div>

      {canReviewRequests(role) && (
        <div style={{ marginTop: "32px", borderTop: "1px solid var(--line)", paddingTop: "20px" }}>
          <h3>בקשות החלפה והעברת תורנויות הממתינות לאישור</h3>
          {pendingRequests.length === 0 ? (
            <p style={{ color: "var(--muted)", fontSize: "14px" }}>אין בקשות תלויות ועומדות לאישור בחודש זה.</p>
          ) : (
            <div className="list" style={{ marginTop: "12px" }}>
              {pendingRequests.map((req) => {
                const requesterDoc = doctors.find(d => d.id === req.requesterDoctorId);
                const currentDoc = doctors.find(d => d.id === req.currentDoctorId);
                const proposedDoc = doctors.find(d => d.id === req.proposedDoctorId);
                const roleObj = roles.find(r => r.code === req.roleCode);
                
                const [y, m, d] = req.date.split("-");
                const formattedDate = `${d}/${m}/${y}`;

                return (
                  <div className="list-row tall" key={req.id} style={{ borderLeft: "4px solid var(--blue)" }}>
                    <span>
                      <strong>העברת תורנות ({roleObj?.name}) בתאריך {formattedDate}</strong>
                      <small style={{ fontSize: "13px", marginTop: "4px", color: "var(--ink)" }}>
                        רופא רשום: <strong>{currentDoc?.name ?? "לא שובץ"}</strong> ➔ מחליף מוצע: <strong>{proposedDoc?.name ?? "ללא"}</strong>
                      </small>
                      <small style={{ marginTop: "2px" }}>
                        הוגש ע"י: {requesterDoc?.name} (תפקיד: {roleLabels[req.requesterRole]})
                        {req.reason && ` · סיבה: "${req.reason}"`}
                      </small>
                    </span>
                    <div className="row-actions" style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                      <input 
                        type="text" 
                        placeholder="הערה לאישור (אופציונלי)..." 
                        value={approveNotes[req.id] ?? ""} 
                        onChange={(e) => setApproveNotes({ ...approveNotes, [req.id]: e.target.value })}
                        style={{ minHeight: "34px", fontSize: "13px", width: "180px" }}
                      />
                      <button 
                        className="primary" 
                        style={{ minHeight: "34px", background: "var(--good)", borderColor: "var(--good)" }}
                        onClick={() => onApproveRequest(req.id, approveNotes[req.id] ?? "")}
                      >
                        <Check size={16} />
                        אשר
                      </button>
                      <button 
                        className="danger" 
                        style={{ minHeight: "34px" }}
                        onClick={() => onRejectRequest(req.id)}
                      >
                        <X size={16} />
                        דחה
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}function Doctors({
  data,
  form,
  setForm,
  expandedDoctorId,
  setExpandedDoctorId,
  usernameDrafts,
  setUsernameDrafts,
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
  addDoctor,
  toggleDoctor,
  saveDoctorUser,
  removeDoctor,
  loadTestData
}: {
  data: WorkspaceData;
  form: { name: string; group: Doctor["group"]; canAngio: boolean };
  setForm: (value: { name: string; group: Doctor["group"]; canAngio: boolean }) => void;
  expandedDoctorId: string | null;
  setExpandedDoctorId: (value: string | null) => void;
  usernameDrafts: Record<string, string>;
  setUsernameDrafts: (value: Record<string, string>) => void;
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
  addDoctor: () => void;
  toggleDoctor: (doctorId: string) => void;
  saveDoctorUser: (doctorId: string) => void;
  removeDoctor: (doctorId: string) => void;
  loadTestData?: () => void;
}) {
  return (
    <section className="panel">
      <div className="toolbar">
        <h2>רופאים ומשתמשים</h2>
        <span>{data.doctors.length} רשומות</span>
        {loadTestData && (
          <button onClick={loadTestData} style={{ background: "#f0fdf4", borderColor: "#bbf7d0", color: "#166534" }}>
            טען 20 רופאי בדיקה ומשתמש mais
          </button>
        )}
      </div>
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
          const displayUsername = linkedUser?.email ? linkedUser.email.split('@')[0] : "";
          const username = usernameDrafts[doctor.id] ?? displayUsername;
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
function AuditPanel({ entries, doctors, roles }: { entries: AuditEntry[]; doctors: Doctor[]; roles: Role[] }) {
  const doctorById = new Map(doctors.map((doctor) => [doctor.id, doctor.name]));
  const roleByCode = new Map(roles.map((role) => [role.code, role.name]));
  const visible = entries.filter((entry) => 
    entry.action === "request-apply-to-schedule" ||
    entry.action === "published-swap-direct" ||
    entry.action === "published-swap-approved"
  );
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
      <div className="toolbar"><h2>יומן פעולות</h2><span>{visible.length} שינויים אחרי פרסום</span></div>
      <div className="list audit-list schedule-audit">
        {visible.length === 0 ? <div className="list-row">אין עדיין שינויי שיבוץ אחרי פרסום.</div> : null}
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
  run,
  setAndPersist,
  actorRole,
  handleLogout
}: {
  data: WorkspaceData;
  busy: boolean;
  run: (action: () => Promise<void>, note?: string) => Promise<void>;
  setAndPersist: (data: WorkspaceData, isSavedToServer?: boolean) => void;
  actorRole: AppRole | null;
  handleLogout: () => void;
}) {
  const credentials = getLocalCredentials();
  
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
          onClick={() => run(async () => {
            const remote = await loadWorkspace();
            const remoteChanged = data.updatedAt && remote.updatedAt !== data.updatedAt;
            if (remoteChanged) {
              if (actorRole !== "senior-planner") throw new Error("הקובץ בשרת השתנה. טען מחדש או בקש מהמתכנן הבכיר להכריע.");
              const overwrite = window.confirm("הקובץ בשרת השתנה מאז הטעינה האחרונה. להחליף אותו בכל זאת? מומלץ קודם לייצא גיבוי.");
              if (!overwrite) return;
            }
            const saved = await saveWorkspace(data);
            setAndPersist(saved, true);
          }, "הנתונים נשמרו בהצלחה בשרת.")}
          disabled={busy}
        >
          <Save size={17} />שמור שינויים לשרת
        </button>
        
        <button
          style={{ alignSelf: "end" }}
          onClick={() => run(async () => {
            const loaded = await loadWorkspace();
            setAndPersist(loaded, true);
          }, "הנתונים רועננו מהשרת.")}
          disabled={busy}
        >
          <RefreshCw size={17} />טען מחדש מהשרת
        </button>
      </div>
      <div className="list">
        <div className="list-row"><span>שם משתמש מחובר</span><b dir="ltr">{credentials.username}</b></div>
        <div className="list-row"><span>כתובת שרת</span><b dir="ltr" className="truncate">{getWebAppUrl()}</b></div>
        <div className="list-row"><span>עדכון אחרון בשרת</span><b>{data.updatedAt ? new Date(data.updatedAt).toLocaleString("he-IL") : "טרם נשמר"}</b></div>
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
