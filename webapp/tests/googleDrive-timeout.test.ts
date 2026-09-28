import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storage = new Map<string, string>();

describe("Google Drive request timeout", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    storage.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key)
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("aborts a stalled workspace save instead of blocking forever", async () => {
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }))); 
    const { saveWorkspace } = await import("@/googleDrive");
    const save = saveWorkspace({} as never);
    const rejection = expect(save).rejects.toThrow("השרת לא הגיב בזמן");

    await vi.advanceTimersByTimeAsync(20_000);

    await rejection;
  });
  it.each([true, false])("loads login data with bundled workspace=%s", async (bundled) => {
    const { createSampleWorkspace } = await import("@/sampleData");
    const data = createSampleWorkspace();
    const user = { username: "tester", role: "resident" };
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ user, ...(bundled ? { data } : {}) }) });
    if (!bundled) fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ data }) });
    vi.stubGlobal("fetch", fetchMock);
    const { loginAndLoadWorkspace, getLocalCredentials } = await import("@/googleDrive");
    const result = await loginAndLoadWorkspace("https://example.test/exec", " Tester ", "hash");
    expect(result.user).toEqual(user);
    expect(result.data.schemaVersion).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(bundled ? 1 : 2);
    expect(getLocalCredentials().username).toBe("tester");
  });

  it.each([
    ["self password", "me", "applied", "planner", "new-hash", "new-hash"],
    ["self username", "me", "applied", "renamed", "", "old-hash"],
    ["other account", "other", "applied", "other", "new-hash", "old-hash"],
    ["rejected edit", "me", "rejected", "renamed", "new-hash", "old-hash"],
    ["duplicate retry", "me", "duplicate", "renamed", "new-hash", "old-hash"]
  ])("keeps subsequent requests authenticated after %s", async (_label, targetId, status, username, passwordHash, expectedHash) => {
    const { createSampleWorkspace } = await import("@/sampleData");
    const data = createSampleWorkspace();
    const selfAccepted = targetId === "me" && status === "applied";
    data.users = [{ id: "me", username: selfAccepted ? username : "planner", name: "Planner", email: "planner@local", role: "senior-planner", active: true, doctorId: null, createdAt: "2026-01-01" }];
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ results: [{ id: "edit", status }], data }) }).mockResolvedValueOnce({ ok: true, json: async () => ({ data }) });
    vi.stubGlobal("fetch", fetchMock);
    const { setLocalCredentials, getLocalCredentials, mutateWorkspace, loadWorkspace } = await import("@/googleDrive");
    setLocalCredentials("planner", "old-hash");
    await mutateWorkspace([{ id: "edit", type: "doctor-user-update", createdAt: "2026-01-01", payload: { after: { user: { id: targetId, username, passwordHash } } } }], "test", undefined, "me");
    await loadWorkspace();
    const sent = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(sent.username).toBe(selfAccepted ? username : "planner");
    expect(sent.passwordHash).toBe(expectedHash);
    expect(getLocalCredentials()).toEqual({ username: sent.username, passwordHash: sent.passwordHash });
    expect(storage.get("department-shift-scheduler.password-hash")).toBe(expectedHash);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).passwordHash).toBe("old-hash");
  });

});
