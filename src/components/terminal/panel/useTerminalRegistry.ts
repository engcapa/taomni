import { useEffect } from "react";
import { ccTrackTerminal, ccUntrackTerminal, encodeBase64, writeTerminal } from "../../../lib/ipc";
import { getAppPlatform } from "../../../lib/runtime";
import { buildInteractiveCommandInput, renderTerminalTask, type TerminalTaskVariables } from "../../../lib/terminal/commandInput";
import { registerTerminal } from "../../../lib/terminal/terminalRegistry";
import { inferTerminalProgram } from "../../../lib/terminalActivity";
import { createTaskStartOutputSuppressor } from "../../../lib/terminalOutputFilter";
import { getBufferText, getLastBufferLines, getTerminalPreviewText, terminalAtIdlePrompt } from "./buffer";
import { useTerminalInteraction } from "./useTerminalInteraction";
import { useTerminalPanelState } from "./useTerminalPanelState";


export interface UseTerminalRegistryContext {
  tabId: string | undefined;
  panel: ReturnType<typeof useTerminalPanelState>;
  tabTitle: string;
  interaction: ReturnType<typeof useTerminalInteraction>;
  localShell: { id: string; name: string; args?: string[]; } | undefined;
}

export function useTerminalRegistry(context: UseTerminalRegistryContext) {
  const { tabId, panel, tabTitle, interaction, localShell } = context;

  // Register this terminal in the global registry so the AI Chat Drawer can
  // pull buffer context (`@terminal:last-N`) and push commands back into it
  // (the assistant's "Send to terminal" button on rendered code blocks).
  // Re-runs whenever the backend session id changes, since stale entries
  // would point at a closed pty.
  useEffect(() => {
    const registeredSessionId = panel.registeredSessionId;
    if (!tabId || !registeredSessionId) return;
    const unregister = registerTerminal({
      tabId,
      sessionId: registeredSessionId,
      title: tabTitle,
      isReady: () => {
        const liveTerm = panel.termRef.current;
        return !!liveTerm
          && panel.connectionStateRef.current === "connected"
          && !panel.automationInputSettlingRef.current
          && terminalAtIdlePrompt(liveTerm);
      },
      localEnvironment: panel.isLocal
        ? {
          platform: getAppPlatform(),
          shellId: interaction.resolvedLocalShellId ?? localShell?.id ?? null,
          shellName: localShell?.name ?? null,
          shellArgs: localShell?.args ?? [],
        }
        : null,
      getBufferText: () => {
        const t = panel.termRef.current;
        return t ? getBufferText(t) : "";
      },
      getLastLines: (n: number) => {
        const t = panel.termRef.current;
        return t ? getLastBufferLines(t, n) : "";
      },
      getPreviewText: (n: number) => {
        const t = panel.termRef.current;
        return t ? getTerminalPreviewText(t, n) : "";
      },
      writeInput: (data: string) => {
        if (panel.readOnlyRef.current) return;
        if (/[\r\n]/.test(data)) {
          const program = inferTerminalProgram(data.split(/[\r\n]/).find((line) => line.trim()) ?? "");
          if (program) {
            panel.setTerminalRuntime(tabId, {
              state: "running",
              program,
              activitySource: "input-heuristic",
            });
          }
        }
        writeTerminal(registeredSessionId, encodeBase64(data)).catch(console.error);
      },
      runTask: (command: string, taskVariables) => {
        if (panel.readOnlyRef.current) return;
        const sdkTaskVariables = Object.fromEntries(
          Object.entries(panel.sdkTaskEnvironmentRef.current).map(([name, value]) => [
            name,
            { value, mode: "replace" as const },
          ]),
        ) satisfies TerminalTaskVariables;
        const task = renderTerminalTask(command, {
          platform: getAppPlatform(),
          shellId: interaction.resolvedLocalShellId ?? localShell?.id ?? null,
          shellName: localShell?.name ?? null,
        }, { ...sdkTaskVariables, ...taskVariables });
        const suppressor = createTaskStartOutputSuppressor(
          task.startMarker,
          task.displayCommand,
        );
        panel.injectedInputEchoSuppressorRef.current = suppressor;
        const program = inferTerminalProgram(task.displayCommand);
        panel.setTerminalRuntime(tabId, {
          state: "running",
          program: program ?? undefined,
          activitySource: "input-heuristic",
        });
        writeTerminal(
          registeredSessionId,
          encodeBase64(buildInteractiveCommandInput(task.input)),
        ).catch((err) => {
          if (panel.injectedInputEchoSuppressorRef.current === suppressor) {
            panel.injectedInputEchoSuppressorRef.current = null;
          }
          console.error(err);
        });
      },
      // Display-only echo (xterm.write): mirror Claude Code's captured-run
      // activity into this terminal as a read-only trace. Intentionally NOT
      // gated by readOnlyRef — it never reaches stdin, it only paints the
      // screen, so a read-only/locked session can still show what CC ran.
      writeEcho: (data: string) => {
        panel.termRef.current?.write(data);
      },
    });
    // Mirror the tab → backend-session mapping to the backend so Claude Code's
    // server-side tools (run_captured / read_capture) can resolve this live
    // terminal by tab id — run_in_terminal reaches it via the frontend registry
    // above, but those tools index state.terminals directly. Best-effort; a miss
    // just degrades to the existing "no live terminal" behaviour.
    void ccTrackTerminal(tabId, registeredSessionId).catch(() => { });
    return () => {
      unregister();
      void ccUntrackTerminal(tabId, registeredSessionId).catch(() => { });
    };
  }, [panel.isLocal, localShell?.args, localShell?.id, localShell?.name, interaction.resolvedLocalShellId, panel.setTerminalRuntime, tabId, panel.registeredSessionId, tabTitle]);
  return {};
}
