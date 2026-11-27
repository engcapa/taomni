import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Button } from "./Button";
import { usePendingAction } from "./usePendingAction";

afterEach(cleanup);

it("keeps one pending submission for keyboard and pointer activation, then permits retry", async () => {
  let finish!: () => void;
  const save = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  function Form() {
    const action = usePendingAction(save);
    return <form onSubmit={(event) => { event.preventDefault(); void action.run(); }}>
      <Button type="submit" busy={action.busy} variant="primary">Save</Button>
    </form>;
  }
  render(<Form />);
  const button = screen.getByRole("button", { name: "Save" });
  fireEvent.click(button);
  fireEvent.submit(button.closest("form")!);
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute("aria-busy", "true");
  expect(save).toHaveBeenCalledTimes(1);
  await act(async () => finish());
  expect(button).toBeEnabled();
  fireEvent.click(button);
  expect(save).toHaveBeenCalledTimes(2);
  await act(async () => finish());
});

it("defaults to a non-submitting native button", () => {
  const submit = vi.fn();
  render(<form onSubmit={submit}><Button>Cancel</Button></form>);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(submit).not.toHaveBeenCalled();
});
