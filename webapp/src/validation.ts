import { cellKey, isDoctorEligibleForRole, isFridayOnlyRole, ROLE_CODES } from "@/domain";
import { nextDayKey, previousDayKey } from "@/month";
import type { Doctor, MonthSchedule, Role, ValidationIssue } from "@/types";

function issue(message: string, severity: ValidationIssue["severity"], date?: string, roleCode?: Role["code"]): ValidationIssue {
  return {
    id: `${severity}-${date ?? "global"}-${roleCode ?? "all"}-${message}`,
    severity,
    message,
    date,
    roleCode,
    cellKey: date && roleCode ? cellKey(date, roleCode) : undefined
  };
}

function allowedDuplicate(first: Role["code"], second: Role["code"]) {
  const pair = new Set([first, second]);
  return pair.has(ROLE_CODES.SENIOR_A) && pair.has(ROLE_CODES.FRIDAY_MORNING_SENIOR);
}

export function validateSchedule(schedule: MonthSchedule, roles: Role[], doctors: Doctor[]) {
  const issues: ValidationIssue[] = [];
  const roleByCode = new Map(roles.map((role) => [role.code, role]));
  const doctorById = new Map(doctors.map((doctor) => [doctor.id, doctor]));
  const assignedByDate = new Map<string, Array<{ role: Role; doctor: Doctor }>>();
  const exclusionKeys = new Set<string>();

  schedule.exclusions.forEach((exclusion) => {
    exclusionKeys.add(`${exclusion.date}|${exclusion.roleCode ?? "*"}|${exclusion.doctorId}`);
  });

  Object.entries(schedule.assignments).forEach(([key, assignment]) => {
    const [date, roleCodeRaw] = key.split("|");
    const roleCode = roleCodeRaw as Role["code"];
    const role = roleByCode.get(roleCode);
    const doctor = assignment.doctorId ? doctorById.get(assignment.doctorId) : null;
    if (!role) return;

    const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
    if (isFridayOnlyRole(role.code) && weekday !== 5 && assignment.doctorId) {
      issues.push(issue(`${role.name} זמין רק בימי שישי.`, "error", date, role.code));
    }

    if (!doctor || assignment.pending) return;

    if (!isDoctorEligibleForRole(doctor, role)) {
      issues.push(issue(`${doctor.name} לא מתאים/ה לתפקיד ${role.name}.`, "error", date, role.code));
    }

    if (exclusionKeys.has(`${date}|*|${doctor.id}`) || exclusionKeys.has(`${date}|${role.code}|${doctor.id}`)) {
      issues.push(issue(`${doctor.name} חסום/ה בתאריך הזה עבור ${role.name}.`, "error", date, role.code));
    }

    const list = assignedByDate.get(date) ?? [];
    list.push({ role, doctor });
    assignedByDate.set(date, list);
  });

  assignedByDate.forEach((items, date) => {
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        if (items[i].doctor.id !== items[j].doctor.id) continue;
        if (allowedDuplicate(items[i].role.code, items[j].role.code)) continue;
        issues.push(issue(`${items[i].doctor.name} מופיע/ה פעמיים באותו יום.`, "error", date, items[j].role.code));
      }
    }
  });

  Object.entries(schedule.assignments).forEach(([key, assignment]) => {
    if (!assignment.doctorId || assignment.pending) return;
    const [date, roleCodeRaw] = key.split("|");
    const roleCode = roleCodeRaw as Role["code"];
    const role = roleByCode.get(roleCode);
    const doctor = doctorById.get(assignment.doctorId);
    if (!role || !doctor) return;

    const previous = schedule.assignments[cellKey(previousDayKey(date), roleCode)];
    if (previous?.doctorId === assignment.doctorId && !previous.pending) {
      if (role.code === ROLE_CODES.RESIDENT_ON_CALL || role.code === ROLE_CODES.HALF_SENIOR) {
        issues.push(issue(`${doctor.name} משובץ/ת יומיים ברצף ב-${role.name}.`, "error", date, role.code));
      }
      if (role.code === ROLE_CODES.HALF_RESIDENT) {
        issues.push(issue(`${doctor.name} משובץ/ת ברצף ב-${role.name}; נדרש אישור ידני.`, "warning", date, role.code));
      }
    }
  });

  Object.entries(schedule.assignments).forEach(([key, assignment]) => {
    if (!assignment.doctorId || assignment.pending) return;
    const [date, roleCodeRaw] = key.split("|");
    const roleCode = roleCodeRaw as Role["code"];
    if (roleCode !== ROLE_CODES.SENIOR_A) return;
    const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
    if (weekday !== 5) return;

    const fridaySenior = schedule.assignments[cellKey(date, ROLE_CODES.FRIDAY_MORNING_SENIOR)];
    const saturdayHalf = schedule.assignments[cellKey(nextDayKey(date), ROLE_CODES.HALF_SENIOR)];
    const doctor = doctorById.get(assignment.doctorId);
    if (fridaySenior?.doctorId && fridaySenior.doctorId !== assignment.doctorId) {
      issues.push(issue("כונן א ושישי בוקר מומחה חייבים להיות אותו מומחה.", "error", date, ROLE_CODES.FRIDAY_MORNING_SENIOR));
    }
    if (saturdayHalf?.doctorId && saturdayHalf.doctorId !== assignment.doctorId) {
      issues.push(issue("כונן א ביום שישי ושבת חצי מומחה חייבים להיות אותו מומחה.", "error", nextDayKey(date), ROLE_CODES.HALF_SENIOR));
    }
    if (doctor && (!fridaySenior?.doctorId || !saturdayHalf?.doctorId)) {
      issues.push(issue(`${doctor.name} שובץ/ה בכונן א ביום שישי; כדאי להשלים את שלישיית שישי-שבת.`, "warning", date, ROLE_CODES.SENIOR_A));
    }
  });

  return issues;
}
