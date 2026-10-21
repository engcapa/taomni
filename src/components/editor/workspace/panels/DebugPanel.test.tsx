import "./tests/debugPanel/harness";
import { cleanup } from "@testing-library/react";
import { afterEach, describe } from "vitest";
import { registerDebugPanelLifecycle1Cases } from "./tests/debugPanel/lifecycle1.cases";
import { registerDebugPanelLifecycle2Cases } from "./tests/debugPanel/lifecycle2.cases";
import { registerDebugPanelLifecycle3Cases } from "./tests/debugPanel/lifecycle3.cases";

describe("DebugPanel", () => {
  afterEach(cleanup);
  registerDebugPanelLifecycle1Cases();
  registerDebugPanelLifecycle2Cases();
  registerDebugPanelLifecycle3Cases();
});
