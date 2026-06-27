import {
  cellKey,
  exclusionRoleCodesForAssignment,
  isDoctorEligibleForRole,
  isFridayOnlyRole,
  ROLE_CODES
} from "@/domain";
import { nextDayKey, previousDayKey, type MonthDay } from "@/month";
import type { AppRole, Assignment, Doctor, MonthSchedule, Role, RoleCode } from "@/types";

const priorityRoles: RoleCode[] = [
  ROLE_CODES.ANGIO,
  ROLE_CODES.SENIOR_A,
  ROLE_CODES.FRIDAY_MORNING_SENIOR,
  ROLE_CODES.SENIOR_B,
  ROLE_CODES.FRIDAY_MORNING_RESIDENT,
  ROLE_CODES.RESIDENT_ON_CALL,
  ROLE_CODES.HALF_SENIOR,
  ROLE_CODES.HALF_RESIDENT
];

export type AutoScheduleOptions = {
  role?: AppRole | null;
};

export function autoScheduleRoleCodes(role: AppRole | null | undefined): RoleCode[] {
  if (role === "chief-resident") {
    return [
      ROLE_CODES.RESIDENT_ON_CALL,
      ROLE_CODES.HALF_RESIDENT,
      ROLE_CODES.FRIDAY_MORNING_RESIDENT
    ];
  }
  if (role === "senior-planner") {
    return [
      ROLE_CODES.SENIOR_A,
      ROLE_CODES.SENIOR_B,
      ROLE_CODES.ANGIO,
      ROLE_CODES.FRIDAY_MORNING_SENIOR,
      ROLE_CODES.HALF_SENIOR
    ];
  }
  return [];
}

