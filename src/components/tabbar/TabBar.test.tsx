import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TabBar } from "./TabBar";
import { useAppStore } from "../../stores/appStore";
import type { Tab } from "../../types";

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
    useAppStore.setState({
      tabs: Array.from({ length: 12 }, (_, index) => makeTab(index)),
      activeTabId: "tab-0",
      compactMode: false,
      multiExecActive: false,
      multiExecSelectedTabIds: new Set(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    useAppStore.setState({
      tabs: [{ id: "welcome", type: "welcome", title: "Welcome", closable: false }],
      activeTabId: "welcome",
      compactMode: false,
      multiExecActive: false,
      multiExecSelectedTabIds: new Set(),
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

  it("lists all open tabs from the more menu and switches to the selected tab", () => {
    renderTabBar();

    fireEvent.click(screen.getByTestId("tab-more"), { clientX: 500, clientY: 24 });

    expect(screen.getByTestId("tab-more-tab-tab-0")).toBeInTheDocument();
    expect(screen.getByTestId("tab-more-tab-tab-11")).toBeInTheDocument();
    expect(
      screen.getByTestId("context-menu-item-close-all-terminals")
        .compareDocumentPosition(screen.getByTestId("tab-more-tab-tab-0")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    const menuChildren = Array.from(screen.getByTestId("context-menu").children);
    const firstTabIndex = menuChildren.indexOf(screen.getByTestId("tab-more-tab-tab-0"));
    expect(menuChildren[firstTabIndex - 1].tagName).toBe("DIV");
    expect(menuChildren.at(-1)).toBe(screen.getByTestId("tab-more-tab-tab-11"));

    fireEvent.click(screen.getByTestId("tab-more-tab-tab-5"));

    expect(useAppStore.getState().activeTabId).toBe("tab-5");
  });
});
