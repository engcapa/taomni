import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchPanel } from "./SearchPanel";
import type { ContextPorts, TaoChatController, TaoSearchResult } from "../ai-chat";

vi.mock("../../../lib/runtime", () => ({ isTauriRuntime: () => false }));

const SAMPLE: TaoSearchResult[] = [
  {
    id: "r1",
    title: "Production DB Query",
    body: "SELECT * FROM audit_events",
    source: "sql",
    ref: "sql:audit",
    ts: 1700000000,
    useCount: 3,
  },
  {
    id: "r2",
    title: "Release Checklist",
    body: "Verify UI contracts before push",
    source: "note",
    ref: "note:checklist",
    ts: 1700000100,
    useCount: 1,
  },
];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Tao SearchPanel", () => {
  it("opens as a top-layer dialog, cites results with Enter, guards IME, and restores opener focus on Escape", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();

    const setChips = vi.fn();
    const setComposerText = vi.fn();
    const onClose = vi.fn();
    const controller = {
      getState: () => ({ composer: { chips: [] } }),
      setChips,
      setComposerText,
    } as unknown as TaoChatController;
    const contextPorts: ContextPorts = {
      search: vi.fn(async () => SAMPLE),
    };

    const view = render(<SearchPanel controller={controller} contextPorts={contextPorts} onClose={onClose} />);
    const dialog = screen.getByTestId("tao-home-search-panel");
    expect(dialog.tagName).toBe("DIALOG");
    const input = screen.getByTestId("tao-home-search-input");
    expect(input).toHaveFocus();

    await act(async () => {
      vi.advanceTimersByTime(150);
      await Promise.resolve();
    });
    expect(screen.getByText("Production DB Query")).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Escape", isComposing: true });
    expect(setChips).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(setChips).toHaveBeenCalledWith([
      expect.objectContaining({ id: "local-r2", label: "Release Checklist", source: "notes" }),
    ]);
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
    view.unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });
});
