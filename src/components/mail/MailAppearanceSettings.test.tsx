import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MailAppearanceSettings } from "./MailAppearanceSettings";
import { DEFAULT_MAIL_TERMINAL_PROFILE, type TerminalProfile } from "../../lib/terminalProfile";

const ipcMocks = vi.hoisted(() => ({
  listSystemFonts: vi.fn(),
}));

vi.mock("../../lib/ipc", () => ({
  ...ipcMocks,
}));

function renderAppearance(profile: TerminalProfile = DEFAULT_MAIL_TERMINAL_PROFILE) {
  const onProfileChange = vi.fn();
  render(<MailAppearanceSettings profile={profile} onProfileChange={onProfileChange} />);
  return { onProfileChange };
}

describe("MailAppearanceSettings", () => {
  beforeEach(() => {
    ipcMocks.listSystemFonts.mockReset();
    ipcMocks.listSystemFonts.mockResolvedValue(["Arial", "Inter", "JetBrains Mono"]);
  });

  afterEach(() => {
    cleanup();
  });

  it("updates mail font, text size, and theme in one profile", async () => {
    const user = userEvent.setup();
    const { onProfileChange } = renderAppearance();

    await user.click(screen.getByLabelText("Mail font"));
    await user.click(await screen.findByRole("option", { name: "JetBrains Mono" }));
    const fontSize = screen.getByLabelText("Mail font size");
    await user.clear(fontSize);
    await user.type(fontSize, "18");
    await user.click(screen.getByTestId("mail-theme-select"));
    await user.click(screen.getByTestId("mail-theme-option-code-dracula"));

    expect(onProfileChange).toHaveBeenLastCalledWith(expect.objectContaining({
      fontFamily: expect.stringContaining("JetBrains Mono"),
      fontSize: 18,
      theme: "code:dracula",
    }));
  });
});
