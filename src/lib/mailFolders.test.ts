import { afterEach, describe, expect, it } from "vitest";
import type { MailFolder } from "./mail";
import {
  isSelectable,
  loadSubscribedOnly,
  mailFolderSelectionMatches,
  parseSpecialFolders,
  saveSubscribedOnly,
  visibleFolders,
} from "./mailFolders";

function folder(name: string, flags: string[] = []): MailFolder {
  return { accountId: "a", name, delimiter: "/", flags, uidValidity: null, uidNext: null, total: null, unread: null, updatedAt: 0 } as MailFolder;
}

describe("mailFolders", () => {
  afterEach(() => window.localStorage.clear());

  it.each([
    ["台北", "&U,BTFw-", true],
    ["&U,BTFw-", "&U,BTFw-", true],
    ["  台北  ", "&U,BTFw-", true],
    ["Projects/台北", "Projects/&U,BTFw-", true],
    ["台北", "Projects/&U,BTFw-", false],
    ["projects/台北", "Projects/&U,BTFw-", false],
    ["A & B", "A &- B", true],
    ["中文", "中文", true],
    ["inbox", "INBOX", true],
    ["archive", "Archive", false],
    ["Other", "&U,BTFw-", false],
  ])("matches storage selection %s against %s: %s", (selection, serverName, expected) => {
    expect(mailFolderSelectionMatches(selection, serverName)).toBe(expected);
  });

  it("hides unsubscribed folders but keeps INBOX", () => {
    const folders = [folder("INBOX"), folder("Work", ["\\Subscribed"]), folder("Old")];
    expect(visibleFolders(folders, false)).toHaveLength(3);
    expect(visibleFolders(folders, true).map((f) => f.name)).toEqual(["INBOX", "Work"]);
  });

  it("shows everything when no folder carries subscription data", () => {
    const folders = [folder("INBOX"), folder("Old")];
    expect(visibleFolders(folders, true)).toHaveLength(2);
  });

  it("treats \\Noselect as not selectable in either attribute form", () => {
    expect(isSelectable(folder("[Gmail]", ["\\Noselect"]))).toBe(false);
    expect(isSelectable(folder("[Gmail]", ["NoSelect"]))).toBe(false);
    expect(isSelectable(folder("INBOX", ["\\HasNoChildren"]))).toBe(true);
  });

  it("persists the subscribed-only preference per account", () => {
    expect(loadSubscribedOnly("acct", false)).toBe(false);
    saveSubscribedOnly("acct", true);
    expect(loadSubscribedOnly("acct", false)).toBe(true);
    expect(loadSubscribedOnly("other", false)).toBe(false);
  });

  it("parses special folder overrides", () => {
    expect(parseSpecialFolders('{"sent":" 已发送 ","junk":"","bogus":"x"}')).toEqual({ sent: "已发送" });
    expect(parseSpecialFolders({ trash: "Deleted" })).toEqual({ trash: "Deleted" });
    expect(parseSpecialFolders("not json")).toEqual({});
  });
});
