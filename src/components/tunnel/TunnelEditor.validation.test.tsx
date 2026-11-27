import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "../../lib/i18n";
import { defaultTunnel } from "../../lib/tunnel";
import { TunnelEditor } from "./TunnelEditor";
import { firstTunnelError } from "./tunnelValidation";

afterEach(cleanup);
beforeEach(() => setLocale("en"));

it("focuses the invalid gateway, associates its error and retains the tunnel draft", () => {
  const save = vi.fn();
  render(<TunnelEditor sessions={[]} onSave={save} onCancel={vi.fn()} />);
  const submit = screen.getByTestId("tunnel-editor-save");
  fireEvent.click(submit);
  const name = screen.getByPlaceholderText("e.g. postgres-replica");
  expect(name).toHaveFocus();
  expect(name).toHaveAccessibleDescription("Tunnel name is required");
  fireEvent.change(name, { target: { value: "db replica" } });
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(submit);
  const host = screen.getByLabelText("SSH server *");
  expect(host).toHaveFocus();
  expect(host).toHaveAttribute("aria-invalid", "true");
  expect(host).toHaveAccessibleDescription("SSH server host is required");
  expect(name).toHaveValue("db replica");
  const socks = screen.getByRole("radio", { name: /Dynamic port forwarding/ });
  expect(socks).toHaveAttribute("value", "Dynamic");
  fireEvent.click(socks);
  expect(socks).toBeChecked();
  expect(save).not.toHaveBeenCalled();
});

it("validates gateway, listener and destination ports and ignores the destination for SOCKS", () => {
  const draft = { ...defaultTunnel("Local"), name: "proxy", listenPort: 1, destHost: "db", destPort: 65535 };
  draft.ssh = { ...draft.ssh, host: "gw", username: "dev" };
  expect(firstTunnelError(draft)).toBeNull();
  for (const port of [0, 65536, 1.5, NaN]) {
    expect(firstTunnelError({ ...draft, ssh: { ...draft.ssh, port } })?.field).toBe("port");
    expect(firstTunnelError({ ...draft, listenPort: port })?.field).toBe("listenPort");
    expect(firstTunnelError({ ...draft, destPort: port })?.field).toBe("destPort");
  }
  expect(firstTunnelError({ ...draft, kind: "Dynamic", destHost: "", destPort: 0 })).toBeNull();
});