export function generateAutoRoster(schedule: MonthSchedule, roles: Role[], doctors: Doctor[], days: MonthDay[], options: AutoScheduleOptions = {}) {
  const allowedRoleCodes = new Set(autoScheduleRoleCodes(options.role));
  const activeDoctors = doctors.filter((doctor) => doctor.active);
  const newAssignments: Record<string, Assignment> = { ...schedule.assignments };
  const doctorAssignmentCounts: Record<string, number> = {};
  activeDoctors.forEach((doctor) => {
    doctorAssignmentCounts[doctor.id] = 0;
  });
  Object.values(newAssignments).forEach((assignment) => {
    if (!assignment.doctorId || assignment.pending || !(assignment.doctorId in doctorAssignmentCounts)) return;
    doctorAssignmentCounts[assignment.doctorId]++;
  });

  const roleByCode = new Map(roles.map((role) => [role.code, role]));
  const dayByKey = new Map(days.map((day) => [day.key, day]));
  const dayKeys = new Set(days.map((day) => day.key));
  const exclusionsSet = new Set<string>();
  schedule.exclusions.forEach((exclusion) => {
    exclusionsSet.add(`${exclusion.date}|${exclusion.roleCode ?? "*"}|${exclusion.doctorId}`);
  });

  function isAssignedOnDate(doctorId: string, dateStr: string, exceptRoleCode?: RoleCode) {
    return Object.entries(newAssignments).some(([key, assignment]) => {
      const [assignmentDate, assignmentRoleCode] = key.split("|") as [string, RoleCode];
      return assignmentDate === dateStr &&
        assignmentRoleCode !== exceptRoleCode &&
        assignment.doctorId === doctorId &&
        !isAllowedFridaySeniorDuplicate(dateStr, exceptRoleCode, assignmentRoleCode);
    });
  }

  function getAssignedDoctor(dateStr: string, roleCode: RoleCode) {
    return newAssignments[cellKey(dateStr, roleCode)]?.doctorId ?? null;
  }

  function isCellOccupied(dateStr: string, roleCode: RoleCode) {
    const assignment = newAssignments[cellKey(dateStr, roleCode)];
    return Boolean(assignment?.doctorId || assignment?.pending);
  }

  function isDoctorExcluded(dateStr: string, roleCode: RoleCode, doctorId: string) {
    return exclusionsSet.has(`${dateStr}|*|${doctorId}`) ||
      exclusionRoleCodesForAssignment(roleCode).some((candidate) => exclusionsSet.has(`${dateStr}|${candidate}|${doctorId}`));
  }

  function isAllowedFridaySeniorDuplicate(dateStr: string, roleCode: RoleCode | undefined, assignedRoleCode: RoleCode) {
    const weekday = new Date(`${dateStr}T00:00:00.000Z`).getUTCDay();
    if (weekday !== 5) return false;
    const linkedRoles = new Set<RoleCode>([ROLE_CODES.SENIOR_A, ROLE_CODES.FRIDAY_MORNING_SENIOR]);
    return Boolean(roleCode && linkedRoles.has(roleCode) && linkedRoles.has(assignedRoleCode));
  }

  function wouldBreakConsecutiveRule(dateStr: string, roleCode: RoleCode, doctorId: string) {
    const previous = newAssignments[cellKey(previousDayKey(dateStr), roleCode)];
    if (previous?.doctorId !== doctorId || previous.pending) return false;
    return roleCode === ROLE_CODES.RESIDENT_ON_CALL ||
      roleCode === ROLE_CODES.HALF_SENIOR ||
      roleCode === ROLE_CODES.HALF_RESIDENT;
  }

  function wouldBreakSundayRest(dateStr: string, doctorId: string) {
    const weekday = new Date(`${dateStr}T00:00:00.000Z`).getUTCDay();
    if (weekday !== 0) return false;
    return getAssignedDoctor(previousDayKey(previousDayKey(dateStr)), ROLE_CODES.RESIDENT_ON_CALL) === doctorId;
  }

  function canUseDoctor(dateStr: string, roleCode: RoleCode, doctor: Doctor) {
    const role = roleByCode.get(roleCode);
    const day = dayByKey.get(dateStr);
    if (!role || !day) return false;
    if (!allowedRoleCodes.has(roleCode)) return false;
    if (isCellOccupied(dateStr, roleCode)) return false;
    if (isFridayOnlyRole(roleCode) && !day.allowsFridayRoles) return false;
    if (roleCode === ROLE_CODES.HALF_SENIOR && doctor.group !== "senior") return false;
    if (!isDoctorEligibleForRole(doctor, role)) return false;
    if (isDoctorExcluded(dateStr, roleCode, doctor.id)) return false;
    if (isAssignedOnDate(doctor.id, dateStr, roleCode)) return false;
    if (wouldBreakConsecutiveRule(dateStr, roleCode, doctor.id)) return false;
    if (wouldBreakSundayRest(dateStr, doctor.id)) return false;
    return true;
  }

  function canUseFridaySeniorLink(dateStr: string, doctor: Doctor) {
    if (!canUseDoctor(dateStr, ROLE_CODES.SENIOR_A, doctor)) return false;
    if (isDoctorExcluded(dateStr, ROLE_CODES.FRIDAY_MORNING_SENIOR, doctor.id)) return false;
    const fridayMorningSenior = newAssignments[cellKey(dateStr, ROLE_CODES.FRIDAY_MORNING_SENIOR)];
    if (fridayMorningSenior?.doctorId && fridayMorningSenior.doctorId !== doctor.id) return false;

    const saturday = nextDayKey(dateStr);
    if (!dayKeys.has(saturday)) return true;
    const saturdayHalfSenior = newAssignments[cellKey(saturday, ROLE_CODES.HALF_SENIOR)];
    if (saturdayHalfSenior?.doctorId && saturdayHalfSenior.doctorId !== doctor.id) return false;
    if (isDoctorExcluded(saturday, ROLE_CODES.HALF_SENIOR, doctor.id)) return false;
    if (isAssignedOnDate(doctor.id, saturday, ROLE_CODES.HALF_SENIOR)) return false;
    if (wouldBreakConsecutiveRule(saturday, ROLE_CODES.HALF_SENIOR, doctor.id)) return false;
    return true;
  }

  function addAssignment(dateStr: string, roleCode: RoleCode, doctorId: string) {
    newAssignments[cellKey(dateStr, roleCode)] = { doctorId, pending: false };
    doctorAssignmentCounts[doctorId] = (doctorAssignmentCounts[doctorId] ?? 0) + 1;
  }

  function chooseCandidate(dateStr: string, roleCode: RoleCode, candidates: Doctor[]) {
    const weekday = new Date(`${dateStr}T00:00:00.000Z`).getUTCDay();
    if (roleCode === ROLE_CODES.FRIDAY_MORNING_SENIOR && weekday === 5) {
      const fridaySeniorA = getAssignedDoctor(dateStr, ROLE_CODES.SENIOR_A);
      const linkedDoctor = fridaySeniorA ? candidates.find((doctor) => doctor.id === fridaySeniorA) : null;
      if (linkedDoctor && canUseDoctor(dateStr, roleCode, linkedDoctor)) return linkedDoctor;
    }
    return candidates
      .filter((doctor) => roleCode === ROLE_CODES.SENIOR_A && weekday === 5
        ? canUseFridaySeniorLink(dateStr, doctor)
        : canUseDoctor(dateStr, roleCode, doctor))
      .sort((a, b) => {
        const countDelta = (doctorAssignmentCounts[a.id] ?? 0) - (doctorAssignmentCounts[b.id] ?? 0);
        if (countDelta !== 0) return countDelta;
        return a.name.localeCompare(b.name, "he");
      })[0] ?? null;
  }

  days.forEach((day) => {
    const dateStr = day.key;
    const weekday = new Date(`${dateStr}T00:00:00.000Z`).getUTCDay();

    priorityRoles.forEach((roleCode) => {
      if (!allowedRoleCodes.has(roleCode)) return;
      if (isCellOccupied(dateStr, roleCode)) return;
      const role = roleByCode.get(roleCode);
      if (!role) return;
      if (isFridayOnlyRole(roleCode) && !day.allowsFridayRoles) return;

      if (roleCode === ROLE_CODES.HALF_SENIOR && weekday === 6) {
        const fridaySeniorA = getAssignedDoctor(previousDayKey(dateStr), ROLE_CODES.SENIOR_A);
        const linkedDoctor = fridaySeniorA ? activeDoctors.find((doctor) => doctor.id === fridaySeniorA) : null;
        if (linkedDoctor && canUseDoctor(dateStr, roleCode, linkedDoctor)) {
          addAssignment(dateStr, roleCode, linkedDoctor.id);
        }
        return;
      }

      const chosen = chooseCandidate(dateStr, roleCode, activeDoctors);
      if (!chosen) return;

      addAssignment(dateStr, roleCode, chosen.id);
      if (roleCode === ROLE_CODES.SENIOR_A && weekday === 5) {
        if (allowedRoleCodes.has(ROLE_CODES.FRIDAY_MORNING_SENIOR) && !isCellOccupied(dateStr, ROLE_CODES.FRIDAY_MORNING_SENIOR)) {
          addAssignment(dateStr, ROLE_CODES.FRIDAY_MORNING_SENIOR, chosen.id);
        }
        const saturday = nextDayKey(dateStr);
        if (dayKeys.has(saturday) && allowedRoleCodes.has(ROLE_CODES.HALF_SENIOR) && !isCellOccupied(saturday, ROLE_CODES.HALF_SENIOR)) {
          addAssignment(saturday, ROLE_CODES.HALF_SENIOR, chosen.id);
        }
      }
    });
  });

  return newAssignments;
}
