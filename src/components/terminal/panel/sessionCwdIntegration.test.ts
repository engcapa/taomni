import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeTerminal } from "../../../lib/ipc";
import { CWD_INTEGRATION_DONE_MARKER, buildSshCwdIntegration } from "../../../lib/terminalShellIntegration";
import { createTerminalCwdInstaller, type CreateTerminalCwdInstallerContext } from "./sessionCwdIntegration";
import { buildSshInitialCwdProbe, CWD_QUERY_COMMAND } from "./protocol";

vi.mock("../../../lib/ipc", () => ({
  writeTerminal: vi.fn(async () => undefined),
  encodeBase64: (value: string) => btoa(value),
}));

const terminals: Terminal[] = [];

async function setup(prompt: string, initialCwd?: string) {
  const term = new Terminal({ cols: 120, rows: 32 });
  terminals.push(term);
  await new Promise<void>((resolve) => term.write(prompt, resolve));
  vi.useFakeTimers();
  const controllerContext: CreateTerminalCwdInstallerContext["controllerContext"] = {
    automationInputSettlingRef: { current: false },
    sessionIdRef: { current: "ssh-1" },
    termRef: { current: term },
    installSshCwdIntegrationRef: { current: null },
    appendEvent: vi.fn(),
    initialCwd,
    injectedInputEchoSuppressorRef: { current: null },
  };
  const lifetime = { destroyed: false };
  const installer = createTerminalCwdInstaller({
    ssh: { host: "test.invalid", port: 22, username: "qa", authMethod: "Password", authData: null },
    adopted: undefined,
    controllerContext,
    lifetime,
    syncAutomationState: vi.fn(),
  });
  return { installer, controllerContext, lifetime };
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
  for (const term of terminals.splice(0)) term.dispose();
});

describe("SSH cwd installation", () => {
  it.each(["MINGW32", "MINGW64", "UCRT64", "CLANG64", "CLANGARM64", "MSYS"])(
    "uses the short probe for a %s prompt above blank viewport rows",
    async (environment) => {
      const { installer, controllerContext } = await setup(`\r\nqa@runner ${environment} ~\r\n$ `);
      installer.scheduleCwdIntegrationInstall("ssh-1", buildSshCwdIntegration());
      expect(controllerContext.automationInputSettlingRef.current).toBe(true);
      await vi.advanceTimersByTimeAsync(500);
      expect(writeTerminal).toHaveBeenCalledExactlyOnceWith("ssh-1", btoa(`${CWD_QUERY_COMMAND}\r`));
      const suppressor = controllerContext.injectedInputEchoSuppressorRef.current!;
      expect(suppressor.done).toBe(false);
      suppressor.filter(new TextEncoder().encode("echo noise\r\n"));
      expect(suppressor.done).toBe(false);
      expect(new TextDecoder().decode(suppressor.filter(new TextEncoder().encode("\x1b]7;file://runner/c/Users/qa\x1b\\\r\n$ "))))
        .toBe("\x1b]7;file://runner/c/Users/qa\x1b\\\r\n$ ");
      expect(suppressor.done).toBe(true);
    },
  );

  it("preserves the requested directory and shell quoting for UCRT64", async () => {
    const cwd = "/c/Users/qa/O'Brien";
    const { installer } = await setup("qa@runner UCRT64 ~\r\n$ ", cwd);
    installer.scheduleCwdIntegrationInstall("ssh-1", buildSshCwdIntegration(cwd));
    await vi.advanceTimersByTimeAsync(500);
    expect(writeTerminal).toHaveBeenCalledExactlyOnceWith("ssh-1", btoa(`${buildSshInitialCwdProbe(cwd)}\r`));
  });

  it("keeps continuous integration and its private completion marker on POSIX shells", async () => {
    const { installer, controllerContext } = await setup("qa@linux:~$ ");
    const command = buildSshCwdIntegration();
    installer.scheduleCwdIntegrationInstall("ssh-1", command);
    await vi.advanceTimersByTimeAsync(500);
    expect(writeTerminal).toHaveBeenCalledExactlyOnceWith("ssh-1", btoa(`${command}\r`));
    const suppressor = controllerContext.injectedInputEchoSuppressorRef.current!;
    suppressor.filter(new TextEncoder().encode("\x1b]7;file://linux/home/qa\x1b\\"));
    expect(suppressor.done).toBe(false);
    suppressor.filter(new TextEncoder().encode(CWD_INTEGRATION_DONE_MARKER));
    expect(suppressor.done).toBe(true);
  });

  it.each(["destroyed", "replaced"])("does not inject into a %s session", async (state) => {
    const { installer, controllerContext, lifetime } = await setup("qa@runner UCRT64 ~\r\n$ ");
    installer.scheduleCwdIntegrationInstall("ssh-1", buildSshCwdIntegration());
    if (state === "destroyed") lifetime.destroyed = true;
    else controllerContext.sessionIdRef.current = "ssh-2";
    await vi.advanceTimersByTimeAsync(500);
    expect(writeTerminal).not.toHaveBeenCalled();
  });
});
