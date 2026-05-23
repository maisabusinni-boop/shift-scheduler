import { useEffect, useMemo, useState, type ElementType } from "react";
import {
  CalendarCheck,
  Cloud,
  Download,
  FileJson,
  FileWarning,
  FolderOpen,
  LayoutDashboard,
  ListChecks,
  Plus,
  RefreshCw,
  Save,
  Settings,
  Table2,
  Upload,
  Users
} from "lucide-react";
import { buildCalendarPreview, normalizeCalendarId } from "@/calendar";
import { cellKey, createId, doctorSortForRole, isDoctorEligibleForRole, isFridayOnlyRole, ROLE_CODES } from "@/domain";
import {
  connectGoogleDrive,
  createDriveWorkspaceFile,
  extractDriveFileId,
  getDriveFileMetadata,
  hasDriveToken,
  loadWorkspaceFromDrive,
  saveWorkspaceToDrive
} from "@/googleDrive";
import { buildMonthDays, monthKey, nextDayKey } from "@/month";
import { getInstallPrompt, isStandaloneMode, subscribeInstallPrompt } from "@/pwaInstall";
import { addPublishSnapshot, cloneWorkspace, ensureSchedule } from "@/sampleData";
import {
  downloadCsv,
  downloadJson,
  loadGoogleClientId,
  loadLocalWorkspace,
  saveGoogleClientId,
  saveLocalWorkspace
} from "@/storage";
import type { Assignment, Doctor, MonthSchedule, Role, RoleCode, WorkspaceData } from "@/types";
import { validateSchedule } from "@/validation";
import "./styles.css";

type TabId = "dashboard" | "roster" | "exclusions" | "doctors" | "review" | "drive" | "calendar" | "settings";

const tabs: Array<{ id: TabId; label: string; icon: ElementType }> = [
  { id: "dashboard", label: "לוח בקרה", icon: LayoutDashboard },
  { id: "roster", label: "שיבוץ", icon: Table2 },
  { id: "exclusions", label: "אילוצים", icon: FileWarning },
  { id: "doctors", label: "רופאים ותפקידים", icon: Users },
  { id: "review", label: "בדיקה ופרסום", icon: ListChecks },
  { id: "drive", label: "Drive Sync", icon: Cloud },
  { id: "calendar", label: "יומן Google", icon: CalendarCheck },
  { id: "settings", label: "הגדרות / יבוא", icon: Settings }
];

const current = new Date();

