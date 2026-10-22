import { type WorkspaceActionMetadata } from "../types";

export const debugActionMetadata: Record<string, WorkspaceActionMetadata> = {
  "workspace.toggleBreakpoint":

  // --- Debug ---
  {
    id: "workspace.toggleBreakpoint",
    title: "Toggle Line Breakpoint",
    description: "Toggle line breakpoint on the current cursor line",
    category: "Debug",
    keybinding: "Ctrl+F8",
    provenance: "local",
    keywords: ["breakpoint", "debug", "line"],
  },
  "workspace.viewBreakpoints":
  {
    id: "workspace.viewBreakpoints",
    title: "View Breakpoints",
    description: "Manage, filter, and edit all breakpoints in workspace",
    category: "Debug",
    keybinding: "Ctrl+Shift+F8",
    provenance: "local",
    keywords: ["breakpoint", "manage", "condition", "logpoint"],
  },
  "workspace.toggleMuteBreakpoints":
  {
    id: "workspace.toggleMuteBreakpoints",
    title: "Mute / Unmute Breakpoints",
    description: "Temporarily mute all breakpoints during debugger execution",
    category: "Debug",
    provenance: "local",
    keywords: ["mute", "breakpoints", "debug", "pause"],
  },
  "workspace.toggleTemporaryBreakpoint":
  {
    id: "workspace.toggleTemporaryBreakpoint",
    title: "Toggle Temporary Line Breakpoint",
    description: "Add a breakpoint that is removed once hit, or remove the caret line's breakpoint",
    category: "Debug",
    keybinding: "Ctrl+Alt+Shift+F8",
    provenance: "local",
    keywords: ["breakpoint", "temporary", "remove once hit"],
  },
  "workspace.toggleBreakpointEnabled":
  {
    id: "workspace.toggleBreakpointEnabled",
    title: "Toggle Breakpoint Enabled",
    description: "Enable or disable the caret line's breakpoint without removing it",
    category: "Debug",
    provenance: "local",
    keywords: ["breakpoint", "enable", "disable"],
  },
  "workspace.debug.resume":
  {
    id: "workspace.debug.resume",
    title: "Resume Program",
    description: "Continue the suspended debug session",
    category: "Debug",
    keybinding: "F9",
    provenance: "provider",
    keywords: ["debug", "resume", "continue"],
  },
  "workspace.debug.stepOver":
  {
    id: "workspace.debug.stepOver",
    title: "Step Over",
    description: "Run to the next line in the current method",
    category: "Debug",
    keybinding: "F8",
    provenance: "provider",
    keywords: ["debug", "step", "next"],
  },
  "workspace.debug.stepInto":
  {
    id: "workspace.debug.stepInto",
    title: "Step Into",
    description: "Step into the method called on the current line",
    category: "Debug",
    keybinding: "F7",
    provenance: "provider",
    keywords: ["debug", "step", "into"],
  },
  "workspace.debug.stepOut":
  {
    id: "workspace.debug.stepOut",
    title: "Step Out",
    description: "Run until the current method returns",
    category: "Debug",
    keybinding: "Shift+F8",
    provenance: "provider",
    keywords: ["debug", "step", "out"],
  },
  "workspace.debug.stop":
  {
    id: "workspace.debug.stop",
    title: "Stop",
    description: "Terminate the debug session",
    category: "Debug",
    keybinding: "Ctrl+F2",
    provenance: "provider",
    keywords: ["debug", "stop", "terminate"],
  },
  "workspace.debug.evaluateExpression":
  {
    id: "workspace.debug.evaluateExpression",
    title: "Evaluate Expression…",
    description: "Evaluate an expression in the selected stack frame",
    category: "Debug",
    keybinding: "Alt+F8",
    provenance: "provider",
    keywords: ["debug", "evaluate", "expression"],
  },
  "workspace.debug.showExecutionPoint":
  {
    id: "workspace.debug.showExecutionPoint",
    title: "Show Execution Point",
    description: "Reveal the selected frame's current line",
    category: "Debug",
    keybinding: "Alt+F10",
    provenance: "provider",
    keywords: ["debug", "execution point", "current line"],
  },
  "workspace.openDapAdapterGuide":
  {
    id: "workspace.openDapAdapterGuide",
    title: "DAP Debug Adapter Setup Guide",
    description: "View installation guides and launch configurations for debug adapters",
    category: "Debug",
    provenance: "local",
    keywords: ["dap", "debug", "adapter", "guide", "lldb", "dlv", "debugpy"],
  }
};
