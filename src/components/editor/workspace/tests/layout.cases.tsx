import type { WorkspaceTestFixture } from "../../tests/codeWorkspaceTab/harness";
import { registerlayoutHistory1Cases } from "./tests/layout/history1.cases";
import { registerlayoutLayout4Cases } from "./tests/layout/layout4.cases";
import { registerlayoutLifecycle2Cases } from "./tests/layout/lifecycle2.cases";
import { registerlayoutLifecycle3Cases } from "./tests/layout/lifecycle3.cases";
import { registerLayoutRenderingCases } from "./tests/layout/rendering.cases";

export type registerLayoutCasesFixture = Pick<WorkspaceTestFixture, "workspaceMocks" | "entry" | "file" | "renderWorkspace" | "lspMocks" | "csharpStatus" | "documentStatus" | "toolbarControl">;

export function registerLayoutCases(workspaceTestHarness: registerLayoutCasesFixture) {
  registerLayoutRenderingCases(workspaceTestHarness);
  registerlayoutHistory1Cases({
    get workspaceTestHarness() { return workspaceTestHarness; },
  });
  registerlayoutLifecycle2Cases({
    get workspaceTestHarness() { return workspaceTestHarness; },
  });
  registerlayoutLifecycle3Cases({
    get workspaceTestHarness() { return workspaceTestHarness; },
  });
  registerlayoutLayout4Cases({
    get workspaceTestHarness() { return workspaceTestHarness; },
  });
}
