import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../../stores/appStore";
import { useChatStore } from "../../../stores/chatStore";
import { useNotesStore } from "../../../stores/notesStore";
import { useTaoAlertStore } from "../../../stores/taoAlertStore";
import { ChatDrawerRibbon } from "./ribbon";

const originalApp = useAppStore.getState();
const originalChat = useChatStore.getState();
const originalNotes = useNotesStore.getState();
const originalAlerts = useTaoAlertStore.getState();

beforeEach(() => {
  vi.useFakeTimers();
  useAppStore.setState({ tabs: [{ id: "home", type: "welcome", title: "Home", closable: false }], activeTabId: "home" });
  useChatStore.setState({ drawerOpen: false, drawerPosition: "right", drawerPinned: false });
  useNotesStore.setState({ alerts: [] });
  useTaoAlertStore.setState({ aiDone: [], mailNew: [], history: [] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useAppStore.setState(originalApp, true);
  useChatStore.setState(originalChat, true);
  useNotesStore.setState(originalNotes, true);
  useTaoAlertStore.setState(originalAlerts, true);
});

describe("Tao ribbon delayed opening", () => {
  it("preserves a coding handoff opened while a hover is pending", () => {
    const openTabChat = vi.fn().mockResolvedValue(undefined);
    useChatStore.setState({ openTabChat });
    render(<ChatDrawerRibbon />);
    fireEvent.mouseEnter(screen.getByTestId("ai-chat-drawer-ribbon"));
    act(() => useChatStore.setState({ drawerOpen: true, activeThreadId: "coding-handoff" }));
    act(() => vi.advanceTimersByTime(1000));
    expect(openTabChat).not.toHaveBeenCalled();
    expect(useChatStore.getState().activeThreadId).toBe("coding-handoff");
  });

  it("does not reopen the previous tab after the user changes workspaces", () => {
    const openTabChat = vi.fn().mockResolvedValue(undefined);
    useChatStore.setState({ openTabChat });
    render(<ChatDrawerRibbon />);
    fireEvent.mouseEnter(screen.getByTestId("ai-chat-drawer-ribbon"));
    act(() => useAppStore.setState({ tabs: [{ id: "other", type: "terminal", title: "Other", closable: true }], activeTabId: "other" }));
    act(() => vi.advanceTimersByTime(1000));
    expect(openTabChat).not.toHaveBeenCalled();
  });

  it("still opens the current tab on an uninterrupted hover", () => {
    const openTabChat = vi.fn().mockResolvedValue(undefined);
    useChatStore.setState({ openTabChat });
    render(<ChatDrawerRibbon />);
    fireEvent.mouseEnter(screen.getByTestId("ai-chat-drawer-ribbon"));
    act(() => vi.advanceTimersByTime(1000));
    expect(openTabChat).toHaveBeenCalledExactlyOnceWith("home");
  });
});
