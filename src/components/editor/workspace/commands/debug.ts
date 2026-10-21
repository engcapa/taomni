import { type WorkspaceCommand } from "../workspaceCommands";
import { normalizeFsPath } from "../codeWorkspaceModel";
import { type WorkspaceCommandsContext } from "./types";


export type DebugCommandsContext=Pick<WorkspaceCommandsContext,"activeFile"|"cursorPositionsRef"|"activeEditorGroupId"|"editorSelectionRef"|"toggleActiveBreakpointRef"|"viewBreakpointsAtCaretRef"|"toggleTemporaryBreakpointRef"|"toggleActiveBreakpointEnabledRef"|"debugRef"|"openEvaluateDialogRef"|"showDebugExecutionPointRef"|"setStatusMessage"|"setDapGuideOpen"|"resolveEditorTarget"|"absolutePathForOpenFile"|"setBottomDockTab"|"setBottomDockOpen">;

export function createDebugCommands(controllerContext: DebugCommandsContext): Record<string,WorkspaceCommand> {
  return {
    "workspace.toggleBreakpoint": {
      id: "workspace.toggleBreakpoint",
      title: "Toggle Line Breakpoint",
      category: "Debug",
      keybinding: "Ctrl+F8",
      keybindings: ["Mod-F8"],
      keywords: ["breakpoint","toggle breakpoint","debug"],
      when: () => !!controllerContext.activeFile&&!controllerContext.activeFile.library,
      run: () => {
        const cursor=controllerContext.cursorPositionsRef.current[controllerContext.activeEditorGroupId];
        const line=(cursor?.line??controllerContext.editorSelectionRef.current.start.line)+1;
        controllerContext.toggleActiveBreakpointRef.current(line);
      },
    },
    "workspace.viewBreakpoints": {
      id: "workspace.viewBreakpoints",
      title: "View Breakpoints",
      category: "Debug",
      keybinding: "Ctrl+Shift+F8",
      keybindings: ["Mod-Shift-F8"],
      keywords: ["breakpoint","manage breakpoints","condition","log","debug"],
      run: () => {
        const cursor=controllerContext.cursorPositionsRef.current[controllerContext.activeEditorGroupId];
        const line=(cursor?.line??controllerContext.editorSelectionRef.current.start.line)+1;
        controllerContext.viewBreakpointsAtCaretRef.current(line);
      },
    },
    "workspace.toggleTemporaryBreakpoint": {
      id: "workspace.toggleTemporaryBreakpoint",
      title: "Toggle Temporary Line Breakpoint",
      category: "Debug",
      keybinding: "Ctrl+Alt+Shift+F8",
      keywords: ["breakpoint","temporary","remove once hit","debug"],
      when: () => !!controllerContext.activeFile&&!controllerContext.activeFile.library,
      run: () => {
        const cursor=controllerContext.cursorPositionsRef.current[controllerContext.activeEditorGroupId];
        const line=(cursor?.line??controllerContext.editorSelectionRef.current.start.line)+1;
        controllerContext.toggleTemporaryBreakpointRef.current(line);
      },
    },
    "workspace.toggleBreakpointEnabled": {
      id: "workspace.toggleBreakpointEnabled",
      title: "Toggle Breakpoint Enabled",
      category: "Debug",
      keywords: ["breakpoint","enable","disable","debug"],
      when: () => !!controllerContext.activeFile&&!controllerContext.activeFile.library,
      run: () => {
        const cursor=controllerContext.cursorPositionsRef.current[controllerContext.activeEditorGroupId];
        const line=(cursor?.line??controllerContext.editorSelectionRef.current.start.line)+1;
        controllerContext.toggleActiveBreakpointEnabledRef.current(line);
      },
    },
    "workspace.debug.resume": {
      id: "workspace.debug.resume",
      title: "Resume Program",
      category: "Debug",
      keybinding: "F9",
      keywords: ["debug","resume","continue"],
      when: (context) => context.focus!=="terminal"&&controllerContext.debugRef.current?.state?.status==="stopped",
      run: () => { void controllerContext.debugRef.current?.step("continue"); },
    },
    "workspace.debug.stepOver": {
      id: "workspace.debug.stepOver",
      title: "Step Over",
      category: "Debug",
      keybinding: "F8",
      keywords: ["debug","step","next"],
      when: (context) => context.focus!=="terminal"&&controllerContext.debugRef.current?.state?.status==="stopped",
      run: () => { void controllerContext.debugRef.current?.step("stepOver"); },
    },
    "workspace.debug.stepInto": {
      id: "workspace.debug.stepInto",
      title: "Step Into",
      category: "Debug",
      keybinding: "F7",
      keywords: ["debug","step","into"],
      when: (context) => context.focus!=="terminal"&&controllerContext.debugRef.current?.state?.status==="stopped",
      run: () => { void controllerContext.debugRef.current?.step("stepIn"); },
    },
    "workspace.debug.stepOut": {
      id: "workspace.debug.stepOut",
      title: "Step Out",
      category: "Debug",
      keybinding: "Shift+F8",
      keywords: ["debug","step","out","return"],
      when: (context) => context.focus!=="terminal"&&controllerContext.debugRef.current?.state?.status==="stopped",
      run: () => { void controllerContext.debugRef.current?.step("stepOut"); },
    },
    "workspace.debug.stop": {
      id: "workspace.debug.stop",
      title: "Stop",
      category: "Debug",
      keybinding: "Ctrl+F2",
      keywords: ["debug","stop","terminate"],
      when: (context) => {
        const status=controllerContext.debugRef.current?.state?.status;
        return context.focus!=="terminal"&&!!status&&status!=="terminated";
      },
      run: () => controllerContext.debugRef.current?.terminate(),
    },
    "workspace.debug.evaluateExpression": {
      id: "workspace.debug.evaluateExpression",
      title: "Evaluate Expression…",
      category: "Debug",
      keybinding: "Alt+F8",
      keywords: ["debug","evaluate","expression","inspect"],
      when: (context) => context.focus!=="terminal"&&controllerContext.debugRef.current?.state?.status==="stopped",
      run: () => controllerContext.openEvaluateDialogRef.current(),
    },
    "workspace.debug.showExecutionPoint": {
      id: "workspace.debug.showExecutionPoint",
      title: "Show Execution Point",
      category: "Debug",
      keybinding: "Alt+F10",
      keywords: ["debug","execution point","current line"],
      when: () => controllerContext.debugRef.current?.state?.status==="stopped",
      run: () => controllerContext.showDebugExecutionPointRef.current(),
    },
    "workspace.toggleMuteBreakpoints": {
      id: "workspace.toggleMuteBreakpoints",
      title: "Mute / Unmute Breakpoints",
      category: "Debug",
      keywords: ["debug","breakpoint","mute","disable","pause"],
      run: () => {
        const debugSession=controllerContext.debugRef.current;
        if(!debugSession) return;
        const next=!debugSession.breakpointsMuted;
        debugSession.setBreakpointsMuted(next);
        controllerContext.setStatusMessage(next? "Breakpoints muted":"Breakpoints unmuted");
      },
    },
    "workspace.openDapAdapterGuide": {
      id: "workspace.openDapAdapterGuide",
      title: "DAP Debug Adapter Setup Guide",
      category: "Debug",
      keywords: ["dap","debugpy","delve","lldb","gdb","js-debug","adapter","guide","setup"],
      run: () => controllerContext.setDapGuideOpen(true),
    },
    "workspace.runToCursor": {
      id: "workspace.runToCursor",
      title: "Run to Cursor",
      category: "Debug",
      keybinding: "Alt+F9",
      // IDEA "Default for XWin" moves Run to Cursor off the window-manager key.
      platformKeybindings: { linux: ["Shift+Alt+9"] },
      keywords: ["debug","run","cursor","break"],
      when: (context) => {
        if(context.focus==="tree"||context.focus==="terminal") return false;
        const session=controllerContext.debugRef.current;
        return !!session?.state&&session.state.status==="stopped";
      },
      run: (context) => {
        const session=controllerContext.debugRef.current;
        const target=controllerContext.resolveEditorTarget(context);
        const absolute=target.file? controllerContext.absolutePathForOpenFile(target.file):null;
        if(!session?.state||!target.file||!absolute||!target.position) return;
        session.runToCursor(normalizeFsPath(absolute),target.position.line+1);
      },
    },
    "workspace.addDataBreakpoint": {
      id: "workspace.addDataBreakpoint",
      title: "Add Data Breakpoint",
      category: "Debug",
      keywords: ["debug","breakpoint","field","watch","data"],
      when: (context) => {
        if(context.focus==="tree"||context.focus==="terminal") return false;
        const session=controllerContext.debugRef.current;
        return !!session?.state
          &&session.state.status==="stopped"
          &&session.capabilities.supportsDataBreakpoints===true;
      },
      run: (context) => {
        const payload=context.payload as { name?: string; frameId?: number; }|undefined;
        const name=typeof payload?.name==="string"? payload.name:null;
        const session=controllerContext.debugRef.current;
        if(!name||!session) return;
        const frameId=payload?.frameId
          ??session.state?.selectedFrameId
          ??session.state?.frames[0]?.id
          ??undefined;
        void session.addDataBreakpoint({ name,frameId }).then((result) => {
          controllerContext.setStatusMessage(result.message);
          if(result.added) {
            controllerContext.setBottomDockTab("debug");
            controllerContext.setBottomDockOpen(true);
          }
        });
      },
    }
  };
}
