import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ThemedSelect } from "./ThemedSelect";

function Sample() {
  const [value, setValue] = useState("light");
  return <>
    <ThemedSelect label="Preview appearance" value={value} onChange={setValue}
      options={[
        { value: "light", label: "Light" },
        { value: "auto", label: "Automatic", disabled: true },
        { value: "dark", label: "Dark" },
      ]} />
    <button type="button">Outside</button>
  </>;
}

afterEach(cleanup);

it("keeps focus on the combobox and commits the enabled keyboard option", () => {
  render(<Sample />);
  const trigger = screen.getByRole("combobox");
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const list = screen.getByRole("listbox");
  expect(trigger).toHaveAttribute("aria-controls", list.id);
  expect(screen.getByRole("option", { name: "Light" })).toHaveAttribute("aria-selected", "true");
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  expect(trigger).toHaveAttribute("aria-activedescendant", screen.getByRole("option", { name: "Dark" }).id);
  fireEvent.keyDown(trigger, { key: "Enter" });
  expect(trigger).toHaveAttribute("data-value", "dark");
  expect(trigger).toHaveFocus();
  expect(screen.queryByRole("listbox")).toBeNull();
});

it("dismisses the options without changing the value when clicked outside", () => {
  render(<Sample />);
  const trigger = screen.getByRole("combobox");
  fireEvent.click(trigger);
  fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(trigger).toHaveAttribute("data-value", "light");
});
