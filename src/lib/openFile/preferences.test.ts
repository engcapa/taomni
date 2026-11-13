import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_FILE_OPEN_PREFERENCES, FILE_OPEN_PREFERENCES_KEY, resetFileOpenPreferences, setFileOpenPreferences, useFileOpenPreferences } from "./preferences";
import { activeViewerCommands } from "./viewerCommands";
import { useAppStore } from "../../stores/appStore";
import { useDocumentStore } from "../../stores/documentStore";
beforeEach(() => { localStorage.clear(); resetFileOpenPreferences(); useAppStore.setState({ tabs: [], activeTabId: null, activeSideTab: "sessions" }); useDocumentStore.setState({ documents: {} }); });
describe("file-open preferences", () => {
  it("persists partial updates and restores exact defaults", () => {
    setFileOpenPreferences({ associations: { txt: "system" }, fontSize: 24 });
    setFileOpenPreferences({ wrap: false });
    expect(useFileOpenPreferences.getState()).toMatchObject({ associations: { txt: "system" }, fontSize: 24, wrap: false });
    expect(JSON.parse(localStorage.getItem(FILE_OPEN_PREFERENCES_KEY)!)).toMatchObject({ wrap: false, fontSize: 24 });
    resetFileOpenPreferences(); expect(useFileOpenPreferences.getState()).toEqual(DEFAULT_FILE_OPEN_PREFERENCES);
  });
  it("bounds malformed preference values", () => {
    setFileOpenPreferences({ fontSize: 1000, associations: { "../x": "system", md: "taomni" } });
    expect(useFileOpenPreferences.getState().fontSize).toBe(32);
    expect(useFileOpenPreferences.getState().associations).toEqual({ md: "taomni" });
    expect(useFileOpenPreferences.getState().htmlProxyMode).toBe("app");
    setFileOpenPreferences({ htmlProxyMode: "none" });
    expect(JSON.parse(localStorage.getItem(FILE_OPEN_PREFERENCES_KEY)!).htmlProxyMode).toBe("none");
  });
  it("does not contribute save commands for unrelated tabs", () => {
    expect(activeViewerCommands()).toBeNull();
  });
});
