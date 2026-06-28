import { migrateWorkspace } from "@/migration";
import type { WorkspaceData, AppUser, Doctor, RegistrationRequest, MutationCommand, MutationResponse } from "@/types";

let webAppUrl = localStorage.getItem("department-shift-scheduler.webapp-url") || "https://script.google.com/macros/s/AKfycbzrLQhlCihebMkFfj0PeWdVUUsheh78UgmqdMkL8kPAvsJuTR5B8h9MkIS3Bc_tJEneNw/exec";
let loggedInUsername = localStorage.getItem("department-shift-scheduler.username") || "";
let loggedInPasswordHash = localStorage.getItem("department-shift-scheduler.password-hash") || "";

export function getWebAppUrl() {
  return webAppUrl;
}

export function setWebAppUrl(url: string) {
  webAppUrl = url.trim();
  localStorage.setItem("department-shift-scheduler.webapp-url", webAppUrl);
}

export function setLocalCredentials(username: string, passwordHash: string) {
  loggedInUsername = username.trim().toLowerCase();
  loggedInPasswordHash = passwordHash;
  localStorage.setItem("department-shift-scheduler.username", loggedInUsername);
  localStorage.setItem("department-shift-scheduler.password-hash", passwordHash);
}

export function clearLocalCredentials() {
  loggedInUsername = "";
  loggedInPasswordHash = "";
  localStorage.removeItem("department-shift-scheduler.username");
  localStorage.removeItem("department-shift-scheduler.password-hash");
}

export function getLocalCredentials() {
  return { username: loggedInUsername, passwordHash: loggedInPasswordHash };
}

export function hasCredentials() {
  return Boolean(webAppUrl && loggedInUsername && loggedInPasswordHash);
}

export async function hashPassword(password: string): Promise<string> {
  const msgUint8 = new TextEncoder().encode(password);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  return hashHex;
}

const API_TIMEOUT_MS = 20_000;

export class BackendError extends Error {
  constructor(
    message: string,
    readonly code = "SERVER_ERROR",
    readonly retryable = false,
    readonly details?: unknown,
    readonly data?: WorkspaceData
  ) {
    super(message);
    this.name = "BackendError";
  }
}

async function apiCall(action: string, extraPayload: Record<string, any> = {}, signal?: AbortSignal): Promise<any> {
  if (!webAppUrl) {
    throw new Error("לא הוגדר URL לחיבור לשרת (Google Apps Script).");
  }
  
  const payload = {
    action,
    username: loggedInUsername,
    passwordHash: loggedInPasswordHash,
    ...extraPayload
  };
  
  const requestController = new AbortController();
  let timedOut = false;
  const cancelRequest = () => requestController.abort();
  if (signal?.aborted) cancelRequest();
  else signal?.addEventListener("abort", cancelRequest, { once: true });
  const timeoutId = setTimeout(() => {
    timedOut = true;
    requestController.abort();
  }, API_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(webAppUrl, {
      method: "POST",
      mode: "cors",
      headers: {
        "Content-Type": "text/plain;charset=utf-8"
      },
      body: JSON.stringify(payload),
      signal: requestController.signal
    });
  } catch (error) {
    if (timedOut) throw new Error("השרת לא הגיב בזמן. נסו לשמור שוב.");
    throw error;
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", cancelRequest);
  }
  
  if (!response.ok) {
    throw new Error(`שגיאת שרת: ${response.statusText} (${response.status})`);
  }
  
  const result = await response.json();
  if (result.error) {
    const unsupportedPublicRegistration = action === "submit_registration_request" && /wrong|invalid|שגוי|שגויים|לא מוכרת|not found/i.test(String(result.error));
    if (unsupportedPublicRegistration) {
      throw new Error("השרת עדיין לא תומך בבקשות משתמש חדש. צריך לפרוס מחדש את Code.gs ב-Google Apps Script ואז לנסות שוב.");
    }
    throw new BackendError(
      typeof result.error === "string" ? result.error : result.error.message,
      result.errorCode ?? result.error?.code,
      Boolean(result.retryable ?? result.error?.retryable),
      result.details ?? result.error?.details,
      result.data ? migrateWorkspace(result.data) : undefined
    );
  }
  
  return result;
}

