import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsSwitch } from "./SettingsSwitch";

afterEach(cleanup);

it("keeps keyboard focus through a pending save, rejects duplicate activation and reports a retryable error", async () => {
  const user = userEvent.setup();
  let reject!: (error: Error) => void;
  const save = vi.fn().mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail; }))
    .mockResolvedValue(undefined);
  const props = { "data-testid": "setting", label: "Local processing", description: "Use the local provider.",
    icon: null, checked: false, saving: false, onToggle: save };
  const view = render(<SettingsSwitch {...props} />);
  const toggle = screen.getByRole("switch", { name: props.label, checked: false });
  await user.tab();
  expect(toggle).toHaveFocus();
  expect(toggle).toHaveAccessibleDescription(props.description);
  await user.keyboard(" ");
  expect(toggle).toHaveAttribute("aria-busy", "true");
  await user.keyboard("{Enter}");
  expect(save).toHaveBeenCalledTimes(1);
  await act(async () => reject(new Error("Could not save settings.")));
  expect(toggle).toHaveFocus();
  expect(toggle).toHaveAttribute("aria-checked", "false");
  expect(screen.getByRole("alert")).toHaveTextContent("Could not save settings.");
  await user.keyboard("{Enter}");
  expect(save).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).toBeNull();
  view.rerender(<SettingsSwitch {...props} checked />);
  expect(screen.getByRole("switch", { name: props.label, checked: true })).toHaveFocus();
});
