import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import type { SessionConfig } from "../../../../lib/ipc";
import { ipcMocks, renderEditor } from "./harness";

const NETWORK_SESSION_TYPES = [
  "SSH", "SFTP", "RDP", "VNC", "MySQL", "PostgreSQL", "PanWeiDB",
  "Oracle", "SQLServer", "StarRocks", "ClickHouse", "Presto", "Redis",
  "S3", "Mail",
];

function savedSsh(options: Record<string, unknown>): SessionConfig {
  return {
    id: "saved-route", name: "Saved SSH", session_type: "SSH",
    group_path: null, host: "ssh.example.test", port: 22, username: "qa",
    auth_method: "Agent", options_json: JSON.stringify(options),
    created_at: 1, updated_at: 1, last_connected_at: null, sort_order: 0,
  };
}

export function registerSessionDefaultCases() {
  it.each(NETWORK_SESSION_TYPES)("defaults a new %s session to a direct connection", async (initialProto) => {
    const user = userEvent.setup();
    renderEditor(undefined, { initialProto });
    await user.click(screen.getByTestId("session-section-network"));
    expect(screen.getByTestId("session-proxy-kind")).toHaveValue("none");
    expect(screen.queryByTestId("session-custom-proxy")).not.toBeInTheDocument();
  });

  it("resets an application proxy to direct when resetting a new session", async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.click(screen.getByTestId("session-section-network"));
    await user.selectOptions(screen.getByTestId("session-proxy-kind"), "app");
    expect(screen.getByTestId("session-proxy-kind")).toHaveValue("app");
    await user.click(screen.getByTestId("session-reset"));
    await user.click(screen.getByTestId("session-section-network"));
    expect(screen.getByTestId("session-proxy-kind")).toHaveValue("none");
  });

  it("defaults Azure Blob to direct after selecting its provider", async () => {
    const user = userEvent.setup();
    renderEditor(undefined, { initialProto: "S3" });
    await user.selectOptions(screen.getByTestId("session-storage-provider"), "azure");
    expect(screen.getByTestId("session-storage-provider")).toHaveValue("azure");
    await user.click(screen.getByTestId("session-section-network"));
    expect(screen.getByTestId("session-proxy-kind")).toHaveValue("none");
  });

  it.each(["app", "custom", "http", "socks5", "ssh-tunnel", "system", "none"])(
    "retains an explicitly saved %s route when the session is edited", async (proxyKind) => {
      const user = userEvent.setup();
      renderEditor(savedSsh({ networkSettings: { proxyKind } }));
      await user.click(screen.getByTestId("session-section-network"));
      expect(screen.getByTestId("session-proxy-kind")).toHaveValue(proxyKind);
    },
  );

  it("tests and saves a new SSH session with a direct route and fixed SFTP browser", async () => {
    const user = userEvent.setup();
    renderEditor();
    expect(screen.getByTestId("session-ssh-browser-type")).toHaveTextContent("SFTP protocol (recommended)");
    expect(screen.getByTestId("session-ssh-browser-type").tagName).toBe("SPAN");
    fireEvent.change(screen.getByTestId("session-host"), { target: { value: "ssh.example.test" } });
    await user.click(screen.getByTestId("session-specify-username"));
    fireEvent.change(screen.getByTestId("session-user"), { target: { value: "qa" } });
    await user.click(screen.getByTestId("session-auth-agent"));
    await user.click(screen.getByTestId("session-test-connection"));
    await waitFor(() => expect(ipcMocks.testSshConnection).toHaveBeenCalled());
    expect(JSON.parse(ipcMocks.testSshConnection.mock.calls[0][5])).toMatchObject({ proxyKind: "none", sshBrowser: "sftp" });
    await user.keyboard("{Escape}");
    await user.click(screen.getByTestId("session-save"));
    await waitFor(() => expect(ipcMocks.saveSession).toHaveBeenCalledTimes(1));
    expect(JSON.parse(ipcMocks.saveSession.mock.calls[0][0].options_json)).toMatchObject({
      sshBrowser: "sftp", networkSettings: { proxyKind: "none" },
    });
  });

  it.each(["scp", "scp-fast", "disabled", "Disabled", "SCP（兼容模式）"])(
    "saves SFTP when editing a legacy %s browser setting", async (sshBrowser) => {
      const user = userEvent.setup();
      renderEditor(savedSsh({ sshBrowser, networkSettings: { proxyKind: "app" } }));
      expect(screen.getByTestId("session-ssh-browser-type")).toHaveTextContent("SFTP protocol (recommended)");
      expect(screen.queryByText(/requires Python 3 and scp/)).not.toBeInTheDocument();
      await user.click(screen.getByTestId("session-save"));
      await waitFor(() => expect(ipcMocks.saveSession).toHaveBeenCalledTimes(1));
      expect(JSON.parse(ipcMocks.saveSession.mock.calls[0][0].options_json)).toMatchObject({
        sshBrowser: "sftp", networkSettings: { proxyKind: "app", sshBrowser: "sftp" },
      });
    },
  );
}
