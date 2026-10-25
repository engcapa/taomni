import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { ipcMocks, renderEditor } from "./harness";

export function registerSessionCapabilityCases() {
  it("switches away from an active network section without leaving hidden controls mounted", async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.click(screen.getByTestId("session-section-network"));
    for (const type of ["shell", "wsl", "serial", "file", "browser", "ftp", "telnet", "rlogin", "mosh", "proxy", "hbaseshell"]) {
      await user.click(screen.getByTestId(`session-proto-${type}`));
      expect(screen.queryByTestId("session-section-network")).not.toBeInTheDocument();
      expect(screen.queryByTestId("session-forward-add")).not.toBeInTheDocument();
      expect(screen.queryByTestId("session-proxy-kind")).not.toBeInTheDocument();
    }
    await user.click(screen.getByTestId("session-proto-ssh"));
    await user.click(screen.getByTestId("session-section-network"));
    expect(screen.getByTestId("session-forward-add")).toBeInTheDocument();
  });

  it("retains SFTP authentication and routing without shell controls", async () => {
    const user = userEvent.setup();
    renderEditor(undefined, { initialProto: "SFTP" });
    expect(screen.getByTestId("session-auth-privatekey")).toBeInTheDocument();
    expect(screen.queryByTestId("session-x11-forwarding-toggle")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Execute command")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("session-section-network"));
    expect(screen.getByTestId("session-proxy-kind")).toBeInTheDocument();
    expect(screen.getByTestId("session-keepalive-toggle")).toHaveAttribute("data-checked", "true");
    expect(screen.queryByTestId("session-forward-add")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Keep-alive interval")).toBeInTheDocument();
  });

  it("saves a local session after SSH editing without stale credentials or network settings", async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.click(screen.getByTestId("session-auth-privatekey"));
    fireEvent.change(screen.getByLabelText("Private key path"), { target: { value: "" } });
    await user.click(screen.getByTestId("session-section-network"));
    await user.selectOptions(screen.getByTestId("session-proxy-kind"), "http");
    await user.type(screen.getByLabelText("Proxy password"), "must-not-be-saved");
    await user.click(screen.getByTestId("session-proxy-save-auth"));
    await user.click(screen.getByTestId("session-proto-serial"));
    await user.type(screen.getByTestId("session-serial-device"), "COM42");
    await user.click(screen.getByTestId("session-save"));
    await waitFor(() => expect(ipcMocks.saveSession).toHaveBeenCalledTimes(1));
    expect(ipcMocks.vaultPut).not.toHaveBeenCalled();
    const saved = ipcMocks.saveSession.mock.calls[0][0];
    expect(saved.auth_method).toBe("None");
    expect(saved.username).toBeNull();
    const options = JSON.parse(saved.options_json);
    expect(options.serialDevice).toBe("COM42");
    for (const key of ["networkSettings", "x11", "passwordRef", "fileExtraArgs", "startupCmd"]) {
      expect(options).not.toHaveProperty(key);
    }
  });

  it.each(["Mail", "RDP", "VNC"])("does not expose SSH forwarding and keepalive for %s", async (initialProto) => {
    const user = userEvent.setup();
    renderEditor(undefined, { initialProto });
    await user.click(screen.getByTestId("session-section-network"));
    expect(screen.getByTestId("session-proxy-kind")).toBeInTheDocument();
    expect(screen.queryByTestId("session-keepalive-toggle")).not.toBeInTheDocument();
    expect(screen.queryByTestId("session-forward-add")).not.toBeInTheDocument();
  });
}
