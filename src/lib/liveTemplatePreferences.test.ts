import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LIVE_TEMPLATE_PREFERENCES,
  LIVE_TEMPLATE_PREFERENCES_STORAGE_KEY,
  createCustomLiveTemplateId,
  isBuiltinTemplateEnabled,
  loadLiveTemplatePreferences,
  normalizeCustomLiveTemplate,
  normalizeLiveTemplatePreferences,
  saveLiveTemplatePreferences,
  setBuiltinTemplateEnabled,
} from "./liveTemplatePreferences";

afterEach(() => {
  window.localStorage.removeItem(LIVE_TEMPLATE_PREFERENCES_STORAGE_KEY);
});

describe("normalizeLiveTemplatePreferences", () => {
  it("returns defaults for empty input", () => {
    expect(normalizeLiveTemplatePreferences(undefined)).toEqual({
      ...DEFAULT_LIVE_TEMPLATE_PREFERENCES,
      customTemplates: [],
    });
  });

  it("keeps valid custom templates and drops invalid ones", () => {
    const prefs = normalizeLiveTemplatePreferences({
      enabled: false,
      postfixEnabled: false,
      disabledBuiltinKeys: ["java|l|sout", 12, ""],
      customTemplates: [
        {
          id: "c1",
          abbreviation: "mysout",
          body: "System.out.println(${});",
          description: "mine",
          languages: ["java", "kotlin", "nope"],
          postfix: false,
          enabled: true,
        },
        { abbreviation: "bad body", body: "", languages: ["java"] },
        { abbreviation: "1bad", body: "x", languages: ["java"] },
      ],
    });
    expect(prefs.enabled).toBe(false);
    expect(prefs.postfixEnabled).toBe(false);
    expect(prefs.disabledBuiltinKeys).toEqual(["java|l|sout"]);
    expect(prefs.customTemplates).toHaveLength(1);
    expect(prefs.customTemplates[0]?.abbreviation).toBe("mysout");
    expect(prefs.customTemplates[0]?.languages).toEqual(["java", "kotlin"]);
  });
});

describe("normalizeCustomLiveTemplate", () => {
  it("assigns an id when missing", () => {
    const custom = normalizeCustomLiveTemplate({
      abbreviation: "foo",
      body: "bar(${})",
      languages: ["typescript"],
    });
    expect(custom?.id).toBeTruthy();
    expect(custom?.abbreviation).toBe("foo");
    expect(createCustomLiveTemplateId()).toBeTruthy();
  });
});

describe("load/save round-trip", () => {
  it("persists and reloads preferences", () => {
    const next = setBuiltinTemplateEnabled(
      {
        ...DEFAULT_LIVE_TEMPLATE_PREFERENCES,
        customTemplates: [{
          id: "c1",
          abbreviation: "hi",
          body: "hello(${})",
          description: "",
          languages: ["java"],
          postfix: false,
          enabled: true,
        }],
      },
      "java|l|sout",
      false,
    );
    saveLiveTemplatePreferences(next);
    const loaded = loadLiveTemplatePreferences();
    expect(isBuiltinTemplateEnabled(loaded, "java|l|sout")).toBe(false);
    expect(loaded.customTemplates[0]?.abbreviation).toBe("hi");
  });
});
