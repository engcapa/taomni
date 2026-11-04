import { act, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { TerminalPanel } from "../../TerminalPanel";
import { eventMocks, ipcMocks, sshInfo } from "./harness";

export function registerAuthListenerCases() {
  it("waits for the auth event subscription before starting SSH", async () => {
    const unlisten = vi.fn();
    let ready!: (unsubscribe: typeof unlisten) => void;
    ipcMocks.listenSshAuthPrompt.mockImplementationOnce(() => new Promise((resolve) => { ready = resolve; }));
    const view = render(<TerminalPanel tabId="auth-subscription" visible ssh={sshInfo} />);
    await waitFor(() => expect(ready).toBeTypeOf("function"));
    expect(eventMocks.listen).toHaveBeenCalledWith("ssh-auth-resolved-terminal-session", expect.any(Function));
    const unlistenResolved = await eventMocks.listen.mock.results[0].value;
    expect(ipcMocks.createSshTerminal).not.toHaveBeenCalled();
    await act(async () => ready(unlisten));
    await waitFor(() => expect(ipcMocks.createSshTerminal).toHaveBeenCalledTimes(1));
    view.unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(unlistenResolved).toHaveBeenCalledTimes(1);
  });

  it("does not start SSH after a pending subscription's panel is closed", async () => {
    const unlisten = vi.fn();
    let ready!: (unsubscribe: typeof unlisten) => void;
    ipcMocks.listenSshAuthPrompt.mockImplementationOnce(() => new Promise((resolve) => { ready = resolve; }));
    const view = render(<TerminalPanel tabId="closed-auth-subscription" visible ssh={sshInfo} />);
    await waitFor(() => expect(ready).toBeTypeOf("function"));
    const unlistenResolved = await eventMocks.listen.mock.results[0].value;
    view.unmount();
    await act(async () => ready(unlisten));
    expect(ipcMocks.createSshTerminal).not.toHaveBeenCalled();
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(unlistenResolved).toHaveBeenCalledTimes(1);
  });

  it("reports listener failure instead of launching an inaccessible auth prompt", async () => {
    ipcMocks.listenSshAuthPrompt.mockRejectedValueOnce(new Error("Auth event subscription unavailable"));
    const failed = vi.fn();
    render(<TerminalPanel tabId="failed-auth-subscription" visible ssh={sshInfo} onSessionLaunchFailed={failed} />);
    await waitFor(() => expect(failed).toHaveBeenCalledWith(expect.objectContaining({
      message: "Auth event subscription unavailable",
    })));
    expect(ipcMocks.createSshTerminal).not.toHaveBeenCalled();
    const unlistenResolved = await eventMocks.listen.mock.results[0].value;
    expect(unlistenResolved).toHaveBeenCalledTimes(1);
  });

  it("waits for the resolved event subscription before subscribing to auth prompts", async () => {
    const unlistenResolved = vi.fn();
    let ready!: (unsubscribe: typeof unlistenResolved) => void;
    eventMocks.listen.mockImplementationOnce(() => new Promise((resolve) => { ready = resolve; }));
    const view = render(<TerminalPanel tabId="resolved-subscription" visible ssh={sshInfo} />);
    await waitFor(() => expect(ready).toBeTypeOf("function"));
    expect(ipcMocks.listenSshAuthPrompt).not.toHaveBeenCalled();
    expect(ipcMocks.createSshTerminal).not.toHaveBeenCalled();
    await act(async () => ready(unlistenResolved));
    await waitFor(() => expect(ipcMocks.createSshTerminal).toHaveBeenCalledTimes(1));
    view.unmount();
    expect(unlistenResolved).toHaveBeenCalledTimes(1);
  });

  it("does not start SSH when the resolved event subscription fails", async () => {
    eventMocks.listen.mockRejectedValueOnce(new Error("Resolved event subscription unavailable"));
    const failed = vi.fn();
    render(<TerminalPanel tabId="failed-resolved-subscription" visible ssh={sshInfo} onSessionLaunchFailed={failed} />);
    await waitFor(() => expect(failed).toHaveBeenCalledWith(expect.objectContaining({
      message: "Resolved event subscription unavailable",
    })));
    expect(ipcMocks.listenSshAuthPrompt).not.toHaveBeenCalled();
    expect(ipcMocks.createSshTerminal).not.toHaveBeenCalled();
  });

  it("dismisses only the matching pending auth prompt without submitting another answer", async () => {
    let connected!: (sessionId: string) => void;
    ipcMocks.createSshTerminal.mockImplementationOnce(() => new Promise((resolve) => { connected = resolve; }));
    const view = render(<TerminalPanel tabId="resolved-auth-prompt" visible ssh={sshInfo} />);
    await waitFor(() => expect(connected).toBeTypeOf("function"));
    const prompt = ipcMocks.listenSshAuthPrompt.mock.calls[0][1];
    const [event, resolved] = eventMocks.listen.mock.calls[0];
    act(() => prompt({
      requestId: "current-request",
      name: "One-time password",
      instructions: "Enter the current code",
      prompts: [{ prompt: "Code", echo: false }],
    }));
    expect(screen.getByTestId("mfa-prompt")).toBeInTheDocument();
    act(() => resolved({ event, id: 1, payload: "previous-request" }));
    expect(screen.getByTestId("mfa-prompt")).toBeInTheDocument();
    act(() => resolved({ event, id: 1, payload: "current-request" }));
    expect(screen.queryByTestId("mfa-prompt")).not.toBeInTheDocument();
    expect(ipcMocks.submitSshAuthResponse).not.toHaveBeenCalled();
    view.unmount();
    await act(async () => connected("terminal-session"));
    expect(ipcMocks.submitSshAuthResponse).not.toHaveBeenCalled();
  });
}
