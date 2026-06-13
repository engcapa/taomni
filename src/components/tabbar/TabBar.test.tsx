import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TabBar } from "./TabBar";
import { useAppStore } from "../../stores/appStore";
import { useSessionStore } from "../../stores/sessionStore";
import type { Tab } from "../../types";
import type { SessionConfig } from "../../lib/ipc";

const ipcMocks = vi.hoisted(() => ({
  listLocalShells: vi.fn(async () => []),
  listWslDistros: vi.fn(async () => []),
}));

vi.mock("../../lib/ipc", () => ipcMocks);

const makeTab = (index: number): Tab => ({
  id: `tab-${index}`,
  type: "terminal",
  title: `Terminal ${index}`,
  closable: true,
});

function renderTabBar() {
  return render(
    <TabBar
      onStartLocalTerminal={vi.fn()}
      onConnectSession={vi.fn()}
      onOpenSessionEditor={vi.fn()}
    />,
  );
}

function mockHorizontalOverflow(
  el: HTMLElement,
  sizes: { clientWidth: number; scrollWidth: number; scrollLeft?: number },
) {
  let scrollLeft = sizes.scrollLeft ?? 0;
  Object.defineProperty(el, "clientWidth", {
    configurable: true,
    get: () => sizes.clientWidth,
  });
  Object.defineProperty(el, "scrollWidth", {
    configurable: true,
    get: () => sizes.scrollWidth,
  });
  Object.defineProperty(el, "scrollLeft", {
    configurable: true,
    get: () => scrollLeft,
    set: (value: number) => {
      scrollLeft = value;
    },
  });
  Object.defineProperty(el, "scrollTo", {
    configurable: true,
    value: vi.fn((options?: ScrollToOptions) => {
      scrollLeft = Number(options?.left ?? 0);
    }),
  });
  return {
    get scrollLeft() {
      return scrollLeft;
    },
  };
}

describe("TabBar overflow navigation", () => {
  beforeEach(() => {
    useSessionStore.setState({ sessions: [] });
    useAppStore.setState({
      tabs: Array.from({ length: 12 }, (_, index) => makeTab(index)),
      activeTabId: "tab-0",
      compactMode: false,
      multiExecActive: false,
      multiExecSelectedTabIds: new Set(),
      tabFilter: null,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    useSessionStore.setState({ sessions: [] });
    useAppStore.setState({
      tabs: [{ id: "welcome", type: "welcome", title: "Welcome", closable: false }],
      activeTabId: "welcome",
      compactMode: false,
      multiExecActive: false,
      multiExecSelectedTabIds: new Set(),
      tabFilter: null,
    });
  });

  it("shows scroll buttons when the tab list overflows and scrolls by page steps", async () => {
    renderTabBar();
    const scrollArea = screen.getByTestId("tab-scroll-area");
    const scroll = mockHorizontalOverflow(scrollArea, { clientWidth: 300, scrollWidth: 1200 });

    fireEvent.scroll(scrollArea);

    const right = await screen.findByTestId("tab-scroll-right");
    const left = screen.getByTestId("tab-scroll-left");
    expect(left).toBeDisabled();
    expect(right).not.toBeDisabled();

    fireEvent.click(right);

    await waitFor(() => {
      expect(scroll.scrollLeft).toBeGreaterThan(0);
      expect(screen.getByTestId("tab-scroll-left")).not.toBeDisabled();
    });
  });

  it("keeps scroll buttons hidden when all tabs fit", () => {
    renderTabBar();
    const scrollArea = screen.getByTestId("tab-scroll-area");
    mockHorizontalOverflow(scrollArea, { clientWidth: 1200, scrollWidth: 900 });

    fireEvent.scroll(scrollArea);

    expect(screen.queryByTestId("tab-scroll-left")).not.toBeInTheDocument();
    expect(screen.queryByTestId("tab-scroll-right")).not.toBeInTheDocument();
  });

  it("lists all open tabs in the more menu and switches to the selected tab", () => {
    renderTabBar();

    fireEvent.click(screen.getByTestId("tab-more"));

    const menu = screen.getByTestId("open-tabs-menu");
    // Portaled to body so the strip's `overflow-hidden` can't clip it.
    expect(menu.closest('[data-testid="tab-bar"]')).toBeNull();
    expect(menu.parentElement).toBe(document.body);
    // All sections render: actions, search box, and the tab list.
    expect(within(menu).getByText("Close all terminals")).toBeInTheDocument();
    expect(within(menu).getByTestId("open-tabs-filter")).toBeInTheDocument();
    expect(within(menu).getByTestId("open-tabs-tab-tab-0")).toBeInTheDocument();
    expect(within(menu).getByTestId("open-tabs-tab-tab-11")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("open-tabs-tab-tab-5"));

    expect(useAppStore.getState().activeTabId).toBe("tab-5");
    // Picking a tab closes the menu.
    expect(screen.queryByTestId("open-tabs-menu")).not.toBeInTheDocument();
  });

  it("filters the strip by a fuzzy query and restores it via the chip", async () => {
    renderTabBar();
    const scrollArea = screen.getByTestId("tab-scroll-area");
    expect(within(scrollArea).getAllByTestId("tab-item")).toHaveLength(12);

    fireEvent.click(screen.getByTestId("tab-more"));
    fireEvent.change(screen.getByTestId("open-tabs-filter"), {
      target: { value: "Terminal 5" },
    });

    await waitFor(() => {
      expect(within(scrollArea).getAllByTestId("tab-item")).toHaveLength(1);
    });
    expect(within(scrollArea).getByTestId("tab-title")).toHaveTextContent("Terminal 5");
    // The hidden active tab was swapped for the first match.
    expect(useAppStore.getState().activeTabId).toBe("tab-5");

    const chip = screen.getByTestId("tab-filter-chip");
    expect(chip).toBeInTheDocument();
    fireEvent.click(chip);

    await waitFor(() => {
      expect(within(scrollArea).getAllByTestId("tab-item")).toHaveLength(12);
    });
    expect(useAppStore.getState().tabFilter).toBeNull();
  });

  it("focuses the strip on a directory via the group header", async () => {
    const session: SessionConfig = {
      id: "s1",
      name: "cap-mitm",
      session_type: "SSH",
      group_path: "User sessions / proj / cap",
      host: "10.0.0.1",
      port: 22,
      username: "root",
      auth_method: "Password",
      options_json: "{}",
      created_at: 0,
      updated_at: 0,
      last_connected_at: null,
      sort_order: 0,
    };
    useSessionStore.setState({ sessions: [session] });
    useAppStore.setState({
      tabs: [
        { id: "t-cap", type: "terminal", title: "cap-mitm", closable: true, sessionId: "s1" },
        { id: "t-local", type: "terminal", title: "PowerShell", closable: true },
      ],
      activeTabId: "t-local",
      tabFilter: null,
    });
    renderTabBar();

    fireEvent.click(screen.getByTestId("tab-more"));
    fireEvent.click(screen.getByTestId("open-tabs-group-proj-cap"));

    const scrollArea = screen.getByTestId("tab-scroll-area");
    await waitFor(() => {
      expect(within(scrollArea).getAllByTestId("tab-item")).toHaveLength(1);
    });
    expect(within(scrollArea).getByTestId("tab-title")).toHaveTextContent("cap-mitm");
    // Active tab was outside the directory, so it jumps to the matching one.
    expect(useAppStore.getState().activeTabId).toBe("t-cap");
  });
});
