import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { registerShellKeyClaim } from "../../lib/shellKeyClaims";
import { useTabOverviewStore } from "../../stores/tabOverviewStore";
import { useAppStore } from "../../stores/appStore";
import { usePlatformShortcuts } from "./usePlatformShortcuts";

function Surface() {
  usePlatformShortcuts();
  return <div data-testid="editor"><input aria-label="Editor" /></div>;
}

beforeEach(() => {
  useAppStore.setState({ activeSideTab: "workspaces" });
  useTabOverviewStore.setState({ open: false });
});
afterEach(cleanup);

it("yields Recent Locations to the focused editor and keeps overview available outside it", () => {
  const { getByTestId, getByLabelText } = render(<Surface />);
  const release = registerShellKeyClaim(getByTestId("editor"), (event) =>
    event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "e");
  try {
    fireEvent.keyDown(getByLabelText("Editor"), { ctrlKey: true, shiftKey: true, key: "E" });
    expect(useTabOverviewStore.getState().open).toBe(false);
    fireEvent.keyDown(document.body, { ctrlKey: true, shiftKey: true, key: "E" });
    expect(useTabOverviewStore.getState().open).toBe(true);
  } finally {
    release();
  }
});

it("opens once per press when an IME forwards the first keydown as a repeat", () => {
  render(<Surface />);
  const chord = { ctrlKey: true, shiftKey: true, key: "E", code: "KeyE", repeat: true };
  fireEvent.keyDown(document.body, chord);
  expect(useTabOverviewStore.getState().open).toBe(true);
  fireEvent.keyDown(document.body, chord);
  expect(useTabOverviewStore.getState().open).toBe(true);
  fireEvent.keyUp(document.body, { key: "E", code: "KeyE" });
  fireEvent.keyDown(document.body, chord);
  expect(useTabOverviewStore.getState().open).toBe(false);
});

it("does not toggle twice for duplicate keydowns and releases its press on window blur", () => {
  const { getByLabelText } = render(<Surface />);
  const chord = { ctrlKey: true, shiftKey: true, key: "E", code: "KeyE" };
  fireEvent.keyDown(document.body, chord);
  expect(useTabOverviewStore.getState().open).toBe(true);
  fireEvent.keyDown(getByLabelText("Editor"), chord);
  expect(useTabOverviewStore.getState().open).toBe(true);
  fireEvent.blur(window);
  fireEvent.keyDown(document.body, { ...chord, repeat: true });
  expect(useTabOverviewStore.getState().open).toBe(false);
});
