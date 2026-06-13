import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppThemeMode } from "../../lib/appTheme";
import { SettingsPanel } from "./SettingsPanel";

const ipcMocks = vi.hoisted(() => ({
  listSystemFonts: vi.fn(),
  getAppProxyConfig: vi.fn(),
  listSessions: vi.fn(),
}));

vi.mock("../../lib/ipc", () => ({
  ...ipcMocks,
}));

const STORAGE_KEY = "taomni.terminalProfile.v1";
const APP_THEME_STORAGE_KEY = "taomni.appTheme.v1";

describe("SettingsPanel", () => {
  beforeEach(() => {
    ipcMocks.listSystemFonts.mockReset();
    ipcMocks.listSystemFonts.mockResolvedValue(["Consolas", "JetBrains Mono", "Source Code Pro"]);
    ipcMocks.getAppProxyConfig.mockReset();
    ipcMocks.getAppProxyConfig.mockResolvedValue({
      enabled: false,
      mode: "manual",
      session_id: "",
      kind: "http",
      host: "",
      port: 3128,
      username: "",
      password_ref: "",
    });
    ipcMocks.listSessions.mockReset();
    ipcMocks.listSessions.mockResolvedValue([]);
    window.localStorage.clear();
    setAppThemeMode("system");
  });

  afterEach(() => {
    cleanup();
  });

  it("persists global terminal appearance settings", async () => {
    const user = userEvent.setup();
    render(<SettingsPanel />);

    const terminalFontSelect = screen.getByLabelText("Terminal font");
    await waitFor(() => expect(within(terminalFontSelect).getByRole("option", { name: "JetBrains Mono" })).toBeInTheDocument());

    await user.selectOptions(terminalFontSelect, "JetBrains Mono");
    const fontSize = screen.getByLabelText("Terminal font size");
    await user.clear(fontSize);
    await user.type(fontSize, "18");
    await user.click(screen.getByLabelText("Enable font ligatures"));
    await user.click(screen.getByRole("button", { name: "Use theme Kanagawa Wave" }));
    await user.selectOptions(screen.getByLabelText("Terminal cursor"), "Underline (steady)");
    await user.click(screen.getByLabelText("Enable keyword highlighting"));

    await waitFor(() => {
      const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
      expect(saved.fontFamily).toContain("JetBrains Mono");
      expect(saved.fontSize).toBe(18);
      expect(saved.fontLigatures).toBe(true);
      expect(saved.theme).toBe("kanagawa-wave");
      expect(saved.cursorStyle).toBe("underline");
      expect(saved.cursorBlink).toBe(false);
      expect(saved.syntaxMode).toBe("keywords");
    });
  }, 10_000);

  it("persists the global application theme mode", async () => {
    const user = userEvent.setup();
    render(<SettingsPanel />);

    await user.click(screen.getByRole("button", { name: "Dark" }));
    expect(window.localStorage.getItem(APP_THEME_STORAGE_KEY)).toBe("dark");

    await user.click(screen.getByRole("button", { name: "Follow system" }));
    expect(window.localStorage.getItem(APP_THEME_STORAGE_KEY)).toBe("system");
  });

  it("persists global UI typography settings", async () => {
    const user = userEvent.setup();
    render(<SettingsPanel />);

    // Select alternative UI font
    const fontSelect = screen.getByLabelText("UI Font Family");
    await user.selectOptions(fontSelect, '"Outfit", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif');
    expect(window.localStorage.getItem("taomni.uiFontFamily")).toContain("Outfit");

    // Slider for base size
    const sizeSlider = screen.getByLabelText("UI Base Font Size");
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(sizeSlider, { target: { value: "16" } });
    expect(window.localStorage.getItem("taomni.uiFontSize")).toBe("16");

    // Test Reset UI Font button
    const resetButton = screen.getByRole("button", { name: "Reset UI Font" });
    await user.click(resetButton);
    expect(window.localStorage.getItem("taomni.uiFontFamily")).toContain("Inter");
    expect(window.localStorage.getItem("taomni.uiFontSize")).toBe("12");
  });
});
