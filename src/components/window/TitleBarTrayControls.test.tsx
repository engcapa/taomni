import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TitleBarTrayControls } from "./TitleBarTrayControls";
import { useState } from "react";
import { TabActions, TabActionSlotProvider } from "../tabbar/TabActionSlot";

const mocks = vi.hoisted(() => ({
  theme: {
    mode: "dark" as const,
    resolvedTheme: "dark" as const,
    setMode: vi.fn(),
  },
  app: {
    terminalSplitActive: false,
    multiExecActive: false,
    toggleTerminalSplit: vi.fn(),
    toggleMultiExec: vi.fn(),
  },
}));

vi.mock("../../lib/appTheme", () => ({
  useAppTheme: () => mocks.theme,
}));

vi.mock("../../stores/appStore", () => ({
  useAppStore: (selector: (state: typeof mocks.app) => unknown) => selector(mocks.app),
}));

vi.mock("../../stores/aiStore", () => ({
  useAiStore: (selector: (state: { config: { fully_disabled: boolean } }) => unknown) =>
    selector({ config: { fully_disabled: true } }),
}));

vi.mock("../../lib/i18n/labels", () => ({
  useAppThemeI18nLabel: () => (mode: string) => mode,
}));

vi.mock("./LanguageSwitcher", () => ({
  LanguageSwitcher: () => <button type="button" data-testid="language-switcher" />,
}));

describe("TitleBarTrayControls responsive layout", () => {
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1024,
      writable: true,
    });
    mocks.theme.mode = "dark";
    mocks.theme.resolvedTheme = "dark";
    mocks.app.terminalSplitActive = false;
    mocks.app.multiExecActive = false;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("keeps the full tray at normal widths", () => {
    render(<TitleBarTrayControls />);

    expect(screen.getByTestId("titlebar-tray")).toBeInTheDocument();
    expect(screen.queryByTestId("titlebar-actions-more")).not.toBeInTheDocument();
  });

  it("moves tray actions into one compact menu at narrow widths", () => {
    window.innerWidth = 800;
    render(<TitleBarTrayControls />);

    expect(screen.queryByTestId("titlebar-tray")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("titlebar-actions-more"));

    expect(screen.getByTestId("titlebar-actions-menu")).toBeInTheDocument();
    expect(screen.getByTestId("tab-split-view")).toBeInTheDocument();
    expect(screen.getByTestId("tab-multiexec-toggle")).toBeInTheDocument();
    // v6.1 AC-04: theme/language moved to the primary rail bottom group.
    expect(screen.queryByTestId("theme-cycle")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("tab-split-view"));
    expect(mocks.app.toggleTerminalSplit).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("titlebar-actions-menu")).not.toBeVisible();
  });

  it("switches layout when the window crosses the breakpoint", async () => {
    render(<TitleBarTrayControls />);
    expect(screen.getByTestId("titlebar-tray")).toBeInTheDocument();

    window.innerWidth = 800;
    fireEvent(window, new Event("resize"));

    await waitFor(() => {
      expect(screen.getByTestId("titlebar-actions-more")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("titlebar-tray")).not.toBeInTheDocument();
  });

  it("keeps contextual controls mounted across close/reopen and never offers title-bar voice", () => {
    const detach = vi.fn();
    function Shell() {
      const [slot, setSlot] = useState<HTMLDivElement | null>(null);
      return <>
        <TitleBarTrayControls compact layoutActions={false} slotRef={setSlot} />
        <TabActionSlotProvider slot={slot}><TabActions active>
          <button type="button" title="Detach terminal" data-testid="terminal-detach" onClick={detach}><svg /></button>
        </TabActions></TabActionSlotProvider>
      </>;
    }
    render(<Shell />);
    const action = screen.getByTestId("terminal-detach");
    expect(action).not.toBeVisible();
    fireEvent.click(screen.getByTestId("titlebar-actions-more"));
    expect(action).toBeVisible();
    expect(action).toHaveTextContent("Detach terminal");
    expect(screen.queryByTestId("ptt-button")).not.toBeInTheDocument();
    fireEvent.click(action);
    expect(detach).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("terminal-detach")).toBe(action);
    expect(action).not.toBeVisible();
    fireEvent.click(screen.getByTestId("titlebar-actions-more"));
    fireEvent.keyDown(action, { key: "Escape" });
    expect(screen.getByTestId("titlebar-actions-more")).toHaveFocus();
    expect(action).not.toBeVisible();
  });
});
