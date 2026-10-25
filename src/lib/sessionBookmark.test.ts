import { expect, it } from "vitest";
import { bookmarkOpacity, readSessionBookmark, shortcutMatches } from "./sessionBookmark";
it("does not automatically connect or reconnect historical bookmarks", () => {
  expect(readSessionBookmark("{}")).toMatchObject({ autoConnect: false, reconnect: false, openNewWindow: false });
  expect(readSessionBookmark('{"autoConnect":true,"reconnect":true,"shortcut":"Mod+Shift+1"}'))
    .toMatchObject({ autoConnect: true, reconnect: true, shortcut: "Mod+Shift+1" });
});
it("normalizes opacity and matches exact platform modifiers only", () => {
  expect(bookmarkOpacity("35%")).toBe(0.35);
  expect(bookmarkOpacity("150")).toBe(1);
  expect(bookmarkOpacity("-2")).toBe(0);
  expect(bookmarkOpacity("invalid")).toBe(0.35);
  const event = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, shiftKey: true });
  expect(shortcutMatches("Mod+Shift+K", event, false)).toBe(true);
  expect(shortcutMatches("Mod+Shift+K", event, true)).toBe(false);
  expect(shortcutMatches("Ctrl+K", event, false)).toBe(false);
  expect(shortcutMatches("K", new KeyboardEvent("keydown", { key: "k" }), false)).toBe(false);
  expect(shortcutMatches("nonsense+K", event, false)).toBe(false);
});
