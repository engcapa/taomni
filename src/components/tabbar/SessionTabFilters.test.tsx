import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionTabFilters } from "./SessionTabFilters";
import { useAppStore } from "../../stores/appStore";
import { useSessionStore } from "../../stores/sessionStore";
import { filterVisibleTabs, sessionTabCategory } from "../../lib/tabFilter";
import type { Tab } from "../../types";

const tabs: Tab[] = [
  { id: "local", type: "terminal", title: "Local", closable: true },
  { id: "ssh", type: "terminal", title: "SSH", closable: true, ssh: { host: "10.0.0.1", port: 22, username: "root", authMethod: "Password", authData: "" } },
  { id: "db", type: "database", title: "MySQL", closable: true },
  { id: "redis", type: "redis", title: "Redis", closable: true },
  { id: "hbase", type: "hbase-shell", title: "HBase", closable: true },
  { id: "sftp", type: "sftp", title: "SFTP", closable: true },
  { id: "rdp", type: "rdp", title: "RDP", closable: true },
  { id: "vnc", type: "vnc", title: "VNC", closable: true },
  { id: "mail", type: "mail", title: "Mail", closable: true },
];
const visible = () => {
  const state = useAppStore.getState();
  return filterVisibleTabs(state.tabs, [], state.tabFilter).map((tab) => tab.id);
};
function select(category: string) {
  fireEvent.click(screen.getByTestId("session-tab-filter"));
  fireEvent.click(screen.getByTestId(`session-tab-filter-${category}`));
}

beforeEach(() => {
  useAppStore.setState({ tabs, activeTabId: "local", activeSideTab: "sessions", tabFilter: null });
  useSessionStore.setState({ sessions: [] });
});
afterEach(cleanup);

describe("Sessions compact category selector", () => {
  it("classifies protocols and keeps database and remote desktop families together", () => {
    expect(tabs.map((tab) => sessionTabCategory(tab, []))).toEqual(["local", "ssh", "database", "database", "database", "sftp", "remote", "remote", "other"]);
  });

  it("switches focus to the first match without destroying or duplicating sessions", () => {
    render(<SessionTabFilters />);
    select("database");
    expect(visible()).toEqual(["db", "redis", "hbase"]);
    expect(useAppStore.getState().activeTabId).toBe("db");
    expect(useAppStore.getState().tabs).toEqual(tabs);
    select("remote");
    expect(visible()).toEqual(["rdp", "vnc"]);
    expect(useAppStore.getState().activeTabId).toBe("rdp");
    select("all");
    expect(visible()).toHaveLength(tabs.length);
  });

  it("combines protocol and text filters, and clearing protocol retains the query", () => {
    useAppStore.setState({ tabFilter: { kind: "query", text: "S" } });
    render(<SessionTabFilters />);
    select("database");
    expect(visible()).toEqual(["db", "redis", "hbase"]);
    expect(useAppStore.getState().tabFilter).toEqual({ kind: "query", text: "S", protocol: "database" });
    select("all");
    expect(useAppStore.getState().tabFilter).toMatchObject({ kind: "query", text: "S" });
    expect(visible()).toEqual(["ssh", "db", "redis", "hbase", "sftp"]);
  });

  it("recovers from an empty category without changing the running instance list", () => {
    useAppStore.setState({ tabs: tabs.slice(0, 1) });
    render(<SessionTabFilters />);
    select("ssh");
    expect(visible()).toEqual([]);
    expect(useAppStore.getState().activeTabId).toBe("local");
    select("local");
    expect(visible()).toEqual(["local"]);
  });
});
