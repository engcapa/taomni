import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceActionsController, type WorkspaceActionsController } from "../useWorkspaceActionsController";
import { useWorkspaceActionProjection } from "../hooks/useWorkspaceActionProjection";
import type { WorkspaceCommand, WorkspaceCommandRegistration } from "../workspaceCommands";
import { WorkspaceCommandPublication } from "./WorkspaceCommandPublication";

afterEach(cleanup);

describe("workspace command surfaces", () => {
  it("updates shell and action menus without an extra editor render and retains the rendered evaluation", async () => {
    const renders = vi.fn();
    const run = vi.fn();
    const publish = vi.fn();
    let controller: WorkspaceActionsController;
    let registration: WorkspaceCommandRegistration | null = null;
    const commands = (title: string): WorkspaceCommand[] => [{
      id: "workspace.surface", category: "Edit", title,
      when: (context) => context.hasActiveFile === true, run,
    }];
    const onCommandsChange = (_id: string, value: WorkspaceCommandRegistration | null) => { registration = value; publish(value); };
    function Menu({ owner }: { owner: WorkspaceActionsController }) {
      const { snapshot } = useWorkspaceActionProjection(owner.projection);
      const entry = snapshot[0];
      return entry ? <button onClick={() => void owner.host.executePrepared(entry.evaluation)}>{entry.title}:{entry.state.availability}</button> : null;
    }
    function Owner({ definitions, hasFile }: { definitions: WorkspaceCommand[]; hasFile: boolean }) {
      renders();
      controller = useWorkspaceActionsController({ commands: definitions, contextData: { hasActiveFile: hasFile } });
      return <>
        <WorkspaceCommandPublication tabId="one" projection={controller.projection} shellShortcutClaims={[]} onCommandsChange={onCommandsChange} />
        <Menu owner={controller} />
      </>;
    }
    const first = commands("First");
    const rendered = render(<Owner definitions={first} hasFile={false} />);
    expect(screen.getByText("First:disabled")).toBeInTheDocument();
    expect(renders).toHaveBeenCalledOnce();
    const disabled = registration!.snapshot![0];
    renders.mockClear();
    rendered.rerender(<Owner definitions={first} hasFile />);
    expect(screen.getByText("First:available")).toBeInTheDocument();
    expect(renders).toHaveBeenCalledOnce();
    expect(disabled.state.availability).toBe("disabled");
    await act(async () => { await controller!.host.executePrepared(disabled.evaluation); });
    expect(run).not.toHaveBeenCalled();
    const available = registration!.snapshot![0];
    rendered.rerender(<Owner definitions={commands("Replacement")} hasFile />);
    expect(screen.getByText("Replacement:available")).toBeInTheDocument();
    await act(async () => { await controller!.host.executePrepared(available.evaluation); });
    expect(run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Replacement:available"));
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(registration!.items[0]).toMatchObject({ title: "Replacement", enabled: true });
    rendered.unmount();
    expect(publish).toHaveBeenLastCalledWith(null);
    expect(controller!.host.isDisposed()).toBe(true);
  });

  it("publishes the live host after StrictMode cleanup and workspace replacement", async () => {
    const run = vi.fn();
    const commands: WorkspaceCommand[] = [{ id: "workspace.strict", title: "Strict", category: "Edit", run }];
    let registration: WorkspaceCommandRegistration | null = null;
    let controller: WorkspaceActionsController;
    const publish = (_id: string, value: WorkspaceCommandRegistration | null) => { registration = value; };
    function Owner({ id }: { id: string }) {
      controller = useWorkspaceActionsController({ workspaceId: id, commands });
      return <WorkspaceCommandPublication tabId={id} projection={controller.projection} shellShortcutClaims={[]} onCommandsChange={publish} />;
    }
    const rendered = render(<StrictMode><Owner id="first" /></StrictMode>);
    await waitFor(() => expect(registration?.items[0]?.id).toBe("workspace.strict"));
    const previous = controller!.host;
    rendered.rerender(<StrictMode><Owner id="second" /></StrictMode>);
    await waitFor(() => expect(controller!.host.getWorkspaceId()).toBe("second"));
    expect(previous.isDisposed()).toBe(true);
    act(() => expect(registration!.execute("workspace.strict")).toBe(true));
    expect(run).toHaveBeenCalledOnce();
    expect(controller!.host.isDisposed()).toBe(false);
    rendered.unmount();
    expect(registration).toBeNull();
  });
});
