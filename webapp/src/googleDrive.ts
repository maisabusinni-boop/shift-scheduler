import { migrateWorkspace } from "@/migration";
import type { WorkspaceData, AppUser, Doctor, RegistrationRequest } from "@/types";

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

async function apiCall(action: string, extraPayload: Record<string, any> = {}): Promise<any> {
  if (!webAppUrl) {
    throw new Error("לא הוגדר URL לחיבור לשרת (Google Apps Script).");
  }
  
  const payload = {
    action,
    username: loggedInUsername,
    passwordHash: loggedInPasswordHash,
    ...extraPayload
  };
  
  const response = await fetch(webAppUrl, {
    method: "POST",
    mode: "cors",
    headers: {
      "Content-Type": "text/plain;charset=utf-8"
    },
    body: JSON.stringify(payload)
  });
  
  if (!response.ok) {
    throw new Error(`שגיאת שרת: ${response.statusText} (${response.status})`);
  }
  
  const result = await response.json();
  if (result.error) {
    const unsupportedPublicRegistration = action === "submit_registration_request" && /wrong|invalid|שגוי|שגויים|לא מוכרת|not found/i.test(String(result.error));
    if (unsupportedPublicRegistration) {
      throw new Error("השרת עדיין לא תומך בבקשות משתמש חדש. צריך לפרוס מחדש את Code.gs ב-Google Apps Script ואז לנסות שוב.");
    }
    throw new Error(result.error);
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

export async function saveWorkspace(data: WorkspaceData): Promise<WorkspaceData> {
  const result = await apiCall("save", { data });
  const saved = migrateWorkspace(result.data);
  saved.driveSync.webAppUrl = webAppUrl;
  saved.driveSync.username = loggedInUsername;
  return saved;
}

export async function submitRegistrationRequest(url: string, request: { doctorName: string; gmail: string; username: string; passwordHash: string }): Promise<{ request: RegistrationRequest }> {
  const prevUrl = webAppUrl;
  try {
    webAppUrl = url.trim();
    const result = await apiCall("submit_registration_request", request);
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
