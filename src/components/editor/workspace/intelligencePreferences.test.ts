import { beforeEach, describe, expect, it } from "vitest";
import {
  inlayHintsEnabledForLanguage,
  readWorkspaceIntelligencePreferences,
  writeWorkspaceIntelligencePreferences,
} from "./intelligencePreferences";

describe("workspace intelligence preferences", () => {
  beforeEach(() => window.localStorage.clear());

  it("defaults inlay hints off and persists workspace/language switches", () => {
    expect(inlayHintsEnabledForLanguage(readWorkspaceIntelligencePreferences("ws"), "typescript")).toBe(false);
    writeWorkspaceIntelligencePreferences("ws", {
      inlayHintsEnabled: true,
      inlayHintLanguages: { typescript: false, rust: true },
      inlineBlameEnabled: true,
    });
    const restored = readWorkspaceIntelligencePreferences("ws");
    expect(inlayHintsEnabledForLanguage(restored, "typescript")).toBe(false);
    expect(inlayHintsEnabledForLanguage(restored, "rust")).toBe(true);
    expect(inlayHintsEnabledForLanguage(restored, "go")).toBe(true);
    expect(restored.inlineBlameEnabled).toBe(true);
  });
});
