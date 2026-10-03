import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOCALES, getLocale, setLocale, t, getLocaleDescriptor } from "./index";

describe("i18n core", () => {
  let original: ReturnType<typeof getLocale>;

  beforeEach(() => {
    original = getLocale();
  });

  afterEach(() => {
    setLocale(original);
    try {
      window.localStorage.removeItem("taomni.locale.v1");
    } catch {
      /* ignore */
    }
  });

  it("exposes English and Simplified Chinese in the locale list", () => {
    const codes = LOCALES.map((entry) => entry.code);
    expect(codes).toContain("en");
    expect(codes).toContain("zh-CN");
  });

  it("translates a known key for both locales", () => {
    setLocale("en");
    expect(t("common.cancel")).toBe("Cancel");
    setLocale("zh-CN");
    expect(t("common.cancel")).toBe("取消");
  });

  it("falls back to English when a key is missing in the active locale", () => {
    setLocale("zh-CN");
    // pick a deliberately fake key — fallback should return the key itself
    expect(t("does.not.exist")).toBe("does.not.exist");
  });

  it("interpolates parameters using {name} placeholders", () => {
    setLocale("en");
    expect(t("status.openedTab", { title: "Demo" })).toBe("Opened Demo");
    setLocale("zh-CN");
    expect(t("status.openedTab", { title: "Demo" })).toBe("已打开 Demo");
  });

  it("normalizes loose locale codes to known dictionaries", () => {
    setLocale("zh" as unknown as "zh-CN");
    expect(getLocale()).toBe("zh-CN");
    setLocale("en-US" as unknown as "en");
    expect(getLocale()).toBe("en");
  });

  it("returns a locale descriptor for the active locale", () => {
    setLocale("zh-CN");
    expect(getLocaleDescriptor().code).toBe("zh-CN");
    expect(getLocaleDescriptor("en").nativeLabel).toBe("English");
  });
});
