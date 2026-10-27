import { describe, expect, it } from "vitest";
import type { MailFolder } from "../../../lib/mail";
import { MailSubscriptionSnapshots } from "./subscriptionSnapshots";

const folder = (name: string, flags: string[], total = 1): MailFolder => ({
  accountId: "account", name, displayName: name, flags, total, unread: 0, updatedAt: 0,
});

describe("mail subscription snapshot ordering", () => {
  it("preserves only newer subscription bits and accepts fresh counts and other flags", () => {
    const snapshots = new MailSubscriptionSnapshots();
    const old = snapshots.capture();
    snapshots.confirm(folder("Archive", []));
    const incoming = [folder("Archive", ["\\Subscribed", "\\Archive"], 300),
      folder("Sent", ["\\Subscribed", "\\Sent"], 200)];
    const result = snapshots.merge(incoming, old);
    expect(result[0]).toEqual({ ...incoming[0], flags: ["\\Archive"] });
    expect(result[1]).toBe(incoming[1]);
    expect(incoming[0].flags).toEqual(["\\Subscribed", "\\Archive"]);
  });

  it("accepts a server change from a read started after mutation completion", () => {
    const snapshots = new MailSubscriptionSnapshots();
    snapshots.confirm(folder("Archive", []));
    const fresh = snapshots.capture();
    const changedByAnotherClient = folder("Archive", ["\\Subscribed"]);
    expect(snapshots.merge([changedByAnotherClient], fresh)[0]).toBe(changedByAnotherClient);
  });

  it("orders unsubscribe and subscribe independently for each folder and account", () => {
    const snapshots = new MailSubscriptionSnapshots();
    snapshots.confirm(folder("Archive", []));
    const during = snapshots.capture();
    snapshots.confirm(folder("Drafts", []));
    snapshots.confirm(folder("Archive", ["\\sUbScRiBeD"]));
    const result = snapshots.merge([folder("Archive", []), folder("Drafts", ["\\Subscribed"])], during);
    expect(result.map((entry) => entry.flags)).toEqual([["\\Subscribed"], []]);
    const otherAccount = new MailSubscriptionSnapshots();
    expect(otherAccount.merge([folder("Drafts", ["\\Subscribed"])], 0)[0].flags).toEqual(["\\Subscribed"]);
  });
});
