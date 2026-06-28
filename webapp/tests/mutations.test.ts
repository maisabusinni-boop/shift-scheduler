import { describe, expect, it } from "vitest";
import { applyMutationLocally, createDirectMutation } from "@/mutations";
import { createSampleWorkspace } from "@/sampleData";

describe("optimistic mutation rebase", () => {
  it("replays an assignment over a fresh server snapshot", () => {
    const data = createSampleWorkspace();
    const scheduleKey = Object.keys(data.schedules)[0];
    const command = createDirectMutation("assignment-update", {
      entityType: "assignment",
      entityId: "2026-06-01|resident-on-call",
      scheduleKey,
      after: { "2026-06-01|resident-on-call": { doctorId: "doc-cohen", pending: false } }
    }, { "2026-06-01|resident-on-call": null });
    const rebased = applyMutationLocally(data, command);
    expect(rebased.schedules[scheduleKey].assignments["2026-06-01|resident-on-call"].doctorId).toBe("doc-cohen");
  });

  it("does not duplicate an exclusion when replayed", () => {
    const data = createSampleWorkspace();
    const scheduleKey = Object.keys(data.schedules)[0];
    const exclusion = { id: "ex-1", doctorId: "doc-cohen", date: "2026-06-01", roleCode: "resident-on-call" as const, reason: "test" };
    const command = createDirectMutation("exclusion-create", { entityType: "exclusion", entityId: exclusion.id, scheduleKey, after: [exclusion] });
    const once = applyMutationLocally(data, command);
    const twice = applyMutationLocally(once, command);
    expect(twice.schedules[scheduleKey].exclusions.filter((item) => item.id === exclusion.id)).toHaveLength(1);
  });
});
