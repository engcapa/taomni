import { useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { downloadTextFile, safeFilePart, timestampFilePart } from "./transfer";
import { getBufferText } from "./buffer";


export interface UseTerminalRecordingContext {
  termRef: import("react").RefObject<Terminal | null>;
  tabTitle: string;
  appendEvent: (type: string, detail: string) => void;
  setStatusMessage: (message: string) => void;
  focusTerminal: () => void;
  outputLogRef: import("react").RefObject<string>;
  setLoggingActive: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  setMacroRecording: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  lastMacroRef: import("react").RefObject<string>;
  macroBufferRef: import("react").RefObject<string>;
  macroPlaybackRef: import("react").RefObject<boolean>;
  writeInput: (data: string) => void;
}

export function useTerminalRecording(context: UseTerminalRecordingContext) {
  const {
    termRef,
    tabTitle,
    appendEvent,
    setStatusMessage,
    focusTerminal,
    outputLogRef,
    setLoggingActive,
    setMacroRecording,
    lastMacroRef,
    macroBufferRef,
    macroPlaybackRef,
    writeInput,
  } = context;

  const saveBufferToFile = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    downloadTextFile(
      `${safeFilePart(tabTitle)}-${timestampFilePart()}.txt`,
      getBufferText(term),
      "text/plain",
    );
    appendEvent("export", "Saved terminal buffer to file");
    setStatusMessage("Saved terminal buffer");
    focusTerminal();
  }, [appendEvent, focusTerminal, setStatusMessage, tabTitle]);

  const flushRecordedOutput = useCallback((reason: string) => {
    if (!outputLogRef.current) {
      setStatusMessage("No recorded output to save");
      return;
    }
    downloadTextFile(
      `${safeFilePart(tabTitle)}-recording-${timestampFilePart()}.txt`,
      outputLogRef.current,
      "text/plain",
    );
    appendEvent("log", reason);
    outputLogRef.current = "";
    setStatusMessage("Saved terminal recording");
  }, [appendEvent, setStatusMessage, tabTitle]);

  const toggleOutputRecording = useCallback(() => {
    setLoggingActive((active) => {
      if (active) {
        flushRecordedOutput("Stopped output recording and saved file");
        return false;
      }
      outputLogRef.current = "";
      appendEvent("log", "Started output recording");
      setStatusMessage("Recording terminal output");
      return true;
    });
    focusTerminal();
  }, [appendEvent, flushRecordedOutput, focusTerminal, setStatusMessage]);

  const toggleMacroRecording = useCallback(() => {
    setMacroRecording((active) => {
      if (active) {
        lastMacroRef.current = macroBufferRef.current;
        appendEvent("macro", `Recorded ${lastMacroRef.current.length} input character${lastMacroRef.current.length === 1 ? "" : "s"}`);
        setStatusMessage(lastMacroRef.current ? "Macro recorded" : "Macro recording was empty");
        return false;
      }
      macroBufferRef.current = "";
      appendEvent("macro", "Started macro recording");
      setStatusMessage("Recording terminal macro");
      return true;
    });
    focusTerminal();
  }, [appendEvent, focusTerminal, setStatusMessage]);

  const executeMacro = useCallback(() => {
    const macro = lastMacroRef.current;
    if (!macro) {
      setStatusMessage("No macro recorded");
      return;
    }
    macroPlaybackRef.current = true;
    writeInput(macro);
    macroPlaybackRef.current = false;
    appendEvent("macro", `Executed macro (${macro.length} input character${macro.length === 1 ? "" : "s"})`);
    focusTerminal();
  }, [appendEvent, focusTerminal, setStatusMessage, writeInput]);
  return { saveBufferToFile, executeMacro, toggleMacroRecording, toggleOutputRecording, flushRecordedOutput };
}