export function App() {
  const [data, setData] = useState<WorkspaceData>(() => loadLocalWorkspace());
  const [year, setYear] = useState(current.getFullYear());
  const [month, setMonth] = useState(current.getMonth() + 1);
  const [tab, setTab] = useState<TabId>("roster");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [focusCell, setFocusCell] = useState<string | null>(null);
  const [clientId, setClientId] = useState(() => loadGoogleClientId());
  const [driveFileInput, setDriveFileInput] = useState("");
  const [calendarInput, setCalendarInput] = useState(data.calendar.calendarInput);
  const [installAvailable, setInstallAvailable] = useState(() => Boolean(getInstallPrompt()));
  const [doctorForm, setDoctorForm] = useState({ name: "", group: "resident" as Doctor["group"], canAngio: false });
  const [exclusionForm, setExclusionForm] = useState({ doctorId: "", roleCode: "", reason: "" });
  const [selectedDates, setSelectedDates] = useState<string[]>([]);
  const [importText, setImportText] = useState("");

  const key = monthKey(year, month);
  const workspace = useMemo(() => ensureSchedule(data, year, month), [data, year, month]);
  const schedule = workspace.schedules[key];
  const days = useMemo(() => buildMonthDays(year, month), [year, month]);
  const doctorById = useMemo(() => new Map(workspace.doctors.map((doctor) => [doctor.id, doctor])), [workspace.doctors]);
  const roleByCode = useMemo(() => new Map(workspace.roles.map((role) => [role.code, role])), [workspace.roles]);

  useEffect(() => {
    if (workspace !== data) {
      setAndPersist(workspace);
    }
  }, [workspace, data]);

  useEffect(() => {
    return subscribeInstallPrompt(() => setInstallAvailable(Boolean(getInstallPrompt())));
  }, []);

  function setAndPersist(next: WorkspaceData) {
    saveLocalWorkspace(next);
    setData(next);
  }

  function mutate(mutator: (draft: WorkspaceData, schedule: MonthSchedule) => void, note?: string) {
    const draft = ensureSchedule(cloneWorkspace(data), year, month);
    mutator(draft, draft.schedules[key]);
    draft.updatedAt = new Date().toISOString();
    setAndPersist(draft);
    if (note) setMessage(note);
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

  function updateAssignment(date: string, roleCode: RoleCode, value: string) {
    mutate((draft, currentSchedule) => {
      const assignment: Assignment = value === "__pending" || !value ? { doctorId: null, pending: value === "__pending" } : { doctorId: value, pending: false };
      currentSchedule.assignments[cellKey(date, roleCode)] = assignment;

      const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
      if ((roleCode === ROLE_CODES.SENIOR_A || roleCode === ROLE_CODES.FRIDAY_MORNING_SENIOR) && weekday === 5) {
        currentSchedule.assignments[cellKey(date, ROLE_CODES.SENIOR_A)] = assignment;
        currentSchedule.assignments[cellKey(date, ROLE_CODES.FRIDAY_MORNING_SENIOR)] = assignment;
        currentSchedule.assignments[cellKey(nextDayKey(date), ROLE_CODES.HALF_SENIOR)] = assignment;
      }

      currentSchedule.validation.stale = true;
    }, "נשמר מקומית.");
  }

  function validateCurrent() {
    mutate((draft, currentSchedule) => {
      currentSchedule.validation = {
        checkedAt: new Date().toISOString(),
        stale: false,
        issues: validateSchedule(currentSchedule, draft.roles, draft.doctors)
      };
    }, "הבדיקה הושלמה.");
  }

  function publishCurrent() {
    const issues = validateSchedule(schedule, workspace.roles, workspace.doctors);
    if (issues.some((issue) => issue.severity === "error")) {
      mutate((draft, currentSchedule) => {
        currentSchedule.validation = { checkedAt: new Date().toISOString(), stale: false, issues };
      }, "אי אפשר לפרסם לפני תיקון שגיאות.");
      return;
    }
    mutate((draft, currentSchedule) => {
      currentSchedule.validation = { checkedAt: new Date().toISOString(), stale: false, issues };
      currentSchedule.status = "published";
      addPublishSnapshot(currentSchedule);
    }, "החודש פורסם.");
  }

  function unpublishCurrent() {
    mutate((_draft, currentSchedule) => {
      currentSchedule.status = "draft";
    }, "החודש הוחזר לטיוטה.");
  }

  async function dryRunCalendar() {
    const preview = await buildCalendarPreview(schedule, workspace.roles, workspace);
    mutate((draft) => {
      draft.calendar.calendarInput = calendarInput;
      draft.calendar.calendarId = normalizeCalendarId(calendarInput);
      draft.calendar.lastDryRun = preview;
    }, "תצוגת יומן נוצרה.");
  }

  async function mockCalendarSync() {
    if (schedule.status !== "published") {
      setMessage("טיוטה לא מסתנכרנת ליומן.");
      return;
    }
    const preview = await buildCalendarPreview(schedule, workspace.roles, workspace);
    mutate((draft, currentSchedule) => {
      draft.calendar.calendarInput = calendarInput;
      draft.calendar.calendarId = normalizeCalendarId(calendarInput);
      draft.calendar.lastDryRun = preview;
      preview.forEach((event) => {
        draft.calendar.syncRecords[event.assignmentKey] = {
          assignmentKey: event.assignmentKey,
          eventId: event.eventId,
          hash: event.hash,
          lastSyncedAt: new Date().toISOString()
        };
      });
      currentSchedule.lastSyncedAt = new Date().toISOString();
    }, "סנכרון יומן מדומה נרשם.");
  }

  const counts = useMemo(() => {
    const assigned = Object.values(schedule.assignments).filter((assignment) => assignment.doctorId && !assignment.pending).length;
    const pending = workspace.roles.length * days.length - assigned;
    const errors = schedule.validation.issues.filter((issue) => issue.severity === "error").length;
    const warnings = schedule.validation.issues.filter((issue) => issue.severity === "warning").length;
    return { assigned, pending, errors, warnings };
  }, [schedule, days.length, workspace.roles.length]);

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <h1>{workspace.workspace.name}</h1>
          <p>Chrome-only · שמירה מקומית · סנכרון ידני עם Google Drive</p>
        </div>
        <div className="month-controls">
          <input type="number" value={month} min={1} max={12} onChange={(event) => setMonth(Number(event.target.value))} />
          <input type="number" value={year} min={2020} max={2100} onChange={(event) => setYear(Number(event.target.value))} />
          <span className={`status ${schedule.status}`}>{schedule.status === "published" ? "פורסם" : "טיוטה"}</span>
        </div>
      </header>

      <nav className="tabs">
        {tabs.map((item) => {
          const Icon = item.icon;
          return (
            <button key={item.id} className={`tab ${tab === item.id ? "active" : ""}`} onClick={() => setTab(item.id)}>
              <Icon size={17} />
              {item.label}
            </button>
          );
        })}
      </nav>

      {message ? <div className="notice">{message}</div> : null}

      {tab === "dashboard" && (
        <Dashboard
          schedule={schedule}
          counts={counts}
          driveName={workspace.driveSync.fileName}
          validateCurrent={validateCurrent}
          publishCurrent={publishCurrent}
          unpublishCurrent={unpublishCurrent}
          installAvailable={installAvailable}
          installApp={async () => {
            const prompt = getInstallPrompt();
            if (!prompt) {
              setMessage("אם כפתור התקנה לא מופיע, פתח את תפריט Chrome ובחר Install app / Create shortcut.");
              return;
            }
            await prompt.prompt();
            const choice = await prompt.userChoice;
            setInstallAvailable(Boolean(getInstallPrompt()));
            setMessage(choice.outcome === "accepted" ? "האפליקציה הותקנה כאייקון." : "ההתקנה בוטלה.");
          }}
        />
      )}
      {tab === "roster" && (
        <Roster
          schedule={schedule}
          roles={workspace.roles}
          doctors={workspace.doctors}
          days={days}
          focusCell={focusCell}
          updateAssignment={updateAssignment}
        />
      )}
      {tab === "exclusions" && (
        <Exclusions
          schedule={schedule}
          doctors={workspace.doctors}
          roles={workspace.roles}
          days={days}
          form={exclusionForm}
          setForm={setExclusionForm}
          selectedDates={selectedDates}
          setSelectedDates={setSelectedDates}
          addExclusions={() => {
            if (!exclusionForm.doctorId || !selectedDates.length) {
              setMessage("צריך לבחור רופא ותאריך אחד לפחות.");
              return;
            }
            mutate((_draft, currentSchedule) => {
              selectedDates.forEach((date) => {
                currentSchedule.exclusions.push({
                  id: createId("exclusion"),
                  doctorId: exclusionForm.doctorId,
                  date,
                  roleCode: (exclusionForm.roleCode || null) as RoleCode | null,
                  reason: exclusionForm.reason
                });
              });
              currentSchedule.validation.stale = true;
            }, "האילוצים נוספו.");
            setSelectedDates([]);
            setExclusionForm({ doctorId: "", roleCode: "", reason: "" });
          }}
          deleteExclusion={(id) =>
            mutate((_draft, currentSchedule) => {
              currentSchedule.exclusions = currentSchedule.exclusions.filter((exclusion) => exclusion.id !== id);
              currentSchedule.validation.stale = true;
            }, "האילוץ נמחק.")
          }
        />
      )}
      {tab === "doctors" && (
        <Doctors
          data={workspace}
          form={doctorForm}
          setForm={setDoctorForm}
          addDoctor={() => {
            if (!doctorForm.name.trim()) {
              setMessage("צריך שם רופא.");
              return;
            }
            mutate((draft) => {
              draft.doctors.push({
                id: createId("doctor"),
                name: doctorForm.name.trim(),
                group: doctorForm.group,
                canAngio: doctorForm.canAngio,
                active: true
              });
            }, "הרופא נוסף.");
            setDoctorForm({ name: "", group: "resident", canAngio: false });
          }}
          toggleDoctor={(doctorId) =>
            mutate((draft, currentSchedule) => {
              const doctor = draft.doctors.find((candidate) => candidate.id === doctorId);
              if (doctor) doctor.active = !doctor.active;
              currentSchedule.validation.stale = true;
            }, "עודכן.")
          }
        />
      )}
      {tab === "review" && (
        <Review
          schedule={schedule}
          counts={counts}
          validateCurrent={validateCurrent}
          publishCurrent={publishCurrent}
          setFocusCell={(cell) => {
            setFocusCell(cell);
            setTab("roster");
          }}
        />
      )}
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
        />
      )}
      {tab === "calendar" && (
        <CalendarPanel
          data={workspace}
          schedule={schedule}
          calendarInput={calendarInput}
          setCalendarInput={setCalendarInput}
          dryRunCalendar={() => run(dryRunCalendar)}
          mockCalendarSync={() => run(mockCalendarSync)}
        />
      )}
      {tab === "settings" && (
        <SettingsPanel
          data={workspace}
          scheduleKey={key}
          importText={importText}
          setImportText={setImportText}
          importJson={() => {
            try {
              const parsed = JSON.parse(importText) as WorkspaceData;
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
    </main>
  );
}

function Dashboard({
  schedule,
  counts,
  driveName,
  validateCurrent,
  publishCurrent,
  unpublishCurrent,
  installAvailable,
  installApp
}: {
  schedule: MonthSchedule;
  counts: { assigned: number; pending: number; errors: number; warnings: number };
  driveName: string;
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
        <button onClick={validateCurrent}>בדוק וסמן בעיות</button>
        <button onClick={publishCurrent}>פרסם חודש</button>
        <button onClick={unpublishCurrent}>החזר לטיוטה</button>
        <button onClick={installApp}>התקן כאייקון Chrome</button>
      </div>
    </section>
  );
}

function InfoCell({ label, value, tone }: { label: string; value: string; tone?: "good" | "warn" | "bad" }) {
  return (
    <div className={`info-cell ${tone ?? ""}`}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function Roster({
  schedule,
  roles,
  doctors,
  days,
  focusCell,
  updateAssignment
}: {
  schedule: MonthSchedule;
  roles: Role[];
  doctors: Doctor[];
  days: ReturnType<typeof buildMonthDays>;
  focusCell: string | null;
  updateAssignment: (date: string, roleCode: RoleCode, value: string) => void;
}) {
  const issueByCell = new Map(schedule.validation.issues.map((issue) => [issue.cellKey, issue.severity]));

  return (
    <section className="panel">
      <div className="toolbar">
        <h2>שיבוץ חודשי</h2>
        <span>{schedule.validation.stale ? "צריך בדיקה" : "בדיקה עדכנית"}</span>
      </div>
      <div className="board-wrap">
        <table className="roster-table">
          <thead>
            <tr>
              <th className="sticky-date">תאריך</th>
              {roles.map((role) => (
                <th key={role.code}>
                  <span className="role-title">
                    <i style={{ background: role.color }} />
                    {role.name}
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
                {roles.map((role) => {
                  const key = cellKey(day.key, role.code);
                  const assignment = schedule.assignments[key] ?? { doctorId: null, pending: false };
                  const disabled = isFridayOnlyRole(role.code) && !day.isFriday;
                  const issue = issueByCell.get(key);
                  const options = doctors.filter((doctor) => isDoctorEligibleForRole(doctor, role)).sort(doctorSortForRole(role));
                  return (
                    <td
                      key={role.code}
                      id={`cell-${key}`}
                      className={`${disabled ? "disabled" : ""} ${issue ?? ""} ${focusCell === key ? "focused" : ""}`}
                    >
                      {disabled ? (
                        <span className="blocked-cell">לא פעיל</span>
                      ) : (
                        <select value={assignment.pending ? "__pending" : assignment.doctorId ?? ""} onChange={(event) => updateAssignment(day.key, role.code, event.target.value)}>
                          <option value="">לא שובץ</option>
                          <option value="__pending">ממתין</option>
                          {options.map((doctor) => (
                            <option key={doctor.id} value={doctor.id}>
                              {doctor.group === "resident" ? "מתמחה · " : "בכיר · "}
                              {doctor.name}
                              {doctor.canAngio ? " · אנגיו" : ""}
                            </option>
                          ))}
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
  doctors,
  roles,
  days,
  form,
  setForm,
  selectedDates,
  setSelectedDates,
  addExclusions,
  deleteExclusion
}: {
  schedule: MonthSchedule;
  doctors: Doctor[];
  roles: Role[];
  days: ReturnType<typeof buildMonthDays>;
  form: { doctorId: string; roleCode: string; reason: string };
  setForm: (value: { doctorId: string; roleCode: string; reason: string }) => void;
  selectedDates: string[];
  setSelectedDates: (dates: string[]) => void;
  addExclusions: () => void;
  deleteExclusion: (id: string) => void;
}) {
  return (
    <section className="panel two">
      <div>
        <div className="toolbar">
          <h2>אילוצים</h2>
          <button className="primary" onClick={addExclusions}>
            <Plus size={17} />
            הוסף חסימה
          </button>
        </div>
        <div className="form-row">
          <select value={form.doctorId} onChange={(event) => setForm({ ...form, doctorId: event.target.value })}>
            <option value="">בחר רופא</option>
            {doctors.map((doctor) => (
              <option key={doctor.id} value={doctor.id}>
                {doctor.name}
              </option>
            ))}
          </select>
          <select value={form.roleCode} onChange={(event) => setForm({ ...form, roleCode: event.target.value })}>
            <option value="">כל היום</option>
            {roles.map((role) => (
              <option key={role.code} value={role.code}>
                {role.name}
              </option>
            ))}
          </select>
          <input value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} placeholder="סיבה / הערה" />
        </div>
        <div className="month-picker">
          {days.map((day) => {
            const active = selectedDates.includes(day.key);
            return (
              <button
                key={day.key}
                className={active ? "selected" : ""}
                onClick={() => setSelectedDates(active ? selectedDates.filter((date) => date !== day.key) : [...selectedDates, day.key])}
              >
                <b>{day.day}</b>
                <span>{day.weekdayLabel}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="list">
        {schedule.exclusions.map((exclusion) => {
          const doctor = doctors.find((candidate) => candidate.id === exclusion.doctorId);
          const role = roles.find((candidate) => candidate.code === exclusion.roleCode);
          return (
            <div className="list-row" key={exclusion.id}>
              <span>
                {doctor?.name ?? "רופא לא ידוע"} · {exclusion.date} · {role?.name ?? "כל היום"}
                {exclusion.reason ? <small> · {exclusion.reason}</small> : null}
              </span>
              <button onClick={() => deleteExclusion(exclusion.id)}>מחק</button>
            </div>
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
  addDoctor,
  toggleDoctor
}: {
  data: WorkspaceData;
  form: { name: string; group: Doctor["group"]; canAngio: boolean };
  setForm: (value: { name: string; group: Doctor["group"]; canAngio: boolean }) => void;
  addDoctor: () => void;
  toggleDoctor: (doctorId: string) => void;
}) {
  return (
    <section className="panel two">
      <div>
        <h2>רופאים</h2>
        <div className="form-row">
          <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="שם רופא" />
          <select value={form.group} onChange={(event) => setForm({ ...form, group: event.target.value as Doctor["group"] })}>
            <option value="resident">מתמחה</option>
            <option value="senior">בכיר</option>
          </select>
          <label className="check">
            <input type="checkbox" checked={form.canAngio} onChange={(event) => setForm({ ...form, canAngio: event.target.checked })} />
            אנגיו
          </label>
          <button className="primary" onClick={addDoctor}>הוסף</button>
        </div>
        <div className="list">
          {data.doctors.map((doctor) => (
            <div className="list-row" key={doctor.id}>
              <span>{doctor.name} · {doctor.group === "resident" ? "מתמחה" : "בכיר"} {doctor.canAngio ? "· אנגיו" : ""}</span>
              <button onClick={() => toggleDoctor(doctor.id)}>{doctor.active ? "פעיל" : "לא פעיל"}</button>
            </div>
          ))}
        </div>
      </div>
      <div>
        <h2>תפקידים</h2>
        <div className="list">
          {data.roles.map((role) => (
            <div className="list-row" key={role.code}>
              <span><i className="dot" style={{ background: role.color }} />{role.name}</span>
              <small>{role.eligibilityRule}</small>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Review({
  schedule,
  counts,
  validateCurrent,
  publishCurrent,
  setFocusCell
}: {
  schedule: MonthSchedule;
  counts: { errors: number; warnings: number };
  validateCurrent: () => void;
  publishCurrent: () => void;
  setFocusCell: (cell: string) => void;
}) {
  return (
    <section className="panel">
      <div className="toolbar">
        <h2>בדיקה ופרסום</h2>
        <div className="actions">
          <button onClick={validateCurrent}>בדוק עכשיו</button>
          <button className="primary" disabled={counts.errors > 0 && !schedule.validation.stale} onClick={publishCurrent}>פרסם חודש</button>
        </div>
      </div>
      <div className="status-grid compact">
        <InfoCell label="שגיאות" value={String(counts.errors)} tone={counts.errors ? "bad" : "good"} />
        <InfoCell label="אזהרות" value={String(counts.warnings)} tone={counts.warnings ? "warn" : "good"} />
        <InfoCell label="בדיקה" value={schedule.validation.checkedAt ? new Date(schedule.validation.checkedAt).toLocaleString("he-IL") : "טרם נבדק"} />
        <InfoCell label="גרסאות פרסום" value={String(schedule.publishSnapshots.length)} />
      </div>
      <div className="list">
        {schedule.validation.issues.length === 0 ? <div className="list-row">אין בעיות שמורות.</div> : null}
        {schedule.validation.issues.map((issue) => (
          <button key={issue.id} className={`issue-row ${issue.severity}`} onClick={() => issue.cellKey && setFocusCell(issue.cellKey)}>
            <span>{issue.severity === "error" ? "שגיאה" : "אזהרה"}</span>
            <b>{issue.message}</b>
            <small>{issue.cellKey ?? ""}</small>
          </button>
        ))}
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
  setAndPersist
}: {
  data: WorkspaceData;
  clientId: string;
  setClientId: (value: string) => void;
  driveFileInput: string;
  setDriveFileInput: (value: string) => void;
  busy: boolean;
  run: (action: () => Promise<void>, note?: string) => Promise<void>;
  setAndPersist: (data: WorkspaceData) => void;
}) {
  async function connect() {
    await connectGoogleDrive(clientId);
    saveGoogleClientId(clientId);
  }

  return (
    <section className="panel">
      <div className="toolbar">
        <h2>Google Drive Sync</h2>
        <span>{hasDriveToken() ? "מחובר" : "לא מחובר"}</span>
      </div>
      <div className="drive-grid">
        <label>
          Google OAuth Client ID
          <input dir="ltr" value={clientId} onChange={(event) => setClientId(event.target.value)} placeholder="xxx.apps.googleusercontent.com" />
        </label>
        <button onClick={() => run(connect, "Google Drive מחובר.")} disabled={busy}>
          <Cloud size={17} />
          התחבר
        </button>
        <label>
          Drive file URL / ID
          <input dir="ltr" value={driveFileInput} onChange={(event) => setDriveFileInput(event.target.value)} placeholder="https://drive.google.com/file/d/..." />
        </label>
        <button
          onClick={() =>
            run(async () => {
              const fileId = extractDriveFileId(driveFileInput);
              const { data: loaded, metadata } = await loadWorkspaceFromDrive(fileId);
              loaded.driveSync = {
                ...loaded.driveSync,
                fileId: metadata.id,
                fileName: metadata.name,
                fileUrl: metadata.webViewLink ?? null,
                lastLoadedModifiedTime: metadata.modifiedTime,
                lastSavedModifiedTime: metadata.modifiedTime
              };
              setAndPersist(loaded);
            }, "נטען מ-Google Drive.")
          }
          disabled={busy}
        >
          <FolderOpen size={17} />
          פתח
        </button>
        <button
          onClick={() =>
            run(async () => {
              const metadata = await createDriveWorkspaceFile(data);
              setAndPersist({
                ...data,
                driveSync: {
                  ...data.driveSync,
                  fileId: metadata.id,
                  fileName: metadata.name,
                  fileUrl: metadata.webViewLink ?? null,
                  lastLoadedModifiedTime: metadata.modifiedTime,
                  lastSavedModifiedTime: metadata.modifiedTime
                }
              });
            }, "נוצר קובץ Drive חדש.")
          }
          disabled={busy}
        >
          <FileJson size={17} />
          צור קובץ
        </button>
        <button
          className="primary"
          onClick={() =>
            run(async () => {
              if (!data.driveSync.fileId) throw new Error("אין קובץ Drive מחובר.");
              const remote = await getDriveFileMetadata(data.driveSync.fileId);
              if (data.driveSync.lastLoadedModifiedTime && remote.modifiedTime !== data.driveSync.lastLoadedModifiedTime) {
                const overwrite = window.confirm("הקובץ ב-Drive השתנה מאז הטעינה האחרונה. להחליף אותו בכל זאת?");
                if (!overwrite) return;
              }
              const metadata = await saveWorkspaceToDrive(data.driveSync.fileId, data);
              setAndPersist({
                ...data,
                driveSync: {
                  ...data.driveSync,
                  fileName: metadata.name,
                  fileUrl: metadata.webViewLink ?? data.driveSync.fileUrl,
                  lastLoadedModifiedTime: metadata.modifiedTime,
                  lastSavedModifiedTime: metadata.modifiedTime
                }
              });
            }, "נשמר ל-Google Drive.")
          }
          disabled={busy}
        >
          <Save size={17} />
          שמור ל-Drive
        </button>
        <button
          onClick={() =>
            run(async () => {
              if (!data.driveSync.fileId) throw new Error("אין קובץ Drive מחובר.");
              const { data: loaded, metadata } = await loadWorkspaceFromDrive(data.driveSync.fileId);
              loaded.driveSync = {
                ...loaded.driveSync,
                fileId: metadata.id,
                fileName: metadata.name,
                fileUrl: metadata.webViewLink ?? null,
                lastLoadedModifiedTime: metadata.modifiedTime,
                lastSavedModifiedTime: metadata.modifiedTime
              };
              setAndPersist(loaded);
            }, "רוענן מ-Google Drive.")
          }
          disabled={busy}
        >
          <RefreshCw size={17} />
          טען מ-Drive
        </button>
      </div>
      <div className="list">
        <div className="list-row"><span>קובץ</span><b dir="ltr">{data.driveSync.fileName}</b></div>
        <div className="list-row"><span>File ID</span><b dir="ltr">{data.driveSync.fileId ?? "לא נוצר"}</b></div>
        <div className="list-row"><span>שמירה אחרונה</span><b>{data.driveSync.lastSavedModifiedTime ? new Date(data.driveSync.lastSavedModifiedTime).toLocaleString("he-IL") : "טרם נשמר"}</b></div>
      </div>
    </section>
  );
}

function CalendarPanel({
  data,
  schedule,
  calendarInput,
  setCalendarInput,
  dryRunCalendar,
  mockCalendarSync
}: {
  data: WorkspaceData;
  schedule: MonthSchedule;
  calendarInput: string;
  setCalendarInput: (value: string) => void;
  dryRunCalendar: () => void;
  mockCalendarSync: () => void;
}) {
  return (
    <section className="panel">
      <div className="toolbar">
        <h2>יומן Google</h2>
        <span>{schedule.status === "published" ? "מוכן לסנכרון" : "טיוטה לא מסתנכרנת"}</span>
      </div>
      <div className="form-row">
        <input dir="ltr" value={calendarInput} onChange={(event) => setCalendarInput(event.target.value)} placeholder="Shared Calendar URL or Calendar ID" />
        <button onClick={dryRunCalendar}>Dry run</button>
        <button className="primary" onClick={mockCalendarSync}>Mock sync</button>
      </div>
      <div className="list">
        <div className="list-row"><span>Calendar ID</span><b dir="ltr">{normalizeCalendarId(calendarInput) || "לא הוגדר"}</b></div>
        <div className="list-row"><span>אירועים בתצוגה</span><b>{data.calendar.lastDryRun.length}</b></div>
      </div>
      <pre className="codebox">{JSON.stringify(data.calendar.lastDryRun, null, 2)}</pre>
    </section>
  );
}

function SettingsPanel({
  data,
  scheduleKey,
  importText,
  setImportText,
  importJson,
  exportJson,
  exportCsv
}: {
  data: WorkspaceData;
  scheduleKey: string;
  importText: string;
  setImportText: (value: string) => void;
  importJson: () => void;
  exportJson: () => void;
  exportCsv: () => void;
}) {
  return (
    <section className="panel two">
      <div>
        <h2>יבוא / יצוא</h2>
        <textarea value={importText} onChange={(event) => setImportText(event.target.value)} placeholder="הדבק JSON מלא לטעינה" />
        <div className="actions">
          <button onClick={importJson}><Upload size={17} />ייבא JSON</button>
          <button onClick={exportJson}><Download size={17} />ייצא JSON</button>
          <button onClick={exportCsv}><Download size={17} />ייצא CSV</button>
        </div>
      </div>
      <div className="list">
        <div className="list-row"><span>Schema</span><b>{data.schemaVersion}</b></div>
        <div className="list-row"><span>חודש פעיל</span><b>{scheduleKey}</b></div>
        <div className="list-row"><span>עודכן מקומית</span><b>{new Date(data.updatedAt).toLocaleString("he-IL")}</b></div>
      </div>
    </section>
  );
}
