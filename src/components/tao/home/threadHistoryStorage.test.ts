import { expect, it, vi } from "vitest";
import { createThreadHistoryStorage } from "./threadHistoryStorage";

const thread = { id: "thread", title: "history", messages: [], updatedAt: 1 };

it("waits for an in-flight autosave before removing and never resurrects the row", async () => {
  let finishSave!: () => void;
  const events: string[] = [];
  const owner = createThreadHistoryStorage({
    save: async () => { events.push("saving"); await new Promise<void>((resolve) => { finishSave = resolve; }); events.push("saved"); },
    remove: async () => { events.push("removed"); },
  });
  const save = owner.save(thread);
  await vi.waitFor(() => expect(events).toEqual(["saving"]));
  const remove = owner.remove(thread);
  await owner.save({ ...thread, title: "late autosave" });
  expect(events).toEqual(["saving"]);
  finishSave(); await save; await remove;
  await owner.save(thread);
  expect(events).toEqual(["saving", "saved", "removed"]);
});

it("preserves the row and releases autosave after a failed deletion", async () => {
  const save = vi.fn(async () => undefined);
  const remove = vi.fn().mockRejectedValueOnce(new Error("disk locked")).mockResolvedValue(undefined);
  const owner = createThreadHistoryStorage({ save, remove });
  await expect(owner.remove(thread)).rejects.toThrow("disk locked");
  await owner.save(thread);
  expect(save).toHaveBeenCalledTimes(1);
  await owner.remove(thread);
  expect(remove).toHaveBeenCalledTimes(2);
});

it("never migrates a legacy conversation into the Home snapshot store", async () => {
  const save = vi.fn(async () => undefined);
  const remove = vi.fn(async () => undefined);
  const owner = createThreadHistoryStorage({ save, remove });
  const legacy = { ...thread, source: "legacy" as const };
  await owner.save(legacy);
  await owner.remove(legacy);
  expect(save).not.toHaveBeenCalled();
  expect(remove).toHaveBeenCalledWith(legacy);
});
