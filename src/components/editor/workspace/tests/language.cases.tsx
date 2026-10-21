import type { WorkspaceTestFixture } from "../../tests/codeWorkspaceTab/harness";
import { registerlanguageCompletion3Cases } from "./tests/language/completion3.cases";
import { registerlanguageCompletion4Cases } from "./tests/language/completion4.cases";
import { registerlanguageEditing2Cases } from "./tests/language/editing2.cases";
import { registerlanguageLifecycle1Cases } from "./tests/language/lifecycle1.cases";

export type registerLanguageCasesFixture = Pick<WorkspaceTestFixture, "workspaceMocks" | "entry" | "file" | "lspMocks" | "csharpStatus" | "documentStatus" | "renderWorkspace" | "settingsNavigationMocks" | "writeAck" | "defaultCapabilities" | "toolbarControl" | "runtimeState" | "dapMocks">;

export function registerLanguageCases(workspaceTestHarness: registerLanguageCasesFixture) {
  registerlanguageLifecycle1Cases({
    get workspaceTestHarness() { return workspaceTestHarness; },
  });
  registerlanguageEditing2Cases({
    get workspaceTestHarness() { return workspaceTestHarness; },
  });
  registerlanguageCompletion3Cases({
    get workspaceTestHarness() { return workspaceTestHarness; },
  });
  registerlanguageCompletion4Cases({
    get workspaceTestHarness() { return workspaceTestHarness; },
  });
}
