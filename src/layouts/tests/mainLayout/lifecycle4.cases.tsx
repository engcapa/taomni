import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { markSessionConnected, type SessionConfig } from "../../../lib/ipc";
import { useAppStore } from "../../../stores/appStore";
import { useSessionStore } from "../../../stores/sessionStore";
import { MainLayout } from "../../MainLayout";
import { latestQuickConnectProps, latestSidebarProps, makePasswordSession, sidebarMock, vaultMock } from "./harness";

export function registerMainLayoutLifecycle4Cases() {

  it.each<[string, string, string, string, number, string]>([
    ["Telnet", "telnet-1", "Legacy shell", "legacy.example.test", 23, "ops"],
    ["FTP", "ftp-1", "Files", "files.example.test", 21, "deploy"],
  ])("opens %s saved sessions in a terminal tab", async (sessionType, id, name, host, port, username) => {
    render(<MainLayout />);

    const session: SessionConfig = {
      id,
      name,
      session_type: sessionType,
      group_path: null,
      host,
      port,
      username,
      auth_method: "None",
      options_json: "{}",
      created_at: 0,
      updated_at: 0,
      last_connected_at: null,
      sort_order: 0,
    };
    useSessionStore.setState({ sessions: [session], groups: [] });

    await act(async () => {
      sidebarMock.props.at(-1)?.onConnectSession?.(session);
    });

    await waitFor(() => {
      expect(
        screen.getAllByTestId("terminal-panel").some((node) =>
          node.getAttribute("data-command-kind") === sessionType),
      ).toBe(true);
    });
    const terminal = screen.getAllByTestId("terminal-panel").find((node) =>
      node.getAttribute("data-command-kind") === sessionType);
    if (!terminal) throw new Error(`${sessionType} terminal panel not found`);
    expect(terminal).toHaveAttribute("data-command-kind", sessionType);
    expect(terminal).toHaveAttribute("data-command-host", host);
    expect(terminal).toHaveAttribute("data-command-port", String(port));
    expect(terminal).toHaveAttribute("data-command-username", username);
    expect(useAppStore.getState().tabs.find((tab) => tab.sessionId === id)?.terminalTitleSessionName).toBe(name);
    await waitFor(() => expect(markSessionConnected).toHaveBeenCalledWith(id));
    expect(useAppStore.getState().tabs.some((tab) => tab.type === "placeholder")).toBe(false);
  });

  it("unlocks the vault once before opening queued saved-password sessions", async () => {
    vaultMock.state = "locked";
    const first = makePasswordSession("saved-1", "saved-one.test", "vault:first");
    const second = makePasswordSession("saved-2", "saved-two.test", "vault:second");

    render(<MainLayout />);
    const sidebar = latestSidebarProps();

    act(() => {
      sidebar.onConnectSession?.(first);
      sidebar.onConnectSession?.(second);
    });

    expect(screen.getByTestId("vault-unlock-dialog")).toBeInTheDocument();
    expect(screen.getAllByTestId("vault-unlock-dialog")).toHaveLength(1);

    fireEvent.change(screen.getByTestId("vault-unlock-pw"), { target: { value: "master" } });
    fireEvent.click(screen.getByTestId("vault-unlock-confirm"));

    await waitFor(() => {
      expect(vaultMock.unlock).toHaveBeenCalledTimes(1);
      const openedSessionIds = useAppStore.getState().tabs
        .filter((tab) => tab.type === "terminal" && tab.sessionId?.startsWith("saved-"))
        .map((tab) => tab.sessionId);
      expect(openedSessionIds).toEqual(["saved-1", "saved-2"]);
    });
    expect(screen.queryByTestId("vault-unlock-dialog")).not.toBeInTheDocument();
  });

  it("prompts for queued unsaved passwords one session at a time", async () => {
    const first = makePasswordSession("manual-1", "manual-one.test");
    const second = makePasswordSession("manual-2", "manual-two.test");

    render(<MainLayout />);
    const sidebar = latestSidebarProps();

    act(() => {
      sidebar.onConnectSession?.(first);
      sidebar.onConnectSession?.(second);
    });

    expect(screen.getByTestId("auth-prompt")).toHaveTextContent("root@manual-one.test");
    expect(screen.getAllByTestId("auth-prompt")).toHaveLength(1);

    fireEvent.change(screen.getByTestId("auth-password"), { target: { value: "pw-one" } });
    fireEvent.click(screen.getByTestId("auth-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("auth-prompt")).toHaveTextContent("root@manual-two.test");
    });
    expect(screen.getAllByTestId("auth-prompt")).toHaveLength(1);

    fireEvent.change(screen.getByTestId("auth-password"), { target: { value: "pw-two" } });
    fireEvent.click(screen.getByTestId("auth-submit"));

    await waitFor(() => {
      expect(screen.queryByTestId("auth-prompt")).not.toBeInTheDocument();
      const openedSessionIds = useAppStore.getState().tabs
        .filter((tab) => tab.type === "terminal" && tab.sessionId?.startsWith("manual-"))
        .map((tab) => tab.sessionId);
      expect(openedSessionIds).toEqual(["manual-1", "manual-2"]);
    });
  });

  it("opens RDP quick-connect URLs through the password prompt into an RDP tab", async () => {
    window.localStorage.setItem("taomni.quickConnectVisible", "true");
    render(<MainLayout />);

    act(() => {
      latestQuickConnectProps().onConnectInput?.("rdp://alice@win.example.test:3390");
    });

    expect(screen.getByTestId("auth-prompt")).toHaveTextContent("alice@win.example.test");

    fireEvent.change(screen.getByTestId("auth-password"), { target: { value: "rdp-pw" } });
    fireEvent.click(screen.getByTestId("auth-submit"));

    await waitFor(() => {
      const rdpTab = useAppStore.getState().tabs.find((tab) => tab.type === "rdp");
      expect(rdpTab?.rdp).toMatchObject({
        host: "win.example.test",
        port: 3390,
        username: "alice",
        password: "rdp-pw",
      });
    });
    const rdpPanel = await screen.findByTestId("rdp-panel");
    expect(rdpPanel).toHaveAttribute("data-host", "win.example.test");
    expect(rdpPanel).toHaveAttribute("data-port", "3390");
    expect(rdpPanel).toHaveAttribute("data-username", "alice");
  });

  it("opens saved VNC sessions without a stored password straight into the VNC panel", async () => {
    render(<MainLayout />);

    const session: SessionConfig = {
      ...makePasswordSession("vnc-1", "desktop.example.test"),
      name: "Desktop",
      session_type: "VNC",
      port: 5901,
      username: null,
    };
    useSessionStore.setState({ sessions: [session], groups: [] });

    await act(async () => {
      sidebarMock.props.at(-1)?.onConnectSession?.(session);
    });

    // DEC-VNC-21: the panel asks only when the server requires a password.
    const vncPanel = await screen.findByTestId("vnc-panel");
    expect(screen.queryByTestId("auth-prompt")).not.toBeInTheDocument();
    expect(vncPanel).toHaveAttribute("data-host", "desktop.example.test");
    expect(vncPanel).toHaveAttribute("data-port", "5901");
    expect(vncPanel).toHaveAttribute("data-password", "");
  });

  it("opens VNC quick-connect URLs straight into the VNC panel", async () => {
    window.localStorage.setItem("taomni.quickConnectVisible", "true");
    render(<MainLayout />);

    act(() => {
      latestQuickConnectProps().onConnectInput?.("vnc://alice@desktop.example.test:5902");
    });

    const vncPanel = await screen.findByTestId("vnc-panel");
    expect(screen.queryByTestId("auth-prompt")).not.toBeInTheDocument();
    expect(vncPanel).toHaveAttribute("data-host", "desktop.example.test");
    expect(vncPanel).toHaveAttribute("data-port", "5902");
    expect(vncPanel).toHaveAttribute("data-username", "alice");
    expect(vncPanel).toHaveAttribute("data-password", "");
  });

  it("opens saved Presto sessions as database tabs with catalog context", async () => {
    const prestoSession: SessionConfig = {
      id: "presto-1",
      name: "Presto Analytics",
      session_type: "Presto",
      group_path: null,
      host: "presto.example.test",
      port: 8080,
      username: "analyst",
      auth_method: "None",
      options_json: JSON.stringify({
        dbCatalog: "hive",
        dbDatabase: "sales",
        dbSsl: true,
        dbTimeout: "30",
      }),
      created_at: 10,
      updated_at: 10,
      last_connected_at: null,
      sort_order: 0,
    };

    render(<MainLayout />);

    act(() => {
      latestSidebarProps().onConnectSession?.(prestoSession);
    });

    await waitFor(() => {
      const tab = useAppStore.getState().tabs.find((candidate) => candidate.sessionId === "presto-1");
      expect(tab).toMatchObject({
        type: "database",
        title: "Presto presto.example.test:8080/hive.sales",
        db: {
          engine: "Presto",
          host: "presto.example.test",
          port: 8080,
          username: "analyst",
          catalog: "hive",
          database: "sales",
          ssl: true,
          timeoutSecs: 30,
          // Legacy sessions without dbPrestoDialect default to presto headers.
          prestoDialect: "presto",
        },
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId("db-client-tab")).toHaveAttribute("data-engine", "Presto");
    });
    expect(screen.getByTestId("db-client-tab")).toHaveAttribute("data-catalog", "hive");
    expect(screen.getByTestId("db-client-tab")).toHaveAttribute("data-database", "sales");
  });

  it("opens Trino-dialect Presto sessions with prestoDialect=trino on the tab", async () => {
    const trinoSession: SessionConfig = {
      id: "trino-1",
      name: "Trino Analytics",
      session_type: "Presto",
      group_path: null,
      host: "trino.example.test",
      port: 8080,
      username: "analyst",
      auth_method: "None",
      options_json: JSON.stringify({
        dbCatalog: "hive",
        dbDatabase: "sales",
        dbPrestoDialect: "trino",
      }),
      created_at: 10,
      updated_at: 10,
      last_connected_at: null,
      sort_order: 0,
    };

    render(<MainLayout />);

    act(() => {
      latestSidebarProps().onConnectSession?.(trinoSession);
    });

    await waitFor(() => {
      const tab = useAppStore.getState().tabs.find((candidate) => candidate.sessionId === "trino-1");
      expect(tab).toMatchObject({
        type: "database",
        db: {
          engine: "Presto",
          host: "trino.example.test",
          catalog: "hive",
          database: "sales",
          prestoDialect: "trino",
        },
      });
    });
  });

  it("opens saved HBaseShell sessions as independent HBase shell tabs", async () => {
    const hbaseSession: SessionConfig = {
      id: "hbase-1",
      name: "HBase REST",
      session_type: "HBaseShell",
      group_path: null,
      host: "hbase-rest.example.test",
      port: 8080,
      username: "root",
      auth_method: "None",
      options_json: JSON.stringify({
        hbaseNamespace: "prod",
        hbaseRestPath: "/gateway/hbase",
        dbSsl: true,
        dbTimeout: "25",
      }),
      created_at: 10,
      updated_at: 10,
      last_connected_at: null,
      sort_order: 0,
    };

    render(<MainLayout />);

    act(() => {
      latestSidebarProps().onConnectSession?.(hbaseSession);
    });

    await waitFor(() => {
      const tab = useAppStore.getState().tabs.find((candidate) => candidate.sessionId === "hbase-1");
      expect(tab).toMatchObject({
        type: "hbase-shell",
        title: "HBase hbase-rest.example.test:8080/prod",
        hbase: {
          host: "hbase-rest.example.test",
          port: 8080,
          username: "root",
          namespace: "prod",
          restPath: "/gateway/hbase",
          ssl: true,
          timeoutSecs: 25,
        },
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId("hbase-shell-tab")).toHaveAttribute("data-host", "hbase-rest.example.test");
    });
    expect(screen.getByTestId("hbase-shell-tab")).toHaveAttribute("data-namespace", "prod");
    expect(screen.getByTestId("hbase-shell-tab")).toHaveAttribute("data-rest-path", "/gateway/hbase");
  });
}
