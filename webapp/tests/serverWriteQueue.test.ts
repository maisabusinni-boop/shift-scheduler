import { describe, expect, it, vi } from "vitest";
import { createServerWriteQueue } from "@/serverWriteQueue";

describe("server write queue", () => {
  it("runs writes one at a time and preserves their order", async () => {
    const queue = createServerWriteQueue();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const events: string[] = [];

    const first = queue(async () => {
      events.push("first-start");
      await firstGate;
      events.push("first-end");
      return 1;
    });
    const secondWrite = vi.fn(async () => {
      events.push("second");
      return 2;
    });
    const second = queue(secondWrite);

    await Promise.resolve();
    expect(secondWrite).not.toHaveBeenCalled();
    releaseFirst();

    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    expect(events).toEqual(["first-start", "first-end", "second"]);
  });

  it("continues with the next write after a failure", async () => {
    const queue = createServerWriteQueue();
    const failed = queue(async () => { throw new Error("save failed"); });
    const recovered = queue(async () => "saved");

    await expect(failed).rejects.toThrow("save failed");
    await expect(recovered).resolves.toBe("saved");
  });
});
