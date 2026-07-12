import { beforeEach, describe, expect, it } from "vitest";
import {
  inlayHintsEnabledForLanguage,
  readWorkspaceIntelligencePreferences,
  writeWorkspaceIntelligencePreferences,
} from "./intelligencePreferences";

describe("workspace intelligence preferences", () => {
  beforeEach(() => window.localStorage.clear());

  it("defaults optional editor intelligence off and persists workspace/language switches", () => {
    const defaults = readWorkspaceIntelligencePreferences("ws");
    expect(inlayHintsEnabledForLanguage(defaults, "typescript")).toBe(false);
    expect(defaults.formatOnSave).toBe(false);
    writeWorkspaceIntelligencePreferences("ws", {
      inlayHintsEnabled: true,
      inlayHintLanguages: { typescript: false, rust: true },
      inlineBlameEnabled: true,
      formatOnSave: true,
    });
    const restored = readWorkspaceIntelligencePreferences("ws");
    expect(inlayHintsEnabledForLanguage(restored, "typescript")).toBe(false);
    expect(inlayHintsEnabledForLanguage(restored, "rust")).toBe(true);
    expect(inlayHintsEnabledForLanguage(restored, "go")).toBe(true);
    expect(restored.inlineBlameEnabled).toBe(true);
    expect(restored.formatOnSave).toBe(true);
  });
});
