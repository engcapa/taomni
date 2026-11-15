import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerTerminal } from "../../../lib/terminal/terminalRegistry";
import { setLocale } from "../../../lib/i18n";
import { createChatController } from "../ai-chat/controller";
import type { ChatBackend, TaoChatController } from "../ai-chat/ports";
import { BindingBar } from "./BindingBar";

function BoundBar({ controller }: { controller: TaoChatController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  return <BindingBar controller={controller} context={state.context} />;
}

const disposers: Array<() => void> = [];
afterEach(() => {
  cleanup();
  disposers.splice(0).forEach((dispose) => dispose());
  setLocale("en");
});

describe("Tao resource binding", () => {
  it("clears prior terminal excerpts on rebind, keeps other references and sends only explicitly cited content", async () => {
    setLocale("en");
    for (const [tabId, title, content] of [["term-a", "Terminal A", "old-terminal-output"], ["term-b", "Terminal B", "new-terminal-output"]]) {
      disposers.push(registerTerminal({ tabId, title, sessionId: tabId, getBufferText: () => content,
        getLastLines: () => content, writeInput: () => undefined }));
    }
    const send = vi.fn<ChatBackend["send"]>(async () => []);
    const controller = createChatController({ backend: { send } });
    const unrelated = { id: "local:note", kind: "note" as const, label: "Note", preview: "keep-this-note" };
    controller.setChips([unrelated]);
    render(<BoundBar controller={controller} />);

    fireEvent.click(screen.getByTestId("tao-home-binding-terminal"));
    fireEvent.click(screen.getByRole("button", { name: "Terminal A" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(controller.getState().composer.chips).toEqual([unrelated]);
    fireEvent.click(screen.getByTestId("tao-home-binding-terminal"));
    fireEvent.click(screen.getByTestId("tao-home-binding-cite"));
    expect(controller.getState().composer.chips.at(-1)?.preview).toBe("old-terminal-output");

    fireEvent.click(screen.getByTestId("tao-home-binding-terminal"));
    fireEvent.click(screen.getByRole("button", { name: "Terminal B" }));
    expect(controller.getState().context.terminalId).toBe("term-b");
    expect(controller.getState().composer.chips).toEqual([unrelated]);
    fireEvent.click(screen.getByTestId("tao-home-binding-terminal"));
    fireEvent.click(screen.getByTestId("tao-home-binding-cite"));
    expect(controller.getState().composer.chips.at(-1)?.preview).toBe("new-terminal-output");
    await act(async () => { await controller.send("question"); });
    expect(send.mock.calls[0][0].chips.map((chip) => chip.preview)).toEqual(["keep-this-note", "new-terminal-output"]);

    fireEvent.click(screen.getByTestId("tao-home-binding-terminal"));
    fireEvent.click(screen.getByTestId("tao-home-binding-unbind"));
    expect(controller.getState().context.terminalId).toBeUndefined();
    expect(controller.getState().composer.chips).toEqual([unrelated]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("reports a closed bound resource without silently changing the reference", () => {
    const controller = createChatController();
    controller.setContext({ terminalId: "already-closed" });
    render(<BoundBar controller={controller} />);
    fireEvent.click(screen.getByTestId("tao-home-binding-terminal"));
    fireEvent.click(screen.getByTestId("tao-home-binding-cite"));
    expect(screen.getByRole("alert")).toHaveTextContent("The bound resource is closed");
    expect(controller.getState().composer.chips).toEqual([]);
  });
});
