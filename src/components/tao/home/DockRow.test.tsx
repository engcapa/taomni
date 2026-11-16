import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearPendingSettingsSection, consumePendingSettingsSection } from "../../../lib/settingsNavigation";
import type { TaoChatController } from "../ai-chat";
import { DockRow } from "./DockRow";

vi.mock("../../welcome/useWelcomeShells", () => ({
  useWelcomeShells: () => ({ shellStatus: "ready", selectedShell: undefined, wslDistros: [], wslStatus: "ready" }),
}));

afterEach(() => { cleanup(); clearPendingSettingsSection(); });

describe("Tao Home module navigation", () => {
  it("shows Browse modules on the actual Home dock and selects the store before opening Settings", () => {
    const onOpenSettings = vi.fn(() => {
      expect(consumePendingSettingsSection()).toEqual({ id: "module-store", presetId: null });
    });
    render(<DockRow controller={{} as TaoChatController} threads={[]} sessions={[]} workspaces={[]}
      demoMode={false} onStartLocalTerminal={vi.fn()} onNewSession={vi.fn()} onOpenSettings={onOpenSettings} />);
    fireEvent.click(screen.getByTestId("welcome-browse-modules"));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});
