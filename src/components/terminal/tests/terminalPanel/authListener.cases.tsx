import { act, render, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { TerminalPanel } from "../../TerminalPanel";
import { ipcMocks, sshInfo } from "./harness";

export function registerAuthListenerCases() {
  it("waits for the auth event subscription before starting SSH", async () => {
    const unlisten = vi.fn();
    let ready!: (unsubscribe: typeof unlisten) => void;
    ipcMocks.listenSshAuthPrompt.mockImplementationOnce(() => new Promise((resolve) => { ready = resolve; }));
    const view = render(<TerminalPanel tabId="auth-subscription" visible ssh={sshInfo} />);
    await waitFor(() => expect(ready).toBeTypeOf("function"));
    expect(ipcMocks.createSshTerminal).not.toHaveBeenCalled();
    await act(async () => ready(unlisten));
    await waitFor(() => expect(ipcMocks.createSshTerminal).toHaveBeenCalledTimes(1));
    view.unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("does not start SSH after a pending subscription's panel is closed", async () => {
    const unlisten = vi.fn();
    let ready!: (unsubscribe: typeof unlisten) => void;
    ipcMocks.listenSshAuthPrompt.mockImplementationOnce(() => new Promise((resolve) => { ready = resolve; }));
    const view = render(<TerminalPanel tabId="closed-auth-subscription" visible ssh={sshInfo} />);
    await waitFor(() => expect(ready).toBeTypeOf("function"));
    view.unmount();
    await act(async () => ready(unlisten));
    expect(ipcMocks.createSshTerminal).not.toHaveBeenCalled();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("reports listener failure instead of launching an inaccessible auth prompt", async () => {
    ipcMocks.listenSshAuthPrompt.mockRejectedValueOnce(new Error("Auth event subscription unavailable"));
    const failed = vi.fn();
    render(<TerminalPanel tabId="failed-auth-subscription" visible ssh={sshInfo} onSessionLaunchFailed={failed} />);
    await waitFor(() => expect(failed).toHaveBeenCalledWith(expect.objectContaining({
      message: "Auth event subscription unavailable",
    })));
    expect(ipcMocks.createSshTerminal).not.toHaveBeenCalled();
  });
}
