import type { WorkspaceData } from "@/types";

type TokenResponse = {
  access_token?: string;
  error?: string;
};

type TokenClient = {
  requestAccessToken: (options?: { prompt?: string }) => void;
  callback: (response: TokenResponse) => void;
};

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient: (options: {
            client_id: string;
            scope: string;
            callback: (response: TokenResponse) => void;
          }) => TokenClient;
        };
      };
    };
  }
}

const GIS_SRC = "https://accounts.google.com/gsi/client";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const DRIVE_FIELDS = "id,name,modifiedTime,version,webViewLink";

export type DriveFileMetadata = {
  id: string;
  name: string;
  modifiedTime: string;
  version?: string;
  webViewLink?: string;
};

let tokenClient: TokenClient | null = null;
let accessToken = "";

function loadScript(src: string) {
  return new Promise<void>((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Could not load Google Identity script."));
    document.head.appendChild(script);
  });
}

export async function connectGoogleDrive(clientId: string) {
  const trimmed = clientId.trim();
  if (!trimmed) throw new Error("צריך להזין Google OAuth Client ID.");
  await loadScript(GIS_SRC);
  if (!window.google) throw new Error("Google Identity Services לא נטען.");

  return new Promise<string>((resolve, reject) => {
    tokenClient = window.google!.accounts.oauth2.initTokenClient({
      client_id: trimmed,
      scope: DRIVE_SCOPE,
      callback: (response) => {
        if (response.error || !response.access_token) {
          reject(new Error(response.error ?? "Google authorization failed."));
          return;
        }
        accessToken = response.access_token;
        resolve(accessToken);
      }
    });
    tokenClient.requestAccessToken({ prompt: accessToken ? "" : "consent" });
  });
}

export function hasDriveToken() {
  return Boolean(accessToken);
}

function authHeaders(extra?: HeadersInit) {
  if (!accessToken) throw new Error("צריך להתחבר ל-Google Drive קודם.");
  return {
    Authorization: `Bearer ${accessToken}`,
    ...extra
  };
}

export function extractDriveFileId(input: string) {
  const trimmed = input.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    const fileMatch = url.pathname.match(/\/file\/d\/([^/]+)/);
    if (fileMatch) return fileMatch[1];
    const id = url.searchParams.get("id");
    if (id) return id;
  } catch {
    return trimmed;
  }
  return trimmed;
}

export async function getDriveFileMetadata(fileId: string): Promise<DriveFileMetadata> {
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=${encodeURIComponent(DRIVE_FIELDS)}`, {
    headers: authHeaders()
  });
  if (!response.ok) throw new Error("לא ניתן לקרוא את פרטי הקובץ מ-Google Drive.");
  return response.json() as Promise<DriveFileMetadata>;
}

export async function createDriveWorkspaceFile(data: WorkspaceData): Promise<DriveFileMetadata> {
  const boundary = `scheduler_${crypto.randomUUID()}`;
  const metadata = {
    name: data.driveSync.fileName || "department-shift-scheduler.json",
    mimeType: "application/json"
  };
  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify(metadata),
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify(data, null, 2),
    `--${boundary}--`
  ].join("\r\n");

  const response = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=${encodeURIComponent(DRIVE_FIELDS)}`,
    {
      method: "POST",
      headers: authHeaders({ "Content-Type": `multipart/related; boundary=${boundary}` }),
      body
    }
  );
  if (!response.ok) throw new Error("יצירת קובץ Drive נכשלה.");
  return response.json() as Promise<DriveFileMetadata>;
}

export async function loadWorkspaceFromDrive(fileId: string): Promise<{ data: WorkspaceData; metadata: DriveFileMetadata }> {
  const metadata = await getDriveFileMetadata(fileId);
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: authHeaders()
  });
  if (!response.ok) throw new Error("טעינת קובץ השיבוץ מ-Drive נכשלה.");
  const data = (await response.json()) as WorkspaceData;
  return { data, metadata };
}

export async function saveWorkspaceToDrive(fileId: string, data: WorkspaceData): Promise<DriveFileMetadata> {
  const response = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&fields=${encodeURIComponent(DRIVE_FIELDS)}`,
    {
      method: "PATCH",
      headers: authHeaders({ "Content-Type": "application/json; charset=UTF-8" }),
      body: JSON.stringify(data, null, 2)
    }
  );
  if (!response.ok) throw new Error("שמירת קובץ השיבוץ ל-Drive נכשלה.");
  return response.json() as Promise<DriveFileMetadata>;
}
