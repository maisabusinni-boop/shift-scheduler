import { createId } from "@/domain";
import type { AppRole, AppUser, Doctor, DoctorGroup, RegistrationRequest, WorkspaceData } from "@/types";

export type RegistrationSubmission = {
  doctorName: string;
  gmail?: string;
  username: string;
  passwordHash: string;
};

export type ApproveRegistrationAsNewInput = {
  requestId: string;
  group: DoctorGroup;
  role: AppRole;
  canAngio: boolean;
  decidedByUserId: string | null;
};

export type ApproveRegistrationAsMergeInput = {
  requestId: string;
  doctorId: string;
  decidedByUserId: string | null;
};

export function normalizeRegistrationSubmission(input: RegistrationSubmission): RegistrationSubmission {
  return {
    doctorName: input.doctorName.trim(),
    gmail: (input.gmail ?? "").trim().toLowerCase(),
    username: input.username.trim().toLowerCase(),
    passwordHash: input.passwordHash
  };
}

export function validateRegistrationSubmission(input: RegistrationSubmission, requests: RegistrationRequest[]) {
  const normalized = normalizeRegistrationSubmission(input);
  if (!normalized.doctorName) throw new Error("Doctor name is required.");
  if (!normalized.username) throw new Error("Username is required.");
  if (!normalized.passwordHash) throw new Error("Password is required.");
  if (normalized.gmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized.gmail)) {
    throw new Error("Invalid Gmail address.");
  }
  const duplicatePending = requests.some((request) => request.status === "pending" && request.username === normalized.username);
  if (duplicatePending) throw new Error("A pending request already exists for this username.");
  return normalized;
}

export function createRegistrationRequest(input: RegistrationSubmission, requests: RegistrationRequest[], now = new Date().toISOString()): RegistrationRequest {
  const normalized = validateRegistrationSubmission(input, requests);
  return {
    id: createId("reg"),
    doctorName: normalized.doctorName,
    gmail: normalized.gmail ?? "",
    username: normalized.username,
    passwordHash: normalized.passwordHash,
    status: "pending",
    createdAt: now,
    decidedAt: null,
    decidedByUserId: null,
    resolutionNote: ""
  };
}

export function findLikelyRegistrationMatches(data: WorkspaceData, request: RegistrationRequest) {
  const normalizedName = normalizeDoctorName(request.doctorName);
  const normalizedGmail = request.gmail.trim().toLowerCase();
  const normalizedUsername = request.username.trim().toLowerCase();
  return data.doctors.filter((doctor) => {
    const linkedUser = data.users.find((user) => user.doctorId === doctor.id);
    return normalizeDoctorName(doctor.name) === normalizedName ||
      (normalizedGmail && linkedUser?.email?.toLowerCase() === normalizedGmail) ||
      (normalizedUsername && linkedUser?.username?.toLowerCase() === normalizedUsername);
  });
}

export function approveRegistrationAsNew(data: WorkspaceData, input: ApproveRegistrationAsNewInput, now = new Date().toISOString()): WorkspaceData {
  const request = getPendingRequest(data, input.requestId);
  const doctor: Doctor = {
    id: createId("doctor"),
    name: request.doctorName,
    group: input.group,
    canAngio: input.canAngio,
    active: true
  };
  const user: AppUser = {
    id: createId("user"),
    username: request.username,
    email: request.gmail || `${request.username}@local`,
    name: request.doctorName,
    role: input.role,
    doctorId: doctor.id,
    active: true,
    createdAt: now,
    passwordHash: request.passwordHash
  };

  return {
    ...data,
    doctors: [...data.doctors, doctor],
    users: [...data.users, user],
    registrationRequests: resolveRegistrationRequest(data.registrationRequests, request.id, "approved", input.decidedByUserId, "created-new", now),
    updatedAt: now
  };
}

export function approveRegistrationAsMerge(data: WorkspaceData, input: ApproveRegistrationAsMergeInput, now = new Date().toISOString()): WorkspaceData {
  const request = getPendingRequest(data, input.requestId);
  const doctor = data.doctors.find((candidate) => candidate.id === input.doctorId);
  if (!doctor) throw new Error("Doctor was not found.");
  const existingUser = data.users.find((user) => user.doctorId === input.doctorId);
  const nextUser: AppUser = existingUser ? {
    ...existingUser,
    username: request.username,
    email: request.gmail || existingUser.email || `${request.username}@local`,
    name: request.doctorName || existingUser.name,
    active: true,
    passwordHash: request.passwordHash
  } : {
    id: createId("user"),
    username: request.username,
    email: request.gmail || `${request.username}@local`,
    name: request.doctorName || doctor.name,
    role: doctor.group === "senior" ? "senior" : "resident",
    doctorId: doctor.id,
    active: true,
    createdAt: now,
    passwordHash: request.passwordHash
  };

  return {
    ...data,
    users: existingUser
      ? data.users.map((user) => user.id === existingUser.id ? nextUser : user)
      : [...data.users, nextUser],
    registrationRequests: resolveRegistrationRequest(data.registrationRequests, request.id, "approved", input.decidedByUserId, "merged-existing", now),
    updatedAt: now
  };
}

export function rejectRegistrationRequest(data: WorkspaceData, requestId: string, decidedByUserId: string | null, now = new Date().toISOString()): WorkspaceData {
  getPendingRequest(data, requestId);
  return {
    ...data,
    registrationRequests: resolveRegistrationRequest(data.registrationRequests, requestId, "rejected", decidedByUserId, "rejected", now),
    updatedAt: now
  };
}

function getPendingRequest(data: WorkspaceData, requestId: string) {
  const request = data.registrationRequests.find((candidate) => candidate.id === requestId);
  if (!request) throw new Error("Registration request was not found.");
  if (request.status !== "pending") throw new Error("Registration request is already resolved.");
  return request;
}

function resolveRegistrationRequest(
  requests: RegistrationRequest[],
  requestId: string,
  status: RegistrationRequest["status"],
  decidedByUserId: string | null,
  resolutionNote: string,
  now: string
) {
  return requests.map((request) => request.id === requestId ? {
    ...request,
    status,
    decidedAt: now,
    decidedByUserId,
    resolutionNote
  } : request);
}

function normalizeDoctorName(value: string) {
  return value.replace(/^ד["״']?ר\s*/, "").trim().toLowerCase();
}
