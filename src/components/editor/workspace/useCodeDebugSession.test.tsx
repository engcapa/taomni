import "./tests/useCodeDebugSession/harness";
import { afterEach, beforeEach, describe, vi } from "vitest";
import { dapSend, dapSendRequest, dapStartSession, dapTerminate, listenDapEvents } from "./tests/useCodeDebugSession/harness";
import { registeruseCodeDebugSessionLifecycle1Cases } from "./tests/useCodeDebugSession/lifecycle1.cases";
import { registeruseCodeDebugSessionLifecycle2Cases } from "./tests/useCodeDebugSession/lifecycle2.cases";
import { registeruseCodeDebugSessionLifecycle3Cases } from "./tests/useCodeDebugSession/lifecycle3.cases";
import { registeruseCodeDebugSessionLifecycle4Cases } from "./tests/useCodeDebugSession/lifecycle4.cases";
import { registeruseCodeDebugSessionLifecycle5Cases } from "./tests/useCodeDebugSession/lifecycle5.cases";

describe("useCodeDebugSession", () => {
  beforeEach(() => {
    window.localStorage.clear();
    dapSendRequest.mockReset().mockResolvedValue({ breakpoints: [] });
    dapSend.mockReset().mockResolvedValue(undefined);
    dapStartSession.mockReset();
    dapTerminate.mockReset().mockResolvedValue(undefined);
    listenDapEvents.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
  registeruseCodeDebugSessionLifecycle1Cases();
  registeruseCodeDebugSessionLifecycle2Cases();
  registeruseCodeDebugSessionLifecycle3Cases();
  registeruseCodeDebugSessionLifecycle4Cases();
  registeruseCodeDebugSessionLifecycle5Cases();
});
