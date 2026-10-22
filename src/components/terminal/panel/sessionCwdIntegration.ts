import { Terminal } from "@xterm/xterm";
import { encodeBase64, writeTerminal } from "../../../lib/ipc";
import { createOsc7BlankingSuppressor, createOscMarkerBlankingSuppressor } from "../../../lib/terminalOutputFilter";
import { CWD_INTEGRATION_DONE_MARKER } from "../../../lib/terminalShellIntegration";
import { getLastBufferLines, terminalAtIdlePrompt } from "./buffer";
import { buildSshInitialCwdProbe, CWD_QUERY_COMMAND, CWD_SETUP_INPUT_HOLD_MAX_MS } from "./protocol";
import type { TerminalSessionLifetime } from "./sessionContracts";
import { type TerminalSessionLifecycleContext } from "./sessionContracts";


export interface CreateTerminalCwdInstallerContext {
  ssh: import("./types").SshConnectInfo | undefined;
  adopted: import("./types").AdoptedTerminalSession | undefined;
  controllerContext: TerminalSessionLifecycleContext;
  lifetime: TerminalSessionLifetime;
  syncAutomationState: () => void;
}

export function createTerminalCwdInstaller(context: CreateTerminalCwdInstallerContext) {
  const { ssh, adopted, controllerContext, lifetime, syncAutomationState } = context;
  // Install continuous OSC 7 cwd reporting by writing a one-shot setup
  // command into the shell, but only once it shows a real, idle prompt —
  // never into a blank/initializing shell (a slow rc / conda init), a
  // streaming MOTD, or a half-typed line. Injecting early is what leaked the
  // raw command: the input got buffered, the echo came back after the
  // suppressor's TTL, and the whole line printed. Poll for the prompt over
  // several seconds; if login init or a startup command outlives that window,
  // retain an event-driven installer that runs when output later settles at
  // an idle prompt. The terminal is usable immediately; this only defers the
  // background hook. Shared by the SSH remote shell and the local macOS zsh.
  const scheduleCwdIntegrationInstall = (
    targetSid: string,
    integrationCommand: string | null,
    pendingStartupCommand?: string,
  ) => {
    if (!integrationCommand && !pendingStartupCommand) return;
    if (ssh && !adopted) controllerContext.automationInputSettlingRef.current = true;
    let integrationAttempts = 0;
    let integrationInstalling = false;
    let startupCommandSent = false;
    let startupCommandOutputObserved = false;
    let startupCommandSentAt = 0;
    let startupCommandPromptSnapshot: string | null = null;
    const snapshotPromptBuffer = (liveTerm: Terminal) => {
      const buffer = liveTerm.buffer.active;
      return `${buffer.baseY + buffer.cursorY}:${buffer.cursorX}\n${getLastBufferLines(liveTerm, 5, buffer.baseY + buffer.cursorY + 1)}`;
    };
    const MAX_INTEGRATION_ATTEMPTS = 12; // ~6s of polling for a slow login
    const installCwdIntegration = (): boolean => {
      if (lifetime.destroyed || controllerContext.sessionIdRef.current !== targetSid) {
        if (controllerContext.installSshCwdIntegrationRef.current === installCwdIntegration) {
          controllerContext.installSshCwdIntegrationRef.current = null;
        }
        return false;
      }
      if (integrationInstalling) return true;
      const liveTerm = controllerContext.termRef.current;
      if (!liveTerm) return false;
      if (pendingStartupCommand && !startupCommandSent) {
        if (!terminalAtIdlePrompt(liveTerm)) return false;
        startupCommandSent = true;
        startupCommandSentAt = Date.now();
        startupCommandPromptSnapshot = snapshotPromptBuffer(liveTerm);
        writeTerminal(targetSid, encodeBase64(`${pendingStartupCommand}\r`)).catch((err) => {
          controllerContext.appendEvent("error", `Failed to send SSH startup command: ${String(err)}`);
        });
        return false;
      }
      if (pendingStartupCommand && !startupCommandOutputObserved) {
        // xterm updates its buffer as soon as the command is echoed. That
        // echo is not proof that the command completed; sending the cwd
        // hook at that point races the shell and can swallow the startup
        // command on slow SSH/ConPTY sessions. Give the shell a turn, then
        // require an idle prompt and a changed buffer before continuing.
        if (Date.now() - startupCommandSentAt < 500) return false;
        if (snapshotPromptBuffer(liveTerm) === startupCommandPromptSnapshot) return false;
        if (!terminalAtIdlePrompt(liveTerm)) return false;
        startupCommandOutputObserved = true;
        // Keep input held until the following cwd probe also completes.
        // Publishing readiness here exposes a gap between the two writes.
      }
      if (!terminalAtIdlePrompt(liveTerm)) return false;
      if (!integrationCommand) {
        controllerContext.installSshCwdIntegrationRef.current = null;
        controllerContext.automationInputSettlingRef.current = false;
        syncAutomationState();
        return true;
      }
      integrationInstalling = true;
      // xterm allocates blank rows below a short prompt. Inspect the rows
      // ending at the cursor, not the bottom of the viewport.
      const promptBuffer = liveTerm.buffer.active;
      const isMingwShell = /\bMINGW(?:32|64)\b/.test(
        getLastBufferLines(liveTerm, 3, promptBuffer.baseY + promptBuffer.cursorY + 1),
      );
      // Git Bash can take long enough to echo a prompt hook that the user
      // types into the hidden setup line. A one-shot OSC 7 probe still
      // captures the requested cwd without modifying its prompt.
      const useMingwCwdProbe = ssh && isMingwShell && integrationCommand.includes("TaomniCwdIntegrationDone");
      const commandForShell = useMingwCwdProbe
        ? (controllerContext.initialCwd ? buildSshInitialCwdProbe(controllerContext.initialCwd) : CWD_QUERY_COMMAND)
        : integrationCommand;
      const integrationTimeoutMs = isMingwShell && !useMingwCwdProbe ? 30_000 : 4_000;
      const inputHoldTimeoutMs = Math.min(integrationTimeoutMs, CWD_SETUP_INPUT_HOLD_MAX_MS);
      if (controllerContext.installSshCwdIntegrationRef.current === installCwdIntegration) {
        controllerContext.installSshCwdIntegrationRef.current = null;
      }
      // Generous TTL so a laggy link's echo round-trip still arrives while
      // the suppressor is dropping (we only get here at a ready prompt, so
      // it's just network latency, not shell startup). Bounded so a
      // non-POSIX shell — which never emits the OSC 7 — isn't blacked out
      // for too long before output resumes.
      controllerContext.automationInputSettlingRef.current = true;
      syncAutomationState();
      // SSH/local shell integration emits a private completion marker after
      // the one-shot setup. Matching that marker avoids mistaking a prompt's
      // ordinary OSC 7 report for completion while the setup line is still
      // being echoed on a laggy Windows PTY.
      const suppressor = commandForShell.includes("TaomniCwdIntegrationDone")
        ? createOscMarkerBlankingSuppressor(
          CWD_INTEGRATION_DONE_MARKER,
          integrationTimeoutMs,
          Date.now(),
          inputHoldTimeoutMs,
        )
        : createOsc7BlankingSuppressor(
          integrationTimeoutMs,
          Date.now(),
          inputHoldTimeoutMs,
        );
      controllerContext.injectedInputEchoSuppressorRef.current = suppressor;
      window.setTimeout(() => {
        if (
          lifetime.destroyed ||
          controllerContext.sessionIdRef.current !== targetSid ||
          controllerContext.injectedInputEchoSuppressorRef.current !== suppressor
        ) return;
        controllerContext.injectedInputEchoSuppressorRef.current = null;
        controllerContext.automationInputSettlingRef.current = false;
        syncAutomationState();
      }, integrationTimeoutMs);
      writeTerminal(targetSid, encodeBase64(`${commandForShell}\r`)).catch(() => {
        if (controllerContext.sessionIdRef.current === targetSid && controllerContext.injectedInputEchoSuppressorRef.current === suppressor) {
          integrationInstalling = false;
          controllerContext.installSshCwdIntegrationRef.current = installCwdIntegration;
          controllerContext.injectedInputEchoSuppressorRef.current = null;
          controllerContext.automationInputSettlingRef.current = false;
          syncAutomationState();
        }
      });
      return true;
    };
    controllerContext.installSshCwdIntegrationRef.current = installCwdIntegration;
    const pollForCwdIntegration = () => {
      if (installCwdIntegration()) return;
      if (lifetime.destroyed || controllerContext.sessionIdRef.current !== targetSid) return;
      if (integrationAttempts < MAX_INTEGRATION_ATTEMPTS) {
        integrationAttempts += 1;
        window.setTimeout(pollForCwdIntegration, 500);
      } else if (pendingStartupCommand && !startupCommandSent) {
        // Keep the event-driven probe alive until a slow login exposes its prompt.
      } else if (controllerContext.installSshCwdIntegrationRef.current === installCwdIntegration) {
        // A shell that never exposes a prompt (or a non-POSIX prompt that
        // cannot accept the integration command) must not block normal
        // input forever. Stop retrying and expose the stable output we do
        // have; cwd reporting remains unavailable for this session.
        controllerContext.installSshCwdIntegrationRef.current = null;
        controllerContext.automationInputSettlingRef.current = false;
        syncAutomationState();
      }
    };
    window.setTimeout(pollForCwdIntegration, 500);
  };
  return { scheduleCwdIntegrationInstall };
}