export async function loginWithCredentials(url: string, username: string, passwordHash: string): Promise<AppUser> {
  const prevUrl = webAppUrl;
  const prevUser = loggedInUsername;
  const prevHash = loggedInPasswordHash;
  
  try {
    webAppUrl = url.trim();
    loggedInUsername = username.trim().toLowerCase();
    loggedInPasswordHash = passwordHash;
    
    const result = await apiCall("login");
    
    setWebAppUrl(url);
    setLocalCredentials(username, passwordHash);
    return result.user;
  } catch (err) {
    webAppUrl = prevUrl;
    loggedInUsername = prevUser;
    loggedInPasswordHash = prevHash;
    throw err;
  }
}

export async function bootstrapPlanner(url: string, username: string, name: string, passwordHash: string): Promise<{ user: AppUser; data: WorkspaceData }> {
  const prevUrl = webAppUrl;
  const prevUser = loggedInUsername;
  const prevHash = loggedInPasswordHash;
  
  try {
    webAppUrl = url.trim();
    loggedInUsername = username.trim().toLowerCase();
    loggedInPasswordHash = passwordHash;
    
    const result = await apiCall("bootstrap", { name });
    
    setWebAppUrl(url);
    setLocalCredentials(username, passwordHash);
    return { user: result.user, data: migrateWorkspace(result.data) };
  } catch (err) {
    webAppUrl = prevUrl;
    loggedInUsername = prevUser;
    loggedInPasswordHash = prevHash;
    throw err;
  }
}

export async function loadWorkspace(): Promise<WorkspaceData> {
  const result = await apiCall("load");
  const data = migrateWorkspace(result.data);
  data.driveSync.webAppUrl = webAppUrl;
  data.driveSync.username = loggedInUsername;
  return data;
}

export async function saveWorkspace(data: WorkspaceData, signal?: AbortSignal): Promise<WorkspaceData> {
  const result = await apiCall("save", { data }, signal);
  const saved = migrateWorkspace(result.data);
  saved.driveSync.webAppUrl = webAppUrl;
  saved.driveSync.username = loggedInUsername;
  return saved;
}

export async function mutateWorkspace(mutations: MutationCommand[], deviceId: string, signal?: AbortSignal): Promise<MutationResponse> {
  const result = await apiCall("mutate", { apiVersion: 2, deviceId, mutations }, signal);
  return {
    ...result,
    data: migrateWorkspace(result.data)
  } as MutationResponse;
}

export async function getBackendStatus() {
  return apiCall("status", { apiVersion: 2 });
}

export async function kickCalendarSync() {
  return apiCall("kick_calendar_sync", { apiVersion: 2 });
}

export async function submitRegistrationRequest(url: string, request: { doctorName: string; gmail: string; username: string; passwordHash: string }): Promise<{ request: RegistrationRequest }> {
  const prevUrl = webAppUrl;
  try {
    webAppUrl = url.trim();
    const requestId = typeof crypto.randomUUID === "function" ? `reg-${crypto.randomUUID()}` : `reg-${Date.now()}`;
    const result = await apiCall("submit_registration_request", { ...request, requestId });
    setWebAppUrl(url);
    return { request: result.request };
  } catch (err) {
    webAppUrl = prevUrl;
    throw err;
  }
}

export async function adminSaveUsers(users: AppUser[], doctors?: Doctor[], registrationRequests?: RegistrationRequest[]): Promise<WorkspaceData> {
  const result = await apiCall("admin_save_users", { users, doctors, registrationRequests });
  const data = migrateWorkspace(result.data);
  data.driveSync.webAppUrl = webAppUrl;
  data.driveSync.username = loggedInUsername;
  return data;
}

export async function saveSnapshotImage(imageName: string, imageDataUri: string): Promise<{ fileId: string; url: string }> {
  const result = await apiCall("save_snapshot", { imageName, imageDataUri });
  return { fileId: result.fileId, url: result.url };
}
