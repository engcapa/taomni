import "../tests/mainLayout/harness";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { WorkspaceCommandRegistration } from "../../components/editor/workspace/workspaceCommands";
import { useMainLayoutState } from "./useMainLayoutState";

afterEach(cleanup);

it("publishes current command ownership without rendering the main shell", async () => {
  let renders = 0;
  const { result } = renderHook(() => {
    renders++;
    return useMainLayoutState({});
  });
  await act(async () => {});
  const settled = renders;
  const registration: WorkspaceCommandRegistration = {
    items: [], snapshot: [], execute: vi.fn(() => true),
    executeAction: vi.fn(async () => ({ kind: "applied" })),
  };
  act(() => result.current.handleWorkspaceCommandsChange("editor", registration));
  expect(result.current.workspaceCommandRegistrationsRef.current.editor).toBe(registration);
  expect(renders).toBe(settled);
  act(() => result.current.handleWorkspaceCommandsChange("editor", null));
  expect(result.current.workspaceCommandRegistrationsRef.current.editor).toBeUndefined();
  expect(renders).toBe(settled);
});
