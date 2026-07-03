import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalAppearanceSettings } from "./TerminalAppearanceSettings";
import { setAppThemeMode } from "../../lib/appTheme";
import { DEFAULT_TERMINAL_PROFILE, SYSTEM_TERMINAL_THEME, type TerminalProfile } from "../../lib/terminalProfile";

const ipcMocks = vi.hoisted(() => ({
  listSystemFonts: vi.fn(),
  historyClear: vi.fn(async () => undefined),
}));

const runtimeMocks = vi.hoisted(() => ({
  getAppPlatform: vi.fn(() => "linux"),
}));

vi.mock("../../lib/ipc", () => ({
  ...ipcMocks,
}));

vi.mock("../../lib/runtime", () => ({
  getAppPlatform: runtimeMocks.getAppPlatform,
}));

function renderAppearance(profile: TerminalProfile = DEFAULT_TERMINAL_PROFILE) {
  const onProfileChange = vi.fn();
  render(<TerminalAppearanceSettings profile={profile} onProfileChange={onProfileChange} showCustomColors />);
  return { onProfileChange };
}

describe("TerminalAppearanceSettings", () => {
  beforeEach(() => {
    ipcMocks.listSystemFonts.mockReset();
    ipcMocks.listSystemFonts.mockResolvedValue(["Arial", "Source Code Pro", "JetBrains Mono"]);
    runtimeMocks.getAppPlatform.mockReset();
    runtimeMocks.getAppPlatform.mockReturnValue("linux");
    setAppThemeMode("system");
  });

  afterEach(() => {
    cleanup();
  });

  it("lists OS fonts and selects system monospace by default", async () => {
    renderAppearance();

    await waitFor(() => expect(screen.getByRole("option", { name: "Source Code Pro" })).toBeInTheDocument());

    expect(screen.getByLabelText("Terminal font")).toHaveValue("monospace");
    expect(screen.getByRole("option", { name: "Arial" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Fira Code" })).not.toBeInTheDocument();
  });

  it("uses a safe fallback font list when OS font loading fails", async () => {
    ipcMocks.listSystemFonts.mockRejectedValueOnce(new Error("font access failed"));

    renderAppearance();

    await waitFor(() => expect(screen.getByRole("option", { name: "Source Code Pro" })).toBeInTheDocument());
    expect(screen.getByRole("option", { name: "Fira Code" })).toBeInTheDocument();
  });

  it("updates the preview when a theme is selected", async () => {
    const user = userEvent.setup();
    const { onProfileChange } = renderAppearance();

    await user.click(screen.getByTestId("terminal-theme-select"));
    await user.click(screen.getByTestId("terminal-theme-option-kanagawa-wave"));

    expect(onProfileChange).toHaveBeenLastCalledWith(expect.objectContaining({ theme: "kanagawa-wave" }));
  });

  it("resolves the app-following terminal theme from the application theme", () => {
    setAppThemeMode("dark");
    render(
      <TerminalAppearanceSettings
        profile={{ ...DEFAULT_TERMINAL_PROFILE, theme: SYSTEM_TERMINAL_THEME }}
        onProfileChange={vi.fn()}
        showCustomColors
        allowSystemTheme
      />,
    );

    expect(screen.getByTestId("terminal-theme-select")).toHaveTextContent("Match app theme");
  });

  it("merges successive edits before the parent rerenders", async () => {
    const user = userEvent.setup();
    const { onProfileChange } = renderAppearance();

    await waitFor(() => expect(screen.getByRole("option", { name: "JetBrains Mono" })).toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText("Terminal font"), "JetBrains Mono");
    const fontSize = screen.getByLabelText("Terminal font size");
    await user.clear(fontSize);
    await user.type(fontSize, "18");
    await user.click(screen.getByTestId("terminal-theme-select"));
    await user.click(screen.getByTestId("terminal-theme-option-kanagawa-wave"));

    expect(onProfileChange).toHaveBeenLastCalledWith(expect.objectContaining({
      fontFamily: expect.stringContaining("JetBrains Mono"),
      fontSize: 18,
      theme: "kanagawa-wave",
    }));
  });

  it("renders terminal profile controls before the bottom preview", async () => {
    renderAppearance();

    await waitFor(() => expect(screen.getByLabelText("Terminal cursor")).toBeInTheDocument());

    const cursor = screen.getByLabelText("Terminal cursor");
    const preview = screen.getByTestId("terminal-preview");
    expect(cursor.compareDocumentPosition(preview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("reflects cursor style and blink setting in the preview", async () => {
    renderAppearance({
      ...DEFAULT_TERMINAL_PROFILE,
      cursorStyle: "underline",
      cursorBlink: false,
    });

    const cursor = await screen.findByTestId("terminal-preview-cursor");
    expect(cursor).toHaveStyle({ borderBottom: expect.stringContaining("solid") });
    expect(cursor).not.toHaveClass("taomni-blink");
  });

  it("updates the remote OSC 52 clipboard setting", async () => {
    const user = userEvent.setup();
    const { onProfileChange } = renderAppearance();

    await user.click(screen.getByRole("checkbox", { name: "Allow SSH OSC 52 clipboard" }));

    expect(onProfileChange).toHaveBeenLastCalledWith(expect.objectContaining({
      allowRemoteOsc52Clipboard: true,
    }));
  });

  it("hides the WebGL renderer setting outside Windows", () => {
    renderAppearance();

    expect(screen.queryByRole("checkbox", { name: "Use WebGL renderer" })).not.toBeInTheDocument();
  });

  it("updates the Windows WebGL renderer setting", async () => {
    runtimeMocks.getAppPlatform.mockReturnValue("windows");
    const user = userEvent.setup();
    const { onProfileChange } = renderAppearance();

    const checkbox = screen.getByRole("checkbox", { name: "Use WebGL renderer" });
    expect(checkbox).toBeChecked();

    await user.click(checkbox);

    expect(onProfileChange).toHaveBeenLastCalledWith(expect.objectContaining({
      webglRenderer: false,
    }));
  });
});
