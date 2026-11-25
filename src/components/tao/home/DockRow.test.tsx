import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearPendingSettingsSection, consumePendingSettingsSection } from "../../../lib/settingsNavigation";
import { DEFAULT_CONFIG } from "../../../stores/ai/defaults";
import { useAiStore } from "../../../stores/aiStore";
import type { TaoChatController } from "../ai-chat";
import { DockRow } from "./DockRow";
import { TaoHomeHost } from "./TaoHomeHost";

vi.mock("../../welcome/useWelcomeShells", () => ({
  useWelcomeShells: () => ({ shellStatus: "ready", selectedShell: undefined, wslDistros: [], wslStatus: "ready", localDirectories: [], mergedShells: [] }),
}));
vi.mock("./useThreadHistory", () => ({
  useThreadHistory: () => ({ loading: false, error: "", refresh: vi.fn(), remove: vi.fn() }),
}));

const initialAi = useAiStore.getState();
afterEach(() => { cleanup(); clearPendingSettingsSection(); useAiStore.setState(initialAi); });

describe("Tao Home module navigation", () => {
  it("shows Browse modules on the actual Home dock and selects the store before opening Settings", () => {
    const onOpenSettings = vi.fn(() => {
      expect(consumePendingSettingsSection()).toEqual({ id: "module-store", presetId: null });
    });
    render(<DockRow controller={{} as TaoChatController} threads={[]} recentSessions={[]} recentWorkspaces={[]}
      demoMode={false} onStartLocalTerminal={vi.fn()} onNewSession={vi.fn()} onOpenSettings={onOpenSettings} />);
    fireEvent.click(screen.getByTestId("welcome-browse-modules"));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("keeps the Module Store and Tao settings destinations distinct through the actual Home host", () => {
    useAiStore.setState({ config: DEFAULT_CONFIG });
    const destinations: string[] = [];
    const onOpenSettings = vi.fn(() => {
      destinations.push(consumePendingSettingsSection()?.id ?? "none");
    });
    render(<TaoHomeHost onStartLocalTerminal={vi.fn()} onNewSession={vi.fn()} onOpenSettings={onOpenSettings} />);
    expect(screen.getByTestId("tao-home-open-settings")).toHaveAttribute("data-primary", "true");
    fireEvent.click(screen.getByTestId("welcome-browse-modules"));
    expect(destinations).toEqual(["module-store"]);
    fireEvent.click(screen.getByTestId("tao-home-dock-more"));
    fireEvent.click(screen.getByTestId("tao-home-dock-settings"));
    expect(destinations).toEqual(["module-store", "ai-tao"]);
    expect(onOpenSettings).toHaveBeenCalledTimes(2);
  });
});
