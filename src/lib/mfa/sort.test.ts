import { describe, expect, it } from "vitest";
import { accountGroups, matchesQuery, moveInCustomOrder, sortAccounts, visibleAccounts } from "./sort";
import { MFA_UNGROUPED, type MfaAccount } from "./types";

function account(id: string, patch: Partial<MfaAccount>): MfaAccount {
  return {
    id,
    issuer: id,
    accountName: `${id.toLowerCase()}@example.com`,
    group: "",
    note: "",
    kind: "totp",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    counter: 0,
    pinned: false,
    sortOrder: 0,
    useCount: 0,
    lastUsedAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

const accounts = [
  account("Zeta Cloud", { sortOrder: 0, createdAt: 1, useCount: 1, lastUsedAt: 500, group: "Work" }),
  account("Alpha Mail", { sortOrder: 1, createdAt: 2, useCount: 5, lastUsedAt: 100, note: "personal inbox" }),
  account("Mid Bank", { sortOrder: 2, createdAt: 3, accountName: "", group: "Work" }),
  account("Beta Git", { sortOrder: 3, createdAt: 4, useCount: 5, lastUsedAt: 900, accountName: "aaron" }),
];
const issuers = (list: MfaAccount[]) => list.map((a) => a.issuer);

describe("MFA ordering", () => {
  it("applies each sort mode with pinned accounts first", () => {
    expect(issuers(sortAccounts(accounts, "custom"))).toEqual(["Zeta Cloud", "Alpha Mail", "Mid Bank", "Beta Git"]);
    expect(issuers(sortAccounts(accounts, "issuer"))).toEqual(["Alpha Mail", "Beta Git", "Mid Bank", "Zeta Cloud"]);
    // Empty account names sort last.
    expect(issuers(sortAccounts(accounts, "account"))).toEqual(["Beta Git", "Alpha Mail", "Zeta Cloud", "Mid Bank"]);
    expect(issuers(sortAccounts(accounts, "recent"))).toEqual(["Beta Git", "Zeta Cloud", "Alpha Mail", "Mid Bank"]);
    expect(issuers(sortAccounts(accounts, "frequent"))).toEqual(["Beta Git", "Alpha Mail", "Zeta Cloud", "Mid Bank"]);
    expect(issuers(sortAccounts(accounts, "added"))).toEqual(["Beta Git", "Mid Bank", "Alpha Mail", "Zeta Cloud"]);
    const pinned = accounts.map((a) => (a.issuer === "Mid Bank" ? { ...a, pinned: true } : a));
    expect(issuers(sortAccounts(pinned, "issuer"))[0]).toBe("Mid Bank");
    expect(issuers(sortAccounts(pinned, "custom"))).toEqual(["Mid Bank", "Zeta Cloud", "Alpha Mail", "Beta Git"]);
  });

  it("filters by query across fields and by group", () => {
    expect(matchesQuery(accounts[1], "INBOX")).toBe(true);
    expect(issuers(visibleAccounts(accounts, { query: "mail", group: "", sortMode: "custom" }))).toEqual(["Alpha Mail"]);
    expect(issuers(visibleAccounts(accounts, { query: "", group: "Work", sortMode: "issuer" }))).toEqual(["Mid Bank", "Zeta Cloud"]);
    expect(issuers(visibleAccounts(accounts, { query: "", group: MFA_UNGROUPED, sortMode: "custom" }))).toEqual(["Alpha Mail", "Beta Git"]);
    expect(accountGroups(accounts)).toEqual(["Work"]);
  });

  it("moves an account into the target's slot of the global custom order", () => {
    expect(moveInCustomOrder(accounts, "Zeta Cloud", "Mid Bank")).toEqual(["Alpha Mail", "Mid Bank", "Zeta Cloud", "Beta Git"]);
    expect(moveInCustomOrder(accounts, "Beta Git", "Alpha Mail")).toEqual(["Zeta Cloud", "Beta Git", "Alpha Mail", "Mid Bank"]);
    expect(moveInCustomOrder(accounts, "Beta Git", "missing")).toEqual(["Zeta Cloud", "Alpha Mail", "Mid Bank", "Beta Git"]);
  });
});
