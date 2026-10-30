import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceActionContext } from "../workspaceActionRegistry";
import { useWorkspaceActionProjection } from "../hooks/useWorkspaceActionProjection";
import { useWorkspaceActionsController, type WorkspaceActionsController } from "../useWorkspaceActionsController";
import type { WorkspaceCommand, WorkspaceCommandRegistration } from "../workspaceCommands";
import { WorkspaceCommandPublication } from "./WorkspaceCommandPublication";

afterEach(cleanup);

function Menu({ owner }: { owner: WorkspaceActionsController }) {
  const { snapshot } = useWorkspaceActionProjection(owner.projection);
  return <output>{snapshot[0]?.title}:{snapshot[0]?.state.availability}</output>;
}

describe("workspace action publication revisions", () => {
  it("shares one evaluation per command/context revision across mounted surfaces", () => {
    const firstWhen = vi.fn((context: WorkspaceActionContext) => !!context.hasActiveFile);
    const replacementWhen = vi.fn((context: WorkspaceActionContext) => !!context.hasActiveFile);
    const first: WorkspaceCommand[] = [{ id: "revision.probe", title: "First", category: "Edit", when: firstWhen, run: vi.fn() }];
    const replacement: WorkspaceCommand[] = [{ ...first[0], title: "Replacement", when: replacementWhen }];
    let registration: WorkspaceCommandRegistration | null = null;
    const publish = (_id: string, value: WorkspaceCommandRegistration | null) => { registration = value; };
    function Owner({ commands, hasFile }: { commands: WorkspaceCommand[]; hasFile: boolean }) {
      const controller = useWorkspaceActionsController({ commands, contextData: { hasActiveFile: hasFile } });
      return <>
        <WorkspaceCommandPublication tabId="revision" projection={controller.projection} shellShortcutClaims={[]} onCommandsChange={publish} />
        <Menu owner={controller} />
      </>;
    }
    const view = render(<Owner commands={first} hasFile={false} />);
    expect(screen.getByText("First:disabled")).toBeInTheDocument();
    expect(registration!.items[0].enabled).toBe(false);
    expect(firstWhen).toHaveBeenCalledOnce();
    const disabled = registration!.snapshot![0];

    firstWhen.mockClear();
    view.rerender(<Owner commands={first} hasFile />);
    expect(screen.getByText("First:available")).toBeInTheDocument();
    expect(registration!.items[0].enabled).toBe(true);
    expect(firstWhen).toHaveBeenCalledOnce();
    expect(disabled.state.availability).toBe("disabled");

    view.rerender(<Owner commands={replacement} hasFile={false} />);
    expect(screen.getByText("Replacement:disabled")).toBeInTheDocument();
    expect(registration!.items[0]).toMatchObject({ title: "Replacement", enabled: false });
    expect(replacementWhen).toHaveBeenCalledOnce();
  });

  it("refreshes live context publications even when the owner revision has not changed", async () => {
    let liveContext = { hasSelection: false, readOnly: false, editorComposing: false };
    const getContextData = () => liveContext;
    let notifyContext: (() => void) | undefined;
    const subscribeContextChanges = (listener: () => void) => {
      notifyContext = listener;
      return () => { notifyContext = undefined; };
    };
    const run = vi.fn();
    const commands: WorkspaceCommand[] = [{
      id: "live.probe", title: "Live", category: "Edit",
      when: (context) => !!context.hasSelection && !context.readOnly && !context.editorComposing,
      run,
    }];
    let controller: WorkspaceActionsController;
    function Owner() {
      controller = useWorkspaceActionsController({ commands, getContextData, subscribeContextChanges });
      return <Menu owner={controller} />;
    }
    const view = render(<Owner />);
    const disabled = controller!.snapshot[0];
    expect(screen.getByText("Live:disabled")).toBeInTheDocument();
    liveContext = { ...liveContext, hasSelection: true };
    act(() => notifyContext!());
    expect(screen.getByText("Live:available")).toBeInTheDocument();
    await act(async () => { await controller!.host.executePrepared(disabled.evaluation); });
    expect(run).not.toHaveBeenCalled();

    for (const flags of [{ readOnly: true, editorComposing: false }, { readOnly: false, editorComposing: true }]) {
      liveContext = { ...liveContext, ...flags };
      act(() => notifyContext!());
      expect(screen.getByText("Live:disabled")).toBeInTheDocument();
    }
    view.unmount();
    expect(notifyContext).toBeUndefined();
  });
});
