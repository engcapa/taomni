import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../../sidebar/Sidebar";
import { HomeSidebar } from "../HomeSidebar";
import { useAppStore } from "../../../stores/appStore";
import { useSessionStore } from "../../../stores/sessionStore";
import type { SessionConfig } from "../../../lib/ipc";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
}));

function session(id: string, name: string): SessionConfig {
  return {
    id,
    name,
    session_type: "SSH",
    group_path: null,
    host: "10.0.0.8",
    port: 22,
    username: "root",
    auth_method: "None",
    options_json: "{}",
    created_at: 0,
    updated_at: 0,
    last_connected_at: Date.now(),
    sort_order: 0,
  };
}

describe("Home mode and Sessions sidebar parity (TASK-08)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useAppStore.setState({ activeSideTab: "home", sidebarCollapsed: false });
    useSessionStore.setState({
      sessions: [session("s1", "prod-gateway"), session("s2", "prod-mysql")],
      selectedSessionIds: [],
      loading: false,
      groups: [],
      selectedSessionId: null,
      searchQuery: "",
    });
  });

  afterEach(() => cleanup());

  it("Home mode renders the Home sidebar with quick actions and recent sessions", () => {
    const onNewSession = vi.fn();
    const onConnectSession = vi.fn();
    render(
      <HomeSidebar
        onNewSession={onNewSession}
        onConnectSession={onConnectSession}
        sessions={useSessionStore.getState().sessions}
      />,
    );
    expect(screen.getByTestId("home-sidebar")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("home-sidebar-new-session"));
    expect(onNewSession).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("home-sidebar-recent-s1"));
    expect(onConnectSession).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }));
  });

  it("Home is the first rail mode and clicking it keeps the welcome content surface available", () => {
    render(<Sidebar compact={false} />);
    const rail = screen.getByTestId("sidebar-rail");
    const home = rail.querySelector('[data-testid="nav-mode-home"]');
    const workspaces = rail.querySelector('[data-testid="nav-mode-workspaces"]');
    expect(home).toBeTruthy();
    expect(workspaces).toBeTruthy();
    expect(
      (home as HTMLElement).compareDocumentPosition(workspaces as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("Sessions mode keeps the full 7-button toolbar, filters and SessionTree", () => {
    useAppStore.setState({ activeSideTab: "sessions" });
    render(<Sidebar compact={false} />);
    for (const testId of ["session-new", "session-edit", "session-duplicate", "session-delete", "session-search"]) {
      expect(screen.getByTestId(testId)).toBeInTheDocument();
    }
    expect(screen.getByTestId("session-tree")).toBeInTheDocument();
  });

  it("Sessions mode keeps the ℹ️ / ⋯ toolbar affordances out of the sidebar and in the shared bar", () => {
    // The details hover and open-tabs menu live in the ControlBar; the
    // Sessions sidebar itself renders no quick-connect chips or breadcrumbs.
    useAppStore.setState({ activeSideTab: "sessions" });
    render(<Sidebar compact={false} />);
    expect(screen.queryByTestId("tab-details-hover")).not.toBeInTheDocument();
    expect(screen.queryByTestId("tab-more")).not.toBeInTheDocument();
    expect(screen.queryByTestId("quick-connect")).not.toBeInTheDocument();
  });
});
