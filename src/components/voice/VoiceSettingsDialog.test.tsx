import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAiStore } from "../../stores/aiStore";
import { VoiceSettingsDialog, useVoiceSettingsStore } from "./VoiceSettingsDialog";

vi.mock("../settings/AsrPanel", () => ({
  AsrPanel: () => (
    <div data-testid="asr-panel-stub">
      <button type="button" data-testid="asr-stub-action">Check</button>
    </div>
  ),
}));

beforeEach(() => {
  useAiStore.setState({ config: null });
  useVoiceSettingsStore.setState({ open: false });
});

afterEach(() => cleanup());

describe("VoiceSettingsDialog", () => {
  it("opens in the modal top layer, traps Tab, guards IME Escape, and restores trigger focus", () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();

    render(<VoiceSettingsDialog />);
    expect(screen.queryByTestId("voice-settings-dialog")).not.toBeInTheDocument();

    act(() => {
      useVoiceSettingsStore.getState().setOpen(true);
    });

    const dialog = screen.getByTestId("voice-settings-dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("data-size", "complex");

    const close = screen.getByTestId("voice-settings-close");
    const action = screen.getByTestId("asr-stub-action");
    expect(close).toHaveFocus();

    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(action).toHaveFocus();
    fireEvent.keyDown(action, { key: "Tab" });
    expect(close).toHaveFocus();

    fireEvent.keyDown(close, { key: "Escape", isComposing: true });
    expect(useVoiceSettingsStore.getState().open).toBe(true);

    fireEvent.keyDown(close, { key: "Escape" });
    expect(useVoiceSettingsStore.getState().open).toBe(false);
    expect(screen.queryByTestId("voice-settings-dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });
});
