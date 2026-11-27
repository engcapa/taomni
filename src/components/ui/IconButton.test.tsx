import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { setLocale } from "../../lib/i18n";
import { IconButton } from "./IconButton";

afterEach(() => { cleanup(); setLocale("en"); });

it("updates the accessible name and pointer hint together when the interface language changes", () => {
  setLocale("en");
  const click = vi.fn();
  render(<IconButton labelKey="deleteDraft" onClick={click}><svg aria-hidden="true" /></IconButton>);
  const button = screen.getByRole("button", { name: "Delete draft" });
  expect(button).toHaveAttribute("data-taomni-tooltip", "Delete draft");
  act(() => setLocale("zh-CN"));
  expect(screen.getByRole("button", { name: "删除草稿" })).toBe(button);
  expect(button).toHaveAttribute("data-taomni-tooltip", "删除草稿");
  fireEvent.click(button);
  expect(click).toHaveBeenCalledTimes(1);
});
