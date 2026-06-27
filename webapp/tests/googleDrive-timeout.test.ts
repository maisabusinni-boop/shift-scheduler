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
});
