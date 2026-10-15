// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import viteConfig from "../vite.config";
import vitestConfig from "../vitest.config";

// The OCR plugin resolves large optional model packages at instantiation.
// It is unrelated to defines; do not start services or require OCR for this
// config unit test. The actual defineConfig callbacks remain under test.
vi.mock("./screenshotOcr", () => ({ screenshotOcrPlugin: () => ({ name: "ocr-unit-stub" }) }));

describe("terminal text mirror compilation modes", () => {
  it.each([
    ["build", "production", false, false],
    ["build", "development", false, false],
    ["build", "staging", false, false],
    ["build", "qa", false, true],
    ["serve", "development", false, true],
    ["serve", "production", false, true],
    ["serve", "staging", false, true],
    ["serve", "qa", false, true],
    ["serve", "production", true, false],
    ["serve", "development", true, false],
    ["serve", "staging", true, false],
    ["serve", "qa", true, true],
  ] as const)("%s mode=%s preview=%s defines mirror=%s", async (command, mode, isPreview, expected) => {
    // Evaluate the real config without starting a server or building an app.
    const config = viteConfig({ command, mode, isPreview });
    expect(config.define?.__TAOMNI_TERMINAL_TEXT_MIRROR__).toBe(JSON.stringify(expected));
    expect(config.build?.target).toEqual(["es2020", "safari16"]);
  });

  it.each(["test", "qa", "staging"])("Vitest mode=%s toggles only the text mirror", async (mode) => {
    const config = vitestConfig({ command: "serve", mode });
    expect(config.define?.__TAOMNI_TERMINAL_TEXT_MIRROR__).toBe(JSON.stringify(mode === "qa"));
    for (const key of ["__TAOMNI_QA_SAVE_GATE__", "__TAOMNI_QA_COMPLETION_OBSERVATION__", "__TAOMNI_QA_UPDATER__"]) {
      expect(config.define?.[key]).toBe("false");
    }
  });
});
