import type { Doctor, Role, RoleCode } from "@/types";

export const ROLE_CODES = {
  RESIDENT_ON_CALL: "resident-on-call",
  SENIOR_A: "senior-a",
  ANGIO: "angio",
  HALF_RESIDENT: "half-resident",
  HALF_SENIOR: "half-senior",
  FRIDAY_MORNING_RESIDENT: "friday-morning-resident"
} as const satisfies Record<string, RoleCode>;

export const roles: Role[] = [
  { code: ROLE_CODES.RESIDENT_ON_CALL, name: "תורן", color: "#dc2626", eligibilityRule: "resident-only", order: 1 },
  { code: ROLE_CODES.SENIOR_A, name: "כונן", color: "#2563eb", eligibilityRule: "senior-only", order: 2 },
  { code: ROLE_CODES.ANGIO, name: "כונן אנגיו", color: "#ca8a04", eligibilityRule: "angio-only", order: 3 },
  { code: ROLE_CODES.HALF_RESIDENT, name: "תורן חצי מתמחה", color: "#ea580c", eligibilityRule: "resident-then-senior", order: 4 },
  { code: ROLE_CODES.HALF_SENIOR, name: "תורן חצי מומחה", color: "#9333ea", eligibilityRule: "senior-then-resident", order: 5 },
  { code: ROLE_CODES.FRIDAY_MORNING_RESIDENT, name: "שישי בוקר מתמחה", color: "#64748b", eligibilityRule: "resident-only", order: 6 }
];

export const pendingLabels = ["ממתין", "טרם שובץ", "לא שובץ", "Pending"];

export function createId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

export function cellKey(date: string, roleCode: RoleCode) {
  return `${date}|${roleCode}`;
}

export function isFridayOnlyRole(roleCode: RoleCode) {
  return roleCode === ROLE_CODES.FRIDAY_MORNING_RESIDENT;
}

export function isDoctorEligibleForRole(doctor: Doctor, role: Role) {
  if (!doctor.active) return false;
  switch (role.eligibilityRule) {
    case "resident-only":
      return doctor.group === "resident";
    case "senior-only":
      return doctor.group === "senior";
    case "angio-only":
      return doctor.canAngio;
    case "resident-then-senior":
    case "senior-then-resident":
      return true;
  }
}

export function doctorSortForRole(role: Role) {
  return (a: Doctor, b: Doctor) => {
    if (role.eligibilityRule === "resident-then-senior" && a.group !== b.group) {
      return a.group === "resident" ? -1 : 1;
    }
    if (role.eligibilityRule === "senior-then-resident" && a.group !== b.group) {
      return a.group === "senior" ? -1 : 1;
    }
    return a.name.localeCompare(b.name, "he");
  };
}
