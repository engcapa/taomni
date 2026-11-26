import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { setLocale } from "../lib/i18n";
import { useUpdateStore } from "../stores/updateStore";
import { AboutDialog } from "./AboutDialog";

afterEach(cleanup);

it("names the dialog, gives Close initial focus and leaves Escape to the input method during composition", () => {
  setLocale("en");
  const close = vi.fn();
  render(<AboutDialog onClose={close} />);
  expect(screen.getByRole("dialog", { name: "About Taomni" })).toHaveAccessibleDescription(/remote workspace/);
  const button = screen.getByRole("button", { name: "Close" });
  expect(button).toHaveFocus();
  fireEvent.keyDown(button, { key: "Escape", isComposing: true });
  expect(close).not.toHaveBeenCalled();
  fireEvent.keyDown(button, { key: "Escape" });
  expect(close).toHaveBeenCalledTimes(1);
});

it.each(["about-version", "about-check-update"])("opens one manual update check from %s", (id) => {
  const original = useUpdateStore.getState().check;
  const check = vi.fn().mockResolvedValue(undefined);
  useUpdateStore.setState({ check });
  try {
    const close = vi.fn();
    render(<AboutDialog onClose={close} />);
    fireEvent.click(screen.getByTestId(id));
    expect(close).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledExactlyOnceWith({ manual: true });
  } finally {
    useUpdateStore.setState({ check: original });
  }
});
