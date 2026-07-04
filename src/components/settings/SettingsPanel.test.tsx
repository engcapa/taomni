import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppThemeMode } from "../../lib/appTheme";
import { useAppStore } from "../../stores/appStore";
import { SettingsPanel } from "./SettingsPanel";

const ipcMocks = vi.hoisted(() => ({
  listSystemFonts: vi.fn(),
  getAppProxyConfig: vi.fn(),
  listSessions: vi.fn(),
}));

vi.mock("../../lib/ipc", () => ({
  ...ipcMocks,
}));

const CODE_VIEW_STORAGE_KEY = "taomni.codeViewProfile.v1";
const APP_THEME_STORAGE_KEY = "taomni.appTheme.v1";
const TERMINAL_DEFAULT_STORAGE_KEY = "taomni.terminalDefaultProfile.v1";

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
    useAppStore.setState({ welcomeRecentSessionLimit: 20 });
    setAppThemeMode("system");
    // jsdom has no layout engine; search scroll-to-match calls this.
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    cleanup();
  });

  it("exposes terminal defaults instead of legacy terminal appearance settings", () => {
    render(<SettingsPanel />);

    expect(screen.queryByText("Terminal Appearance")).not.toBeInTheDocument();
    expect(screen.getByText("Terminal Defaults")).toBeInTheDocument();
    expect(screen.getByTestId("terminal-appearance-settings")).toBeInTheDocument();
    expect(screen.getByTestId("terminal-theme-select")).toBeInTheDocument();
  });

  it("persists the global application theme mode", async () => {
    const user = userEvent.setup();
    render(<SettingsPanel />);

    await user.click(screen.getByTestId("app-theme-select"));
    await user.click(screen.getByTestId("app-theme-dark"));
    expect(window.localStorage.getItem(APP_THEME_STORAGE_KEY)).toBe("dark");

    await user.click(screen.getByTestId("app-theme-select"));
    await user.click(screen.getByTestId("app-theme-system"));
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

  it("persists code view appearance settings", async () => {
    const user = userEvent.setup();
    render(<SettingsPanel />);

    const codeFontSelect = screen.getByLabelText("Code font");
    await waitFor(() => expect(within(codeFontSelect).getByRole("option", { name: "JetBrains Mono" })).toBeInTheDocument());

    await user.selectOptions(codeFontSelect, "JetBrains Mono");
    const fontSize = screen.getByLabelText("Code font size");
    await user.clear(fontSize);
    await user.type(fontSize, "15");
    await user.click(screen.getByLabelText("Enable code font ligatures"));
    await user.click(screen.getByTestId("code-theme-select"));
    await user.click(screen.getByTestId("code-theme-option-terminal-kanagawa-wave"));

    await waitFor(() => {
      const saved = JSON.parse(window.localStorage.getItem(CODE_VIEW_STORAGE_KEY) ?? "{}");
      expect(saved.fontFamily).toContain("JetBrains Mono");
      expect(saved.fontSize).toBe(15);
      expect(saved.fontLigatures).toBe(false);
      expect(saved.theme).toBe("terminal:kanagawa-wave");
    });
  }, 10_000);

  it("persists global terminal default behavior settings", async () => {
    const user = userEvent.setup();
    render(<SettingsPanel />);

    const terminalFontSelect = screen.getByLabelText("Terminal font");
    await waitFor(() => expect(within(terminalFontSelect).getByRole("option", { name: "JetBrains Mono" })).toBeInTheDocument());

    await user.selectOptions(terminalFontSelect, "JetBrains Mono");
    fireEvent.change(screen.getByLabelText("Scrollback lines"), { target: { value: "4321" } });
    await user.click(screen.getByLabelText("Read-only terminal"));

    await waitFor(() => {
      const saved = JSON.parse(window.localStorage.getItem(TERMINAL_DEFAULT_STORAGE_KEY) ?? "{}");
      expect(saved.fontFamily).toContain("JetBrains Mono");
      expect(saved.scrollback).toBe(4321);
      expect(saved.readOnly).toBe(true);
    });
  });

  it("persists the welcome recent session history limit", () => {
    render(<SettingsPanel />);

    const input = screen.getByLabelText("Recent session history limit");
    fireEvent.change(input, { target: { value: "35" } });

    expect(useAppStore.getState().welcomeRecentSessionLimit).toBe(35);
    expect(window.localStorage.getItem("taomni.welcomeRecentSessionLimit")).toBe("35");
  });

  it("highlights settings matching the search query", async () => {
    const user = userEvent.setup();
    const { container } = render(<SettingsPanel />);

    const search = screen.getByTestId("settings-search-input");
    await user.type(search, "proxy");

    const proxy = container.querySelector('[data-search-id="app-proxy"]');
    const language = container.querySelector('[data-search-id="language"]');
    expect(proxy).toHaveAttribute("data-search-match", "true");
    expect(language).toHaveAttribute("data-search-match", "false");

    // Match counter reflects the single hit.
    expect(screen.getByTestId("settings-search-count")).toHaveTextContent("1 / 1");

    // Clearing the search drops the active state entirely.
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(search).toHaveValue("");
    expect(
      container.querySelector('[data-search-id="app-proxy"]'),
    ).not.toHaveAttribute("data-search-match");
  });

  it("highlights Codex settings from a codex search query", async () => {
    const user = userEvent.setup();
    const { container } = render(<SettingsPanel />);

    await user.type(screen.getByTestId("settings-search-input"), "codex");

    const codex = container.querySelector('[data-search-id="ai-codex"]');
    const claude = container.querySelector('[data-search-id="ai-claude"]');
    expect(codex).toHaveAttribute("data-search-match", "true");
    expect(claude).toHaveAttribute("data-search-match", "false");
    expect(screen.getByTestId("settings-search-count")).toHaveTextContent("1 / 1");
  });

  it("shows an empty state when no setting matches", async () => {
    const user = userEvent.setup();
    render(<SettingsPanel />);

    await user.type(screen.getByTestId("settings-search-input"), "zzzznomatch");
    expect(screen.getByTestId("settings-search-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("settings-search-count")).not.toBeInTheDocument();
  });
});
