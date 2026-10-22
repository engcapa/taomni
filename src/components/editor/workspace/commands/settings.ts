import { type WorkspaceCommand } from "../workspaceCommands";
import { type WorkspaceCommandsContext } from "./types";


export type SettingsCommandsContext=Pick<WorkspaceCommandsContext,"setKeymapSettingsOpen"|"setFileTemplateSettingsOpen"|"setAutoImportSettingsOpen"|"openSearchEverywhere"|"setKeymapCheatSheetOpen">;

export function createSettingsCommands(controllerContext: SettingsCommandsContext): Record<string,WorkspaceCommand> {
  return {
    "workspace.keymapSettings": {
      id: "workspace.keymapSettings",
      title: "Keymap Settings",
      category: "Help",
      keywords: ["keymap","shortcut","scheme","keybinding"],
      run: () => {
        controllerContext.setKeymapSettingsOpen(true);
        return true;
      },
    },
    "workspace.fileTemplateSettings": {
      id: "workspace.fileTemplateSettings",
      title: "File and Code Template Settings",
      category: "Preferences",
      keywords: ["file templates","code templates","java template","class template"],
      run: () => {
        controllerContext.setFileTemplateSettingsOpen(true);
        return true;
      },
    },
    "workspace.autoImportSettings": {
      id: "workspace.autoImportSettings",
      title: "Auto Import Settings",
      category: "Preferences",
      keywords: ["auto import","imports","on the fly","paste import"],
      run: () => {
        controllerContext.setAutoImportSettingsOpen(true);
        return true;
      },
    },
    "workspace.findAction": {
      id: "workspace.findAction",
      title: "Find Action…",
      category: "Help",
      keybinding: "Ctrl+Shift+A",
      platformKeybindings: { mac: ["Meta+Shift+A","Ctrl+Shift+A"] },
      keywords: ["actions","command","palette","find action","assign shortcut"],
      // The terminal owns its keys; a modal owns its own keyboard state.
      when: (context) => context.focus!=="terminal"&&context.focus!=="modal",
      run: () => controllerContext.openSearchEverywhere("actions"),
    },
    "workspace.openKeymapCheatsheet": {
      id: "workspace.openKeymapCheatsheet",
      title: "Keyboard Shortcuts (Keymap)",
      category: "Help",
      keybinding: "Ctrl+Alt+/",
      keybindings: ["Meta+Alt+/","Meta+K Meta+S"],
      keywords: ["keymap","shortcuts","hotkeys","cheat sheet","intellij"],
      run: () => controllerContext.setKeymapCheatSheetOpen(true),
    }
  };
}
