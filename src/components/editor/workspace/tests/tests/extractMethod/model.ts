import type { CodeWorkspaceTabInfo } from "../../../../../../types";
import type { WorkspaceCommandRegistration } from "../../../workspaceCommands";


export interface ExtractFixture {
      disk: Record<string, string>;
      workspace: CodeWorkspaceTabInfo;
      registrationRef: { current: WorkspaceCommandRegistration | null };
      onCommandsChange: (tabId: string, next: WorkspaceCommandRegistration | null) => void;
      text: () => string;
    }

export type ExtractMode =
      | "normal" | "multi" | "multi-mixed" | "none" | "disabled" | "command-only" | "malformed"
      | "timeout" | "changed" | "boom" | "resolve-error" | "symbols-error"
      | "symbols-ambiguous" | "rename-error" | "multi-file" | "rename-multi-file";
