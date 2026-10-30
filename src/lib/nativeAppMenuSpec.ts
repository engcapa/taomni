import type { AppCommand } from "../components/menubar/commands";
import type { WorkspaceCommandMenuItem } from "../components/editor/workspace/workspaceCommands";

export type MenuActionId =
  | AppCommand
  | "import-json"
  | "import-moba"
  | "import-csv"
  | "download-csv-template"
  | "import-openssh"
  | "export-json"
  | "export-moba"
  | "export-csv"
  | "export-html"
  | `workspace-command:${string}`;

/** Predefined (OS-provided) menu item kinds we use. */
export type PredefinedKind =
  | "Separator"
  | "Services"
  | "Hide"
  | "HideOthers"
  | "ShowAll"
  | "Undo"
  | "Redo"
  | "Cut"
  | "Copy"
  | "Paste"
  | "SelectAll"
  | "Minimize"
  | "Maximize"
  | "BringAllToFront";

export type MenuNodeSpec =
  | {
      type: "item";
      id: string;
      label: string;
      action: MenuActionId;
      enabled?: boolean;
      accelerator?: string;
    }
  | {
      type: "check";
      id: string;
      label: string;
      action: MenuActionId;
      checked: boolean;
    }
  | { type: "predefined"; item: PredefinedKind; label?: string }
  | { type: "separator" }
  | {
      type: "submenu";
      id: string;
      label: string;
      items: MenuNodeSpec[];
      enabled?: boolean;
    };

export interface AppMenuSpec {
  /** Top-level submenus. On macOS the first one becomes the app menu. */
  submenus: Array<{ id: string; label: string; items: MenuNodeSpec[] }>;
}

export interface BuildAppMenuParams {
  /** Whether the active tab can be closed (mirrors `activeTabClosable`). */
  activeTabClosable: boolean;
  /** Whether any saved sessions exist (controls Export enablement). */
  hasSessions: boolean;
  /** Quick-connect toolbar visibility — shown as a checkmark. */
  quickConnectVisible: boolean;
  /** Commands contributed by the active Code Workspace tab. */
  workspaceCommands?: WorkspaceCommandMenuItem[];
  /** Translation function (defaults to the module-level `t`). */
  t?: (key: string, vars?: Record<string, string | number>) => string;
}

